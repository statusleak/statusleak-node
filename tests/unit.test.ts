import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { StatusLeakClient } from '../src/client';
import { VERSION } from '../src/version';
import { normalizePath } from '../src/normalize';
import { CATALOG_HOSTS } from '../src/hosts';
import { HostMatcher } from '../src/hostMatcher';
import { Aggregator, HIST_BOUNDS_MS } from '../src/aggregator';
import type { CallRecord } from '../src/aggregator';
import { classifyError } from '../src/capture';

// Shared with the server so both normalizers stay identical.
// Shared with the server, which applies the same rules on ingest (synced from the platform repo).
const CASES = JSON.parse(readFileSync(new URL('./fixtures/normalize-cases.json', import.meta.url), 'utf-8')) as [string, string][];

describe('normalizePath (shared cases with the server)', () => {
    it.each(CASES)('%s → %s', (input, expected) => {
        expect(normalizePath(input)).toBe(expected);
    });
});

describe('built-in host list', () => {
    // Generated from the platform's provider catalog; the platform repo checks it stays in sync.
    it('is sorted, unique and made of valid host patterns', () => {
        expect(CATALOG_HOSTS.length).toBeGreaterThan(40);
        expect([...CATALOG_HOSTS]).toEqual([...new Set(CATALOG_HOSTS)].sort());
        for (const h of CATALOG_HOSTS) {
            expect(h).toMatch(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
        }
    });

    it('uses the histogram bounds the server merges on', () => {
        expect(HIST_BOUNDS_MS).toEqual([25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]);
    });
});

describe('HostMatcher', () => {
    const m = new HostMatcher(CATALOG_HOSTS);

    it('matches catalog hosts and wildcards, ignores everything else', () => {
        expect(m.matches('api.openai.com')).toBe(true);
        expect(m.matches('API.STRIPE.COM')).toBe(true);
        expect(m.matches('abcdefgh.supabase.co')).toBe(true);
        expect(m.matches('supabase.co')).toBe(false);
        expect(m.matches('internal-billing.svc.cluster.local')).toBe(false);
        expect(m.matches('localhost')).toBe(false);
    });

    it('can be replaced at runtime', () => {
        const local = new HostMatcher([]);
        expect(local.matches('api.niche.io')).toBe(false);
        local.set(['api.niche.io']);
        expect(local.matches('api.niche.io')).toBe(true);
    });
});

describe('Aggregator', () => {
    const base: CallRecord = {
        at: Date.parse('2026-11-09T12:00:30Z'), host: 'api.openai.com', method: 'POST', path: '/v1/chat/completions',
        status: 200, error: null, durationMs: 120, ttfbMs: 80, rateLimitRemaining: 500,
    };

    it('groups calls per minute and key, with histogram and lowest rate-limit headroom', () => {
        const a = new Aggregator();
        a.record(base);
        a.record({ ...base, durationMs: 700, ttfbMs: null, rateLimitRemaining: 40 });
        a.record({ ...base, status: 429 });
        a.record({ ...base, at: base.at + 60_000 });
        const rows = a.drain();
        expect(rows).toHaveLength(3);
        const first = rows.find((r) => r.status === 200 && r.bucket === '2026-11-09T12:00:00.000Z')!;
        expect(first).toMatchObject({ count: 2, durationSumMs: 820, ttfbSumMs: 80, ttfbCount: 1, rlRemainingMin: 40 });
        expect(first.hist[3]).toBe(1);   // 120ms → ≤250
        expect(first.hist[5]).toBe(1);   // 700ms → ≤1000
        expect(first.hist.reduce((x, y) => x + y, 0)).toBe(2);
        expect(a.size).toBe(0);
    });

    it('requeues failed rows, merging and dropping ones too old to send', () => {
        const a = new Aggregator();
        a.record(base);
        const rows = a.drain();
        a.record(base);
        a.requeue(rows, base.at + 1000);
        expect(a.drain()[0].count).toBe(2);
        a.requeue(rows, base.at + 24 * 3_600_000);
        expect(a.size).toBe(0);
        expect(a.dropped).toBe(1);
    });
});

describe('classifyError', () => {
    it('maps Node and undici errors', () => {
        expect(classifyError({ code: 'ENOTFOUND' })).toBe('dns');
        expect(classifyError({ code: 'ECONNREFUSED' })).toBe('connect');
        expect(classifyError({ code: 'UND_ERR_SOCKET' })).toBe('reset');
        expect(classifyError({ code: 'UND_ERR_HEADERS_TIMEOUT' })).toBe('timeout');
        expect(classifyError({ name: 'AbortError' })).toBe('aborted');
        expect(classifyError({ code: 'CERT_HAS_EXPIRED' })).toBe('tls');
        expect(classifyError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toBe('connect');
        expect(classifyError(new Error('?'))).toBe('other');
    });
});

describe('package', () => {
    it('reports the same version as package.json', () => {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
        expect(VERSION).toBe(pkg.version);
    });
});

describe('safety', () => {
    it('never throws on a bad endpoint: the SDK just turns itself off', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const client = new StatusLeakClient({ apiKey: 'sl_sdk_x', endpoint: 'not a url' });
        expect(() => client.start()).not.toThrow();
        expect(warn.mock.calls[0][0]).toContain('Invalid endpoint');
        warn.mockRestore();
    });

    it('reports the same version as package.json', () => {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
        expect(VERSION).toBe(pkg.version);
    });
});
