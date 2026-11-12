import diagnostics from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import type { IncomingHttpHeaders } from 'node:http';
import { normalizePath } from './normalize';
import type { CallRecord, ErrorKind } from './aggregator';

// Observes outgoing HTTP calls through Node's built-in diagnostics channels —
// no monkey-patching. Two sources:
//
//   fetch / undici   undici:request:create → :headers → :trailers | :error
//   node:http(s)     http.client.request.start → http.client.response.finish
//                    (+ http.client.request.error on Node ≥ 22.13)
//
// Rules, so the SDK never changes how the app behaves:
//   - never add 'error' or 'response' listeners to a request (the first would
//     swallow errors the app expects to throw; the second stops Node from
//     discarding unread responses). The only listener added is a passive 'close'.
//   - every callback is wrapped: an SDK bug must never break a request.
//   - nothing from request/response bodies, auth headers or query strings is kept.

export interface CaptureOptions {
    shouldRecord: (host: string) => boolean;
    onCall: (call: CallRecord) => void;
    onInternalError?: (err: unknown) => void;
}

interface InFlight {
    at: number;
    start: number;
    host: string;
    method: string;
    path: string;
    status: number | null;
    ttfb: number | null;
    rateLimitRemaining: number | null;
}

// Calls whose body is never consumed never report completion; they are
// closed out (with the time to first byte as duration) after this long.
const STALE_MS = 10 * 60 * 1000;
const MAX_IN_FLIGHT = 10_000;

const RATE_LIMIT_HEADERS = [
    'x-ratelimit-remaining-requests',          // OpenAI, Groq, Mistral, …
    'anthropic-ratelimit-requests-remaining',  // Anthropic
    'x-ratelimit-remaining',                   // GitHub and many others
    'ratelimit-remaining',                     // IETF draft
];

export function classifyError(err: unknown): ErrorKind {
    const e = err as { code?: unknown; name?: unknown; cause?: unknown } | null;
    const code = String(e?.code ?? '');
    const name = String(e?.name ?? '');
    if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED') {
        return 'aborted';
    }
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
        return 'timeout';
    }
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || name === 'TimeoutError') {
        return 'timeout';
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
        return 'dns';
    }
    if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
        return 'connect';
    }
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CLOSED') {
        return 'reset';
    }
    if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code.startsWith('CERT_')
        || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
        || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
        return 'tls';
    }
    // fetch wraps network errors ("fetch failed") with the real one as `cause`.
    if (e?.cause && e.cause !== err) {
        return classifyError(e.cause);
    }
    return 'other';
}

function rateLimitFromHeaders(get: (name: string) => string | undefined): number | null {
    for (const name of RATE_LIMIT_HEADERS) {
        const v = get(name);
        if (v !== undefined) {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n >= 0) {
                return n;
            }
        }
    }
    return null;
}

// undici passes raw headers as a flat [name, value, name, value, …] array of Buffers or strings.
function undiciHeaderGetter(raw: unknown): (name: string) => string | undefined {
    const pairs = new Map<string, string>();
    if (Array.isArray(raw)) {
        for (let i = 0; i + 1 < raw.length; i += 2) {
            pairs.set(String(raw[i]).toLowerCase(), String(raw[i + 1]));
        }
    }
    return (name) => pairs.get(name);
}

function nodeHeaderGetter(headers: IncomingHttpHeaders | undefined): (name: string) => string | undefined {
    return (name) => {
        const v = headers?.[name];
        return Array.isArray(v) ? v[0] : v;
    };
}

function hostFromOrigin(origin: unknown): string | null {
    try {
        return new URL(String(origin)).hostname.toLowerCase();
    } catch {
        return null;
    }
}

export class Capture {
    private inFlight = new Map<object, InFlight>();
    private unsubscribers: (() => void)[] = [];
    private sweeper: NodeJS.Timeout | null = null;

    constructor(private readonly opts: CaptureOptions) {}

    start(): void {
        if (this.unsubscribers.length > 0) {
            return;
        }
        this.on('undici:request:create', (m) => this.undiciCreate(m));
        this.on('undici:request:headers', (m) => this.undiciHeaders(m));
        this.on('undici:request:trailers', (m) => this.finishByRequest((m as { request: object }).request, null));
        this.on('undici:request:error', (m) => this.failByRequest((m as { request: object; error: unknown }).request, (m as { error: unknown }).error));
        this.on('http.client.request.start', (m) => this.httpStart(m));
        this.on('http.client.response.finish', (m) => this.httpFinish(m));
        this.on('http.client.request.error', (m) => this.failByRequest((m as { request: object }).request, (m as { error: unknown }).error));

        this.sweeper = setInterval(() => this.sweep(), 60_000);
        this.sweeper.unref();
    }

    stop(): void {
        for (const unsubscribe of this.unsubscribers) {
            unsubscribe();
        }
        this.unsubscribers = [];
        if (this.sweeper) {
            clearInterval(this.sweeper);
            this.sweeper = null;
        }
        this.inFlight.clear();
    }

    private on(channel: string, handler: (message: unknown) => void): void {
        const listener = (message: unknown) => {
            try {
                handler(message);
            } catch (err) {
                this.opts.onInternalError?.(err);
            }
        };
        diagnostics.subscribe(channel, listener);
        this.unsubscribers.push(() => diagnostics.unsubscribe(channel, listener));
    }

    private track(request: object, host: string, method: string, rawPath: string): void {
        if (!this.opts.shouldRecord(host) || this.inFlight.size >= MAX_IN_FLIGHT) {
            return;
        }
        this.inFlight.set(request, {
            at: Date.now(),
            start: performance.now(),
            host,
            method: method.toUpperCase(),
            path: normalizePath(rawPath),
            status: null,
            ttfb: null,
            rateLimitRemaining: null,
        });
    }

    // ── fetch / undici ──────────────────────────────────────────────────────

    private undiciCreate(message: unknown): void {
        const request = (message as { request?: { origin?: unknown; method?: unknown; path?: unknown } }).request;
        if (!request) {
            return;
        }
        const host = hostFromOrigin(request.origin);
        if (host === null) {
            return;
        }
        this.track(request, host, String(request.method ?? 'GET'), String(request.path ?? '/'));
    }

    private undiciHeaders(message: unknown): void {
        const { request, response } = message as { request: object; response?: { statusCode?: number; headers?: unknown } };
        const call = this.inFlight.get(request);
        if (!call || !response) {
            return;
        }
        call.status = response.statusCode ?? null;
        call.ttfb = performance.now() - call.start;
        call.rateLimitRemaining = rateLimitFromHeaders(undiciHeaderGetter(response.headers));
    }

    // ── node:http(s) ────────────────────────────────────────────────────────

    private httpStart(message: unknown): void {
        const request = (message as { request?: { host?: unknown; method?: unknown; path?: unknown; once?: unknown } }).request;
        if (!request) {
            return;
        }
        const host = String(request.host ?? '').toLowerCase();
        if (host === '') {
            return;
        }
        this.track(request, host, String(request.method ?? 'GET'), String(request.path ?? '/'));
        if (this.inFlight.has(request) && typeof request.once === 'function') {
            // Older Node has no http.client.request.error channel: if the request
            // closes without a completion event, settle it here. Let channel
            // events that fire alongside 'close' run first.
            (request.once as (e: string, l: () => void) => void)('close', () => {
                setImmediate(() => this.settleClosed(request as object));
            });
        }
    }

    private httpFinish(message: unknown): void {
        const { request, response } = message as { request: object; response?: { statusCode?: number; headers?: IncomingHttpHeaders } };
        const call = this.inFlight.get(request);
        if (!call || !response) {
            return;
        }
        call.status = response.statusCode ?? null;
        call.rateLimitRemaining = rateLimitFromHeaders(nodeHeaderGetter(response.headers));
        // TTFB isn't observable for node:http without a 'response' listener (see top).
        this.finishByRequest(request, null);
    }

    private settleClosed(request: object): void {
        const call = this.inFlight.get(request);
        if (!call) {
            return;
        }
        // A response arrived but wasn't read to the end (or the app aborted mid-body).
        const res = (request as { res?: { statusCode?: number; headers?: IncomingHttpHeaders } }).res;
        if (res?.statusCode) {
            call.status = res.statusCode;
            call.rateLimitRemaining = rateLimitFromHeaders(nodeHeaderGetter(res.headers));
            this.finishByRequest(request, null);
            return;
        }
        this.finishByRequest(request, 'other');
    }

    // ── completion ──────────────────────────────────────────────────────────

    private failByRequest(request: object, error: unknown): void {
        const call = this.inFlight.get(request);
        if (!call) {
            return;
        }
        // An error after the headers arrived (e.g. the body stream broke) still
        // counts as a response with that status.
        if (call.status !== null) {
            this.finishByRequest(request, null);
            return;
        }
        this.finishByRequest(request, classifyError(error));
    }

    private finishByRequest(request: object, error: ErrorKind | null, durationMs?: number): void {
        const call = this.inFlight.get(request);
        if (!call) {
            return;
        }
        this.inFlight.delete(request);
        let status = call.status;
        let kind = error;
        if (status === null && kind === null) {
            kind = 'other';
        }
        if (status !== null) {
            kind = null;
        }
        if (kind !== null) {
            status = null;
        }
        this.opts.onCall({
            at: call.at,
            host: call.host,
            method: call.method,
            path: call.path,
            status,
            error: kind,
            durationMs: durationMs ?? performance.now() - call.start,
            ttfbMs: call.ttfb,
            rateLimitRemaining: call.rateLimitRemaining,
        });
    }

    // Closes out calls whose response body was never consumed.
    private sweep(): void {
        const cutoff = performance.now() - STALE_MS;
        for (const [request, call] of this.inFlight) {
            if (call.start < cutoff) {
                this.finishByRequest(request, null, call.ttfb ?? STALE_MS);
            }
        }
    }

    get pending(): number {
        return this.inFlight.size;
    }
}
