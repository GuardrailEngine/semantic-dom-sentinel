# Semantic DOM Sentinel

A framework-agnostic, local-only browser library that watches explicitly selected DOM roots for deterministic integrity anomalies. It records a post-hydration baseline, batches `MutationObserver` records, and emits structured alerts for configured changes. It does not make network calls and does not modify, repair, block, or quarantine page content.

> **Early MVP:** This is a monitoring signal, not a security boundary or a replacement for secure coding, output encoding, CSP, Trusted Types, or server-side controls. It does not claim that this concept is unique.

## What it can detect

- Changes to watched attributes on explicitly protected elements, such as a payment form's `action` or a submit button's `formaction`.
- Changes to text for narrowly selected elements when `watchText` is enabled.
- Addition or removal of elements that match a protection rule.
- Newly inserted `iframe`, `object`, `embed`, `script`, or `[srcdoc]` elements inside a monitored root.
- Expected changes can be configured with exact allowlists; routine attributes such as `class` are ignored unless a rule watches them.

Rules are deterministic. There is no model, remote inference, telemetry, or automatic response.

## Install

```sh
npm install semantic-dom-sentinel
```

The package currently has no runtime dependencies. The published browser bundle is also available at `dist/index.global.js` after `npm run build`.

## Quick start

Create the monitor only after your framework has hydrated and the application has established its trusted initial state. Choose the sensitive roots explicitly instead of observing the entire document.

```ts
import { createSentinel, mountInspectorOverlay } from "semantic-dom-sentinel";

const checkoutRoot = document.querySelector("#checkout-root");
if (!(checkoutRoot instanceof HTMLElement)) {
  throw new Error("Checkout root was not found");
}

const inspector = mountInspectorOverlay();
const sentinel = createSentinel({
  roots: [checkoutRoot],
  rules: [
    {
      id: "checkout-form",
      selector: "form[data-checkout]",
      watchAttributes: ["action", "method"],
    },
    {
      id: "payment-submit",
      selector: "button[data-payment-submit]",
      watchAttributes: ["type", "formaction", "aria-label"],
      watchText: true,
    },
  ],
  onAlert(alert) {
    console.warn("DOM integrity alert", alert);
    inspector.push(alert);
  },
});

// Call after a trusted application-level route transition only if the new DOM
// state is intentionally accepted as the next baseline.
// sentinel.refresh();

window.addEventListener("pagehide", () => {
  sentinel.stop();
  inspector.destroy();
}, { once: true });
```

`createSentinel` captures the baseline synchronously when called. It does not guess which elements are sensitive: the application supplies roots and CSS selectors. Use stable rule IDs and avoid putting personal or secret data in rule IDs or selectors.

## Rules and expected changes

`watchAttributes` defaults to `action`, `aria-label`, `aria-controls`, `formaction`, `href`, `method`, `name`, `role`, `src`, `target`, and `type`. Provide a narrower list when practical. Add `class`, `style`, or `data-*` attributes only when your app specifically needs them monitored.

Intentional values can be allowlisted:

```ts
{
  id: "expandable-payment-details",
  selector: "button[data-payment-details]",
  watchAttributes: ["aria-expanded"],
  allowAttributeValues: { "aria-expanded": ["true", "false"] },
}
```

For text, `watchText` is opt-in. It compares normalized `textContent` in memory and does not add text to alert objects. Never enable it for inputs, account details, or user-entered content. `allowTextValues` lets you specify exact expected labels.

Alerts include a reason, rule ID, selector, ephemeral target ID, timestamp, and (for attribute changes) the attribute name. They never include the changed value or a live DOM element. The inspector overlay uses `textContent` and a closed Shadow DOM; it does not read or change protected nodes.

## Lifecycle

- `refresh()` accepts the current DOM as a new baseline. Call it only after a trusted, intentional application transition; doing so while an attack is present would bless that state.
- `stop()` disconnects the observers. Calling it more than once is safe.
- Alerts are notifications only. The library never restores markup, removes nodes, blocks clicks, or quarantines content. Applications decide what to do with alerts.

## Security and privacy limits

- A baseline is a point-in-time comparison, not proof that the initial page is trustworthy. A compromise that exists before initialization may be incorporated into the baseline.
- This library cannot reliably protect itself from browser extensions with elevated privileges. Such extensions may change the DOM outside the page's security boundary, interfere with scripts, or suppress monitoring.
- The contents of iframes are not observed automatically. Cross-origin iframe documents are out of scope and cannot be inspected under the browser same-origin policy. Even same-origin iframe documents must be explicitly monitored as separate roots.
- Same-page scripts may stop or interfere with the monitor. Mutation observation is not a substitute for preventing script injection.
- `watchText` stores the selected element's normalized text in private in-memory state for comparison. Keep the selector narrow and do not use it on sensitive or user-entered text. Input `.value` properties are never read by the library.
- Alert delivery stays in the current page. There are no fetches, sockets, analytics, persistence, or telemetry in the runtime package.
- The library does not prevent DOM-based XSS, clickjacking, phishing, payment redirection, or data theft. It can help a developer notice selected integrity changes after observation starts; it may miss changes outside the configured roots or rules.

Use a strict Content Security Policy, Trusted Types where supported, safe DOM APIs, dependency review, and server-side validation alongside this monitor.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

The unit suite covers fingerprint capture, expected and suspicious changes, allowlists, removals/additions, and repeated observer mutations. Playwright covers SPA-style updates, payment controls, injected iframes, and a network-boundary assertion. Performance smoke tests exercise an 8,000-element tree and a synchronous 1,000-mutation batch. CI runs lint, typecheck, unit/performance tests, and Chromium integration tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please keep runtime code framework-agnostic, deterministic, local-only, and alert-only unless a future design is reviewed as a separate security change.

## License

MIT. See [LICENSE](LICENSE).
