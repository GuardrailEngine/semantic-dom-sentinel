# Contributing

Thanks for helping improve Semantic DOM Sentinel. Keep changes small, documented, and focused on framework-agnostic browser monitoring.

## Principles

- Runtime behavior must be deterministic, local-only, and alert-only.
- Do not add a network client, telemetry, persistence, automatic DOM repair, blocking, or quarantine without a separate reviewed design.
- Never include DOM attribute values, page text, input values, credentials, or personal information in alerts or logs.
- Be explicit about browser security boundaries and avoid overstating protection.

## Before opening a pull request

```sh
npm ci
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

Add unit tests for core behavior and browser tests for observable browser interactions. Performance-sensitive changes should retain or extend the large-tree and mutation-batch smoke tests. The browser suite blocks and records page network requests to guard the no-network runtime boundary.
