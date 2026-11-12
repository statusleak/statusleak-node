# Security

This SDK runs inside your application, so we take its security seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately:

- on GitHub: **Security → Report a vulnerability** in this repository, or
- by email: **security@statusleak.com**

Include what you found, how to reproduce it, and the SDK version. We'll reply
within 3 business days and keep you updated until it's fixed. We're happy to
credit you in the release notes.

## What the SDK sends

Only per-minute summaries of calls to known API providers: host, method, path
with IDs, emails and phone numbers replaced, status or network error type,
timings and rate-limit headroom. Never request or response bodies, headers
(other than reading rate-limit headroom), cookies or query strings. See
[What it records](README.md#what-it-records).

## Supported versions

Security fixes go into the latest release.
