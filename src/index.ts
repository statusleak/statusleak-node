import { StatusLeakClient } from './client';
import type { StatusLeakOptions } from './client';

export type { StatusLeakOptions } from './client';
export { StatusLeakClient } from './client';

// Stored on globalThis so every copy of the SDK in the process shares one
// client: the CJS builds of the main and /auto entries are separate bundles,
// and an app can end up with two SDK versions installed. One client also
// means calls are never recorded twice.
const KEY = Symbol.for('statusleak.client');
const store = globalThis as unknown as Record<symbol, StatusLeakClient | null | undefined>;

// Starts recording outgoing calls to third-party APIs. Call once, as early as
// possible (before other modules make requests). Later calls return the same client.
export function init(options: StatusLeakOptions = {}): StatusLeakClient {
    const existing = store[KEY];
    if (existing) {
        return existing;
    }
    const client = new StatusLeakClient(options);
    store[KEY] = client;
    client.start();
    return client;
}

// Sends everything recorded so far. In serverless handlers (Lambda, Vercel),
// `await flush()` before returning so data isn't lost when the runtime freezes.
export async function flush(): Promise<void> {
    await store[KEY]?.flush();
}

// Stops recording and sends what's left.
export async function shutdown(): Promise<void> {
    const c = store[KEY];
    store[KEY] = null;
    await c?.shutdown();
}
