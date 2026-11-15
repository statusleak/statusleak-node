# @statusleak/node

See how the third-party APIs your Node.js app depends on — OpenAI, Stripe, Twilio,
Supabase, and [40+ more](https://statusleak.com) — are performing **for you**, and
whether a problem is theirs or yours.

> **Beta.** The API (`init`, `flush`, `shutdown`) is stable; defaults may still change before 1.0.

```bash
npm install @statusleak/node
```

```ts
// As early as possible in your app, before other modules make requests:
import { init } from '@statusleak/node';
init({ apiKey: process.env.STATUSLEAK_API_KEY, service: 'billing-api' });
```

Or with no code changes, configured by environment variables:

```bash
STATUSLEAK_API_KEY=sl_sdk_… node --import @statusleak/node/auto server.js   # ESM apps
STATUSLEAK_API_KEY=sl_sdk_… node -r @statusleak/node/auto server.js         # CommonJS apps
```

Get an SDK key (`sl_sdk_…`) in Settings on [statusleak.com](https://statusleak.com).

## What it records

For each call to a known API provider: host, method, path with IDs replaced
(`/v1/customers/cus_123` → `/v1/customers/:id`), HTTP status or network error
type, duration, time to first byte (for `fetch`), and rate-limit headroom headers.
Calls are summarised per minute in memory and sent every 15 seconds.

**Never recorded:** request or response bodies, auth headers, cookies, query
strings, or calls to any host that isn't a known provider (your own services,
databases, internal APIs). Emails and phone numbers in paths are replaced too
(`/bounces/jane@acme.com` → `/bounces/:id`). Add other API hosts with `extraHosts`
or as custom hosts in Settings.

The list of known providers ships with the SDK and is refreshed from StatusLeak
at startup and then hourly, so providers added later (and custom hosts set in
Settings) are picked up without an upgrade or a restart.

## How it works

It listens on Node's built-in [diagnostics channels](https://nodejs.org/api/diagnostics_channel.html)
for `fetch`/undici and `node:http(s)` — so it covers the official OpenAI,
Anthropic, Stripe and Twilio SDKs, axios, and most HTTP clients — without
monkey-patching anything. It adds no `error` or `response` listeners to your
requests, never throws into your code, and never keeps your process alive.

## Shutting down

Summaries are sent every 15 seconds, and once more when Node exits on its own.
Containers (Docker, Kubernetes, ECS) stop apps with `SIGTERM` instead, so send
the last few seconds from your shutdown handler:

```ts
import { shutdown } from '@statusleak/node';

process.on('SIGTERM', async () => {
    await server.close();   // your own cleanup
    await shutdown();       // sends what's left (at most a few seconds)
    process.exit(0);
});
```

## Serverless

On platforms that freeze the process between requests (AWS Lambda, Vercel
functions), flush before returning:

```ts
import { flush } from '@statusleak/node';

export async function handler(event) {
    const result = await doWork(event);
    await flush();
    return result;
}
```

## Options

| Option | Env var | Default |
|---|---|---|
| `apiKey` | `STATUSLEAK_API_KEY` | — (required) |
| `service` | `STATUSLEAK_SERVICE` | `default` |
| `environment` | `STATUSLEAK_ENVIRONMENT` / `NODE_ENV` | `production` |
| `extraHosts` | — | `[]` |
| `flushIntervalMs` | — | `15000` |
| `enabled` | `STATUSLEAK_DISABLED=1` turns it off | `true` |
| `debug` | `STATUSLEAK_DEBUG=1` | `false` |

## If data stops

The SDK never throws into your code. It logs one `[statusleak]` warning and:

- **invalid or revoked key** — turns itself off;
- **plan's service limit reached** — pauses that service and checks again hourly;
- **monthly call quota reached** — pauses for 10 minutes at a time;
- **StatusLeak unreachable** — retries once, then drops that batch.

## Limitations

- Node.js 20 or newer (tested on 24). Edge runtimes (Cloudflare Workers, Vercel Edge) aren't supported yet.
- Time to first byte isn't available for `node:http` calls (it can't be observed
  without changing how Node handles responses), only for `fetch`.
- WebSockets and gRPC aren't recorded.

## Development

```bash
npm install
npm run typecheck
npm test            # includes the real OpenAI and Stripe SDKs against local fake servers
npm run build
```

`src/hosts.ts` and `tests/fixtures/normalize-cases.json` are generated from
StatusLeak's provider catalog and synced from the platform. If the batch format
changes on purpose, regenerate `tests/fixtures/sample-batch.json` with
`UPDATE_FIXTURES=1 npm test`.

To see it end to end, `npm run demo` sends real calls through the SDK
(`STATUSLEAK_API_KEY`, optional `STATUSLEAK_ENDPOINT`, `DEMO_INTERVAL_SEC`).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately —
see [SECURITY.md](SECURITY.md).
