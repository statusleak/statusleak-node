// Combines individual calls into per-minute summaries — the wire format of
// POST /v1/ingest (example: tests/fixtures/sample-batch.json).

// Must match the server's HIST_BOUNDS_MS.
export const HIST_BOUNDS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

// Bounds memory if an app calls an enormous variety of endpoints between flushes.
const MAX_ROWS = 5000;
// The server rejects buckets older than 24h.
const MAX_AGE_MS = 23 * 60 * 60 * 1000;

export type ErrorKind = 'timeout' | 'dns' | 'connect' | 'tls' | 'reset' | 'aborted' | 'other';

export interface CallRecord {
    at: number;                 // epoch ms when the call started
    host: string;
    method: string;
    path: string;               // already normalized
    status: number | null;      // null when there was no response
    error: ErrorKind | null;    // set only when status is null
    durationMs: number;
    ttfbMs: number | null;      // null when not observable (node:http)
    rateLimitRemaining: number | null;
}

export interface Row {
    bucket: string;
    host: string;
    method: string;
    path: string;
    status: number | null;
    error: ErrorKind | null;
    count: number;
    durationSumMs: number;
    ttfbSumMs: number;
    ttfbCount: number;
    hist: number[];
    rlRemainingMin?: number;
}

function histIndex(ms: number): number {
    for (let i = 0; i < HIST_BOUNDS_MS.length; i++) {
        if (ms <= HIST_BOUNDS_MS[i]) {
            return i;
        }
    }
    return HIST_BOUNDS_MS.length;
}

function key(r: { bucket: string; host: string; method: string; path: string; status: number | null; error: string | null }): string {
    return `${r.bucket}\u0000${r.host}\u0000${r.method}\u0000${r.path}\u0000${r.status ?? ''}\u0000${r.error ?? ''}`;
}

export class Aggregator {
    private rows = new Map<string, Row>();
    dropped = 0;

    record(call: CallRecord): void {
        const bucket = new Date(Math.floor(call.at / 60_000) * 60_000).toISOString();
        const duration = Math.max(0, Math.round(call.durationMs));
        const ttfb = call.ttfbMs === null ? null : Math.max(0, Math.round(call.ttfbMs));
        const r = this.get({ bucket, host: call.host, method: call.method, path: call.path, status: call.status, error: call.error });
        if (!r) {
            return;
        }
        r.count++;
        r.durationSumMs += duration;
        if (ttfb !== null) {
            r.ttfbSumMs += ttfb;
            r.ttfbCount++;
        }
        r.hist[histIndex(duration)]++;
        if (call.rateLimitRemaining !== null) {
            r.rlRemainingMin = Math.min(r.rlRemainingMin ?? Number.MAX_SAFE_INTEGER, call.rateLimitRemaining);
        }
    }

    // Puts rows back (e.g. after a failed send); merges with anything recorded since.
    requeue(rows: Row[], now = Date.now()): void {
        for (const row of rows) {
            if (Date.parse(row.bucket) < now - MAX_AGE_MS) {
                this.dropped += row.count;
                continue;
            }
            const r = this.get(row);
            if (!r) {
                continue;
            }
            r.count += row.count;
            r.durationSumMs += row.durationSumMs;
            r.ttfbSumMs += row.ttfbSumMs;
            r.ttfbCount += row.ttfbCount;
            r.hist = r.hist.map((v, i) => v + (row.hist[i] ?? 0));
            if (row.rlRemainingMin !== undefined) {
                r.rlRemainingMin = Math.min(r.rlRemainingMin ?? Number.MAX_SAFE_INTEGER, row.rlRemainingMin);
            }
        }
    }

    drain(): Row[] {
        const rows = [...this.rows.values()];
        this.rows.clear();
        return rows;
    }

    get size(): number {
        return this.rows.size;
    }

    private get(k: { bucket: string; host: string; method: string; path: string; status: number | null; error: ErrorKind | null }): Row | null {
        const id = key(k);
        let r = this.rows.get(id);
        if (r) {
            return r;
        }
        if (this.rows.size >= MAX_ROWS) {
            this.dropped++;
            return null;
        }
        r = {
            bucket: k.bucket, host: k.host, method: k.method, path: k.path, status: k.status, error: k.error,
            count: 0, durationSumMs: 0, ttfbSumMs: 0, ttfbCount: 0, hist: Array(HIST_BOUNDS_MS.length + 1).fill(0),
        };
        this.rows.set(id, r);
        return r;
    }
}
