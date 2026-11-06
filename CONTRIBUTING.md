# Contributing

Thank you for helping improve Semantic DOM Sentinel. This project is an early-stage, framework-agnostic browser library for observing explicitly selected DOM roots. Contributions should keep the library predictable, privacy-conscious, and clear about its security limits.

## Project principles

- Keep runtime behavior deterministic, local-only, and alert-only. The runtime must not make network requests or add telemetry, remote inference, or persistence.
- Do not automatically repair, block, or quarantine page content. Alerts report observations; the application decides what to do next.
- Do not expose DOM attribute values, page text, input values, credentials, or personal information in alerts, logs, snapshots, or test output.
- Treat browser security boundaries honestly. This monitor is not a security boundary and does not replace secure coding, output encoding, Content Security Policy, Trusted Types, or server-side controls.
- Keep observation explicit and narrow. Do not silently expand monitoring to the entire document or read form-control `.value` properties.

Changes that would alter these boundaries need a separate design discussion and security review before implementation. For suspected vulnerabilities, follow the private reporting instructions in [SECURITY.md](SECURITY.md); do not post exploit details in a public issue.

## Before you start

For a small, well-scoped bug fix or documentation correction, open a pull request directly. For larger behavior changes, new public APIs, or changes to the security and privacy model, open an issue first so the proposed design can be discussed before substantial work begins. Check existing issues and pull requests to avoid duplicating work.

When reporting a bug, include a concise reproduction, expected and actual behavior, and relevant browser/Node.js versions. Use synthetic DOM content in examples and tests; never include real customer pages, secrets, or personal data.

## Development setup

Use Node.js 22 and npm, matching the version used by GitHub Actions. From a fresh checkout, install the locked dependencies:

```sh
npm ci
```

Install the Playwright-managed Chromium, Firefox, and WebKit browsers before running the complete browser integration suite:

```sh
npx playwright install
```

## Development workflow

1. Create a focused branch from the latest `main` (for example, `fix/selector-membership` or `docs/contributing-guide`).
2. Keep changes small and aligned with the project principles. Avoid unrelated formatting or generated files.
3. Add or update tests and documentation alongside behavior changes.
4. Run the relevant checks below before opening a pull request.
5. Open a pull request against `main` with a clear summary, rationale, test results, and any known limitations. Use a concise commit message that describes the change.

For user-visible changes, update [`CHANGELOG.md`](CHANGELOG.md). Versioning and the GitHub-only release checklist are documented in [`docs/releasing.md`](docs/releasing.md).

## Tests and checks

Run the checks relevant to your change. The complete local sequence is:

```sh
npm run lint
npm run typecheck
npm run test:coverage
npx playwright install
npm run test:e2e
npm run build
```

`npm run test:coverage` runs the Vitest unit and performance suites with V8 coverage enabled. The coverage workflow uploads the generated `coverage/` directory as an Actions artifact for 14 days. `npm run test:e2e` builds the package and runs the Playwright browser suite in Chromium, Firefox, and WebKit; install all three browsers first as shown above. `npm run test:all` is also available and runs lint, typecheck, coverage tests, and browser tests in sequence.

GitHub Actions runs lint, typechecking, and Playwright integration tests in Chromium, Firefox, and WebKit in the CI workflow, and runs the unit/performance coverage suite in a separate coverage workflow. Please review the workflow results and resolve failures before requesting review.

## Testing guidance

- Add unit tests for deterministic rule matching, baseline capture, alerts, allowlists, and lifecycle behavior.
- Add or update Playwright tests for observable browser behavior, including SPA-style updates where relevant.
- Preserve the network-boundary assertion: the runtime must not make page network requests.
- For performance-sensitive changes, retain or extend the large-tree and mutation-batch smoke tests.
- Keep test fixtures synthetic and ensure assertions do not print sensitive DOM values.
- Update the README or API documentation when public behavior, options, alerts, or limitations change.

## Pull request checklist

Before requesting review, confirm that:

- [ ] The change has a focused scope and its user-visible behavior is explained.
- [ ] Tests cover the new behavior or regression, including browser coverage where appropriate.
- [ ] Relevant local checks pass, and CI results are green.
- [ ] Documentation and security/privacy limitations are updated when needed.
- [ ] No secrets, personal data, unrelated generated output, or unnecessary runtime dependencies are included.
- [ ] Any change to the library's security boundary or runtime behavior has been discussed separately and clearly called out for review.
