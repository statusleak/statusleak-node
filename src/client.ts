import { gzipSync } from 'node:zlib';
import { Aggregator } from './aggregator';
import type { Row } from './aggregator';
import { Capture } from './capture';
import { HostMatcher } from './hostMatcher';
import { CATALOG_HOSTS } from './hosts';
import { VERSION } from './version';

export interface StatusLeakOptions {
    // SDK API key (sl_sdk_…). Default: STATUSLEAK_API_KEY.
    apiKey?: string;
    // Which app this is, e.g. "billing-api". Default: STATUSLEAK_SERVICE or "default".
    service?: string;
    // e.g. "production", "staging". Default: STATUSLEAK_ENVIRONMENT, NODE_ENV, or "production".
    environment?: string;
    // Extra API hosts to record beyond the built-in provider list (also add them in the dashboard).
    extraHosts?: string[];
    // How often summaries are sent. Default: 15 000 ms (the server may suggest another value).
    flushIntervalMs?: number;
    // Default: STATUSLEAK_ENDPOINT or https://statusleak.com
    endpoint?: string;
    // Set false to turn the SDK off (also STATUSLEAK_DISABLED=1).
    enabled?: boolean;
    // Log SDK activity to the console (also STATUSLEAK_DEBUG=1).
    debug?: boolean;
}

const DEFAULT_ENDPOINT = 'https://statusleak.com';
const DEFAULT_FLUSH_MS = 15_000;
const MIN_FLUSH_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
// After a 429 (monthly quota reached), stop sending for a while.
const QUOTA_BACKOFF_MS = 10 * 60 * 1000;
// After the plan's service limit refused this service, check again hourly
// (an upgrade or a new billing period lifts it).
const SERVICE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;
// A failed batch is retried once (merged into the next flush), then dropped.
const MAX_ATTEMPTS = 2;
const LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

function label(value: string | undefined, fallback: string): string {
    if (value && LABEL_RE.test(value)) {
        return value;
    }
    if (value) {
        const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
        if (LABEL_RE.test(cleaned)) {
            return cleaned;
        }
    }
    return fallback;
}

function envFlag(name: string): boolean {
    const v = process.env[name];
    return v === '1' || v === 'true';
}

// The server explains refusals as { code, error }; older servers send only { error }.
async function readError(res: Response): Promise<{ code: string | null; error: string | null }> {
    try {
        const body = await res.json() as { code?: unknown; error?: unknown };
        return {
            code: typeof body.code === 'string' ? body.code : null,
            error: typeof body.error === 'string' ? body.error : null,
        };
    } catch {
        return { code: null, error: null };
    }
}

export class StatusLeakClient {
    private readonly apiKey: string;
    private readonly service: string;
    private readonly environment: string;
    private readonly endpoint: string;
    private readonly endpointHost: string;
    private readonly extraHosts: string[];
    private readonly debugEnabled: boolean;
    private flushIntervalMs: number;

    private readonly aggregator = new Aggregator();
    private readonly matcher: HostMatcher;
    private readonly capture: Capture;
    private timer: NodeJS.Timeout | null = null;
    private flushing: Promise<void> | null = null;
    private retry: { rows: Row[]; attempts: number } | null = null;
    private pausedUntil = 0;
    private disabled = false;
    private started = false;
    private badEndpoint = false;

    constructor(options: StatusLeakOptions = {}) {
        this.apiKey = options.apiKey ?? process.env.STATUSLEAK_API_KEY ?? '';
        this.service = label(options.service ?? process.env.STATUSLEAK_SERVICE, 'default');
        this.environment = label(options.environment ?? process.env.STATUSLEAK_ENVIRONMENT ?? process.env.NODE_ENV, 'production');
        this.endpoint = (options.endpoint ?? process.env.STATUSLEAK_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
        // Never throw into the app: a bad endpoint just turns the SDK off (see start()).
        let endpointHost = '';
        try {
            endpointHost = new URL(this.endpoint).hostname.toLowerCase();
        } catch {
            this.badEndpoint = true;
        }
        this.endpointHost = endpointHost;
        this.extraHosts = options.extraHosts ?? [];
        this.debugEnabled = options.debug ?? envFlag('STATUSLEAK_DEBUG');
        this.flushIntervalMs = Math.max(MIN_FLUSH_MS, options.flushIntervalMs ?? DEFAULT_FLUSH_MS);
        this.disabled = options.enabled === false || envFlag('STATUSLEAK_DISABLED');

        this.matcher = new HostMatcher([...CATALOG_HOSTS, ...this.extraHosts]);
        this.capture = new Capture({
            // Never record calls to StatusLeak itself.
            shouldRecord: (host) => host !== this.endpointHost && this.matcher.matches(host),
            onCall: (call) => this.aggregator.record(call),
            onInternalError: (err) => this.log('internal error', err),
        });
    }

    start(): void {
        if (this.started || this.disabled) {
            return;
        }
        if (!this.apiKey) {
            console.warn('[statusleak] No API key (set STATUSLEAK_API_KEY or pass apiKey); the SDK is off.');
            this.disabled = true;
            return;
        }
        if (this.badEndpoint) {
            console.warn(`[statusleak] Invalid endpoint "${this.endpoint}" (STATUSLEAK_ENDPOINT); the SDK is off.`);
            this.disabled = true;
            return;
        }
        this.started = true;
        this.capture.start();
        this.schedule();
        process.on('beforeExit', this.onBeforeExit);
        void this.loadConfig();
        this.log(`started (service=${this.service}, environment=${this.environment})`);
    }

    // Sends everything recorded so far. Call at the end of serverless handlers.
    async flush(): Promise<void> {
        if (this.flushing) {
            return this.flushing;
        }
        this.flushing = this.doFlush().finally(() => {
            this.flushing = null;
        });
        return this.flushing;
    }

    // Stops recording and sends what's left.
    async shutdown(): Promise<void> {
        if (!this.started) {
            return;
        }
        this.started = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        process.off('beforeExit', this.onBeforeExit);
        this.capture.stop();
        await this.flush();
    }

    private schedule(): void {
        this.timer = setTimeout(async () => {
            await this.flush();
            if (this.started) {
                this.schedule();
            }
        }, this.flushIntervalMs);
        // Never keep the app's process alive just for us.
        this.timer.unref();
    }

    // Runs when the event loop empties (end of scripts, many serverless runtimes).
    private onBeforeExit = (): void => {
        if (this.aggregator.size > 0 || this.retry) {
            void this.flush();
        }
    };

    private async doFlush(): Promise<void> {
        if (Date.now() < this.pausedUntil) {
            // The server would refuse it anyway; don't let it pile up in memory.
            this.aggregator.drain();
            return;
        }
        let rows = this.aggregator.drain();
        let attempts = 0;
        if (this.retry) {
            // Merge the failed batch into this one.
            const merger = new Aggregator();
            merger.requeue(this.retry.rows);
            merger.requeue(rows);
            rows = merger.drain();
            attempts = this.retry.attempts;
            this.retry = null;
        }
        if (rows.length === 0) {
            return;
        }

        const outcome = await this.send(rows);
        if (outcome === 'retry') {
            if (attempts + 1 < MAX_ATTEMPTS) {
                this.retry = { rows, attempts: attempts + 1 };
            } else {
                this.log(`dropped ${rows.length} rows after ${MAX_ATTEMPTS} failed attempts`);
            }
        }
    }

    private async send(rows: Row[]): Promise<'ok' | 'retry' | 'drop'> {
        const payload = {
            v: 1,
            sdk: `node/${VERSION}`,
            service: this.service,
            environment: this.environment,
            rows: rows.map((r) => ({ ...r, rlRemainingMin: r.rlRemainingMin ?? null })),
        };
        try {
            const res = await fetch(`${this.endpoint}/v1/ingest`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'Content-Encoding': 'gzip',
                    'User-Agent': `statusleak-node/${VERSION}`,
                },
                body: gzipSync(JSON.stringify(payload)),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (res.ok) {
                this.log(`sent ${rows.length} rows`);
                return 'ok';
            }
            if (res.status === 401 || res.status === 403 || res.status === 429) {
                const { code, error } = await readError(res);
                if (code === 'service_limit') {
                    console.warn(`[statusleak] ${error ?? 'Plan service limit reached.'} Not sending for this service; checking again in an hour.`);
                    this.pausedUntil = Date.now() + SERVICE_LIMIT_BACKOFF_MS;
                    return 'drop';
                }
                if (res.status === 429) {
                    console.warn(`[statusleak] ${error ?? 'Monthly call quota reached.'} Pausing for 10 minutes.`);
                    this.pausedUntil = Date.now() + QUOTA_BACKOFF_MS;
                    return 'drop';
                }
                let reason = 'API key rejected';
                if (code === 'invalid_key' || code === 'missing_key') {
                    reason = 'API key is invalid or was revoked';
                } else if (code === 'wrong_key_type') {
                    reason = 'this API key is not an SDK key';
                }
                console.warn(`[statusleak] ${reason} (HTTP ${res.status}); the SDK is off. Use an SDK key (sl_sdk_…) from Settings.`);
                this.disabled = true;
                void this.shutdown();
                return 'drop';
            }
            if (res.status >= 500) {
                return 'retry';
            }
            this.log(`batch rejected (HTTP ${res.status})`);
            return 'drop';
        } catch (err) {
            this.log('send failed', err);
            return 'retry';
        }
    }

    // Picks up newly added providers and the org's custom hosts without an SDK upgrade.
    private async loadConfig(): Promise<void> {
        try {
            const res = await fetch(`${this.endpoint}/v1/sdk/config`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}`, 'User-Agent': `statusleak-node/${VERSION}` },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!res.ok) {
                return;
            }
            const config = await res.json() as { hosts?: unknown; customHosts?: unknown; flushIntervalMs?: unknown };
            const hosts = [config.hosts, config.customHosts].flatMap((h) => (Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string') : []));
            if (hosts.length > 0) {
                this.matcher.set([...CATALOG_HOSTS, ...hosts, ...this.extraHosts]);
            }
            if (typeof config.flushIntervalMs === 'number' && config.flushIntervalMs >= MIN_FLUSH_MS) {
                this.flushIntervalMs = config.flushIntervalMs;
            }
        } catch (err) {
            this.log('could not load remote config; using built-in host list', err);
        }
    }

    private log(message: string, err?: unknown): void {
        if (this.debugEnabled) {
            console.log(`[statusleak] ${message}`, err ?? '');
        }
    }
}
