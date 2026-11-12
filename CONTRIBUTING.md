# Contributing

Thanks for helping improve `@statusleak/node`.

## Issues

Bug reports and feature requests are welcome — please include your Node.js
version, the HTTP client or provider SDK involved, and what you expected to see.
For security issues, see [SECURITY.md](SECURITY.md) instead.

## Pull requests

```bash
npm install
npm run typecheck
npm test
npm run build
```

- Keep the SDK free of runtime dependencies.
- It must never change how the host app behaves: no `error` or `response`
  listeners on requests, no thrown errors, no timers that keep the process alive.
- Never record more than today: no bodies, headers or query strings.
- Add or update tests, and a line in `CHANGELOG.md`.

`src/hosts.ts` and `tests/fixtures/normalize-cases.json` are generated from
StatusLeak's provider catalog; to add a provider, open an issue rather than
editing them.

## Code style

Four-space indentation, and always braces around `if` bodies:

```ts
if (something) {
    doSomething();
}
```
