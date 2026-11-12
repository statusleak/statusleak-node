# Changelog

## 0.1.0 — unreleased

First release.

- Records outgoing calls to known API providers via Node's diagnostics
  channels (`fetch`/undici and `node:http(s)`), without monkey-patching.
- Never records bodies, auth headers, cookies, query strings or calls to
  hosts outside the provider list (plus `extraHosts`).
- Per-minute summaries (status or error type, duration, time to first byte
  for `fetch`, latency histogram, rate-limit headroom) sent every 15 seconds.
- `init()`, `flush()`, `shutdown()`, and a zero-config `@statusleak/node/auto` entry.
- Flushes on exit; `flush()` for serverless handlers.
- Picks up new providers and your custom hosts from the server at startup.
- Replaces IDs, emails and phone numbers in paths.
- Never throws into the app: a missing key or bad endpoint turns it off with a
  warning; plan limits pause it (service limit: hourly retry; quota: 10 minutes).
- Types for both ESM and CommonJS consumers.
- Node.js 20+.
