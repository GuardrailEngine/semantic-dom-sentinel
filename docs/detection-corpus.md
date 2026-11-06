# Detection-quality and browser timing corpus

This small synthetic corpus checks whether the configured monitor reports a set of explicit DOM-policy violations and stays quiet for selected benign controls. It also records browser-engine timing observations. It is a regression and characterization tool, not evidence of comprehensive security.

## What the corpus counts

Each scenario is evaluated against its expected alert outcome in a real Playwright browser engine. A positive means only that the scenario violates the fixture's explicit baseline or allowlist policy; it does not mean the change is malicious.

| Expected outcome | Scenarios |
| --- | --- |
| Alert expected | Unexpected watched attribute; watched text change; matching element added; matching element removed; selector membership lost; risky element added. |
| No alert expected | Allowlisted attribute value; unwatched attribute; mutation outside the monitored root; same-batch mutation reverted to baseline; risky element already present at baseline. |

For the confusion counts, each of the 11 scenarios contributes one observation: expected alert plus observed alert is a true positive (TP); unexpected alert is a false positive (FP); missing expected alert is a false negative (FN); and no alert for a control is a true negative (TN). The test also checks the exact alert reason for each scenario. Passing requires 6 TP, 5 TN, and zero FP/FN in each browser project. These counts describe only this fixed corpus; they are not real-world precision, recall, or threat-detection rates.

## Run the browser corpus

From the repository root:

```sh
npm ci
npx playwright install
npm run test:e2e -- tests/e2e/detection-corpus.spec.ts
```

The `test:e2e` command builds the browser bundle before running the focused test. Playwright runs the corpus in Chromium, Firefox, and WebKit. To run the complete browser suite instead, use `npm run test:e2e`.

Each engine prints a `[detection-corpus]` JSON line and attaches a JSON report to the Playwright test result. The report includes the per-scenario expected and observed reasons, the TP/FP/FN/TN counts, and engine-specific timing summaries. Classification mismatches fail the test; timing values are descriptive and have no absolute pass/fail threshold.

## Timing measurements

- **Baseline capture:** 20 timed `createSentinel()` calls on a prepared fixture containing 1,000 matching buttons, after 3 warm-up calls. Fixture construction is outside the timed interval. The report includes sample count, median, nearest-rank p95, minimum, and maximum.
- **Mutation to first callback:** 12 repetitions for each alert-expected scenario. `performance.now()` is read immediately before the synchronous mutation and inside the first `onAlert` callback, in the page's own browser context. The callback latency is not the same as the application's end-to-end reaction time; it excludes downstream work performed by the application after receiving an alert.

These timings characterize this fixture on the browser engine and machine that ran it. They depend on browser version, operating system, CPU, load, and test environment. Compare runs only when the environments are reasonably alike; do not use the values as universal performance guarantees.

## Limits

The cases are few, deterministic, and hand-selected. They do not model representative production pages, establish the frequency of benign or hostile changes, or cover every way a page or script can alter DOM state. A scenario label is a test expectation, not an independent security judgment. Passing shows that the tested library build behaved as expected for these cases on those engines; it does not prove comprehensive detection, security effectiveness, prevention, or safety when no alert is produced. Use the monitor only as an observability signal alongside CSP, Trusted Types where supported, safe DOM APIs, dependency review, and server-side controls.
