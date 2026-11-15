import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { StatusLeakClient } from '../src/client';

// A fake third-party API (on 127.0.0.1) and a fake StatusLeak ingest endpoint
// (on "localhost", so the SDK's "never record calls to StatusLeak" rule is exercised).

let api: http.Server;
let apiUrl: string;
let ingest: http.Server;
let ingestUrl: string;
let refusal: { status: number; body: Record<string, unknown> } | null = null;
let batches: any[] = [];
// What GET /v1/sdk/config answers, and how often it was asked.
let config: { status: number; hosts: string[] } = { status: 200, hosts: [] };
let configRequests = 0;
let client: StatusLeakClient;

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}

beforeAll(async () => {
    api = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            const url = req.url ?? '/';
            if (url.startsWith('/v1/chat/completions')) {
                json(res, 200, {
                    id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'm',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
                }, { 'x-ratelimit-remaining-requests': '42' });
                return;
            }
            if (url.startsWith('/v1/customers/')) {
                json(res, 200, { id: url.split('/')[3], object: 'customer' });
                return;
            }
            if (url.startsWith('/fail')) {
                json(res, 500, { error: 'boom' });
                return;
            }
            json(res, 200, { ok: true });
        });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    ingest = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            if (req.url === '/v1/sdk/config') {
                configRequests += 1;
                json(res, config.status, { hosts: config.hosts, customHosts: [] });
                return;
            }
            if (req.url === '/v1/ingest' && refusal) {
                json(res, refusal.status, refusal.body);
                return;
            }
            if (req.url === '/v1/ingest') {
                try {
                    batches.push(JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()));
                    json(res, 202, { accepted: 1 });
                } catch {
                    json(res, 400, { error: 'bad batch' });
                }
                return;
            }
            json(res, 404, {});
        });
    });
    await new Promise<void>((r) => ingest.listen(0, '127.0.0.1', r));
    ingestUrl = `http://localhost:${(ingest.address() as AddressInfo).port}`;
});

afterAll(() => {
    api.close();
    ingest.close();
});

beforeEach(() => {
    batches = [];
    refusal = null;
    config = { status: 200, hosts: [] };
    configRequests = 0;
    client = new StatusLeakClient({
        apiKey: 'sl_sdk_test', endpoint: ingestUrl, service: 'test-app', environment: 'test',
        extraHosts: ['127.0.0.1'], flushIntervalMs: 3_600_000,
    });
    client.start();
});

afterEach(async () => {
    await client.shutdown();
});

// A port nothing listens on. (Not port 1: fetch refuses "bad ports" before any network activity.)
async function closedPort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
}

async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
}

async function sentRows(): Promise<any[]> {
    await settle();
    await client.flush();
    return batches.flatMap((b) => b.rows);
}

describe('capture', () => {
    it('records fetch calls with status, timings, normalized path and rate-limit headroom', async () => {
        const res = await fetch(`${apiUrl}/v1/chat/completions?api-version=2`, { method: 'POST', body: '{}' });
        await res.json();
        const [row, ...rest] = await sentRows();
        expect(rest).toEqual([]);
        expect(row).toMatchObject({
            host: '127.0.0.1', method: 'POST', path: '/v1/chat/completions', status: 200, error: null,
            count: 1, ttfbCount: 1, rlRemainingMin: 42,
        });
        expect(row.durationSumMs).toBeGreaterThanOrEqual(row.ttfbSumMs);
        expect(batches[0]).toMatchObject({ v: 1, service: 'test-app', environment: 'test', sdk: 'node/0.1.0' });
    });

    it('records node:http calls (status, no TTFB) and replaces IDs in paths', async () => {
        await new Promise<void>((resolve) => {
            http.get(`${apiUrl}/fail/cus_NffrFeUfNV2Hib`, (res) => {
                res.resume();
                res.on('end', () => resolve());
            });
        });
        const [row] = await sentRows();
        expect(row).toMatchObject({ method: 'GET', path: '/fail/:id', status: 500, error: null, count: 1, ttfbCount: 0 });
    });

    it('records network errors from fetch and node:http', async () => {
        const port = await closedPort();
        await fetch(`http://127.0.0.1:${port}/x`).catch(() => undefined);
        await new Promise<void>((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/y`);
            req.on('error', () => resolve());
        });
        const rows = await sentRows();
        expect(rows.map((r) => [r.path, r.status, r.error]).sort()).toEqual([
            ['/x', null, 'connect'],
            // 'connect' on Node >= 22.13 (http.client.request.error); 'other' on older Node.
            ['/y', null, expect.stringMatching(/^(connect|other)$/)],
        ]);
    });

    it('ignores hosts outside the allowlist and calls to StatusLeak itself', async () => {
        // "localhost" is the ingest endpoint here and isn't allowlisted.
        await (await fetch(`${ingestUrl}/health`)).text();
        const rows = await sentRows();
        expect(rows).toEqual([]);
        expect(batches).toEqual([]);
    });

    it('never records its own endpoint even if that host is allowlisted', async () => {
        const self = new StatusLeakClient({
            apiKey: 'k', endpoint: ingestUrl, extraHosts: ['localhost'], flushIntervalMs: 3_600_000,
        });
        self.start();
        await (await fetch(`${ingestUrl}/health`)).text();
        await settle();
        await self.shutdown();
        expect(batches).toEqual([]);
    });

    it('never adds error or response listeners to node:http requests', async () => {
        const req = http.request(`${apiUrl}/plain`);
        expect(req.listenerCount('error')).toBe(0);
        expect(req.listenerCount('response')).toBe(0);
        await new Promise<void>((resolve) => {
            req.on('response', (res) => {
                res.resume();
                res.on('end', () => resolve());
            });
            req.end();
        });
    });

    it('captures calls made through the official OpenAI (fetch) and Stripe (node:http) SDKs', async () => {
        const openai = new OpenAI({ apiKey: 'sk-test', baseURL: `${apiUrl}/v1`, maxRetries: 0 });
        await openai.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'ping' }] });

        const stripe = new Stripe('sk_test_123', { host: '127.0.0.1', port: Number(new URL(apiUrl).port), protocol: 'http', maxNetworkRetries: 0 });
        await stripe.customers.retrieve('cus_NffrFeUfNV2Hib');

        const rows = await sentRows();
        expect(rows.map((r) => [r.method, r.path, r.status]).sort()).toEqual([
            ['GET', '/v1/customers/:id', 200],
            ['POST', '/v1/chat/completions', 200],
        ]);
    });
});

describe('host list refresh', () => {
    // A client whose refresh timers are short enough to watch in a test.
    function quickClient(refreshMs: number, retryMs: number): StatusLeakClient {
        const c = new StatusLeakClient({ apiKey: 'sl_sdk_test', endpoint: ingestUrl, flushIntervalMs: 3_600_000 });
        Object.assign(c as unknown as object, { configRefreshMs: refreshMs, configRetryMs: retryMs });
        return c;
    }

    function records(c: StatusLeakClient, host: string): boolean {
        return (c as unknown as { matcher: { matches(h: string): boolean } }).matcher.matches(host);
    }

    async function until(check: () => boolean): Promise<void> {
        const deadline = Date.now() + 2_000;
        while (!check() && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    it('picks up providers added while the app keeps running', async () => {
        config.hosts = ['api.first-provider.test'];
        const c = quickClient(50, 3_600_000);
        c.start();
        await until(() => records(c, 'api.first-provider.test'));
        expect(records(c, 'api.first-provider.test')).toBe(true);
        expect(records(c, 'api.added-later.test')).toBe(false);

        config.hosts = ['api.first-provider.test', 'api.added-later.test'];
        await until(() => records(c, 'api.added-later.test'));
        expect(records(c, 'api.added-later.test')).toBe(true);
        // The built-in list always stays.
        expect(records(c, 'api.openai.com')).toBe(true);
        await c.shutdown();
    });

    it('retries sooner after a failed fetch, then settles on the normal interval', async () => {
        config = { status: 503, hosts: ['api.added-later.test'] };
        const c = quickClient(3_600_000, 30);
        c.start();
        await until(() => configRequests >= 2);
        expect(configRequests).toBeGreaterThanOrEqual(2);
        expect(records(c, 'api.added-later.test')).toBe(false);

        config.status = 200;
        await until(() => records(c, 'api.added-later.test'));
        expect(records(c, 'api.added-later.test')).toBe(true);
        const after = configRequests;
        await new Promise((r) => setTimeout(r, 150));
        expect(configRequests).toBe(after);
        await c.shutdown();
    });

    it('stops refreshing after shutdown', async () => {
        const c = quickClient(30, 30);
        c.start();
        await until(() => configRequests >= 2);
        await c.shutdown();
        const after = configRequests;
        await new Promise((r) => setTimeout(r, 150));
        expect(configRequests).toBeLessThanOrEqual(after + 1);
    });
});

describe('refusals from the server', () => {
    async function sendOne(): Promise<void> {
        await fetch(`${apiUrl}/v1/customers/cus_1`);
        await settle();
        await client.flush();
    }

    it('pauses (but stays on) when the plan service limit refuses this service', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        refusal = { status: 403, body: { code: 'service_limit', error: "Your plan allows 1 service(s) per billing period; 'test-app' was not recorded." } };
        await sendOne();
        expect(warn.mock.calls[0][0]).toContain("Your plan allows 1 service(s)");
        expect(warn.mock.calls[0][0]).not.toContain('API key');
        const c = client as unknown as { disabled: boolean; pausedUntil: number };
        expect(c.disabled).toBe(false);
        expect(c.pausedUntil).toBeGreaterThan(Date.now() + 50 * 60_000);
        warn.mockRestore();
    });

    it('turns off with a clear message when the key is invalid', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        refusal = { status: 401, body: { code: 'invalid_key', error: 'Invalid or revoked API key' } };
        await sendOne();
        expect(warn.mock.calls[0][0]).toContain('invalid or was revoked');
        expect((client as unknown as { disabled: boolean }).disabled).toBe(true);
        warn.mockRestore();
    });
});

// The wire format of POST /v1/ingest. tests/fixtures/sample-batch.json is a real
// batch; the platform repo runs it through the server's validator. If the format
// changes on purpose, regenerate it with UPDATE_FIXTURES=1 npm test and sync it.
describe('wire format contract', () => {
    // Field names and value types, without the values.
    function shape(v: unknown): unknown {
        if (Array.isArray(v)) {
            if (v.length === 0) {
                return [];
            }
            return [shape(v[0])];
        }
        if (v === null) {
            return 'null';
        }
        if (typeof v === 'object') {
            return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shape(x)]));
        }
        return typeof v;
    }

    it('keeps the batch format the server accepts', async () => {
        await (await fetch(`${apiUrl}/v1/chat/completions`, { method: 'POST' })).text();
        await fetch(`http://127.0.0.1:${await closedPort()}/down`).catch(() => undefined);
        await new Promise<void>((resolve) => {
            http.get(`${apiUrl}/fail/123`, (res) => {
                res.resume();
                res.on('end', () => resolve());
            });
        });
        await sentRows();
        expect(batches).toHaveLength(1);
        const batch = batches[0];
        expect(batch.rows).toHaveLength(3);
        expect(batch.rows.every((r: { hist: number[] }) => r.hist.length === 11)).toBe(true);

        const fixture = new URL('./fixtures/sample-batch.json', import.meta.url);
        if (process.env.UPDATE_FIXTURES === '1') {
            writeFileSync(fixture, `${JSON.stringify(batch, null, 4)}\n`);
        }
        const expected = JSON.parse(readFileSync(fixture, 'utf8'));
        expect(shape(batch)).toEqual(shape(expected));
        expect(batch.rows.map((r: { status: unknown; error: unknown }) => r.status ?? r.error).sort())
            .toEqual(expected.rows.map((r: { status: unknown; error: unknown }) => r.status ?? r.error).sort());
    });
});
