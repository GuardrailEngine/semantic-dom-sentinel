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
    __sentinelTestRoots: {
      outer: HTMLElement;
      inner: HTMLElement;
      destination: HTMLElement;
      button: HTMLButtonElement;
    };
  }
}

type MockedFetchResponse = {
  url: string;
  body: Record<string, string>;
};

async function prepare(
  page: import("@playwright/test").Page,
  html: string,
  requests: string[],
  mockedFetch?: MockedFetchResponse,
) {
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    requests.push(requestUrl);
    if (requestUrl === mockedFetch?.url) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(mockedFetch.body),
      });
      return;
    }
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

test("reconciles sibling-dependent selector membership after insertion and removal", async ({ page }) => {
  await page.setContent('<main id="app"><div><button id="first"></button><button id="second"></button></div></main>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("#app");
    const first = document.querySelector<HTMLButtonElement>("#first");
    if (!root || !first) throw new Error("Missing sibling-selector fixture");
    window.__sentinelAlerts = [];
    window.__sentinelController = window.SemanticDomSentinel.createSentinel({
      roots: [root],
      rules: [{ id: "second-button", selector: "button:nth-child(2)" }],
      onAlert: (alert) => window.__sentinelAlerts.push(alert),
    });
    first.remove();
  });

  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(1);
  const removalAlerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(removalAlerts.map((alert) => alert.reason)).toEqual(["protected-element-unmatched"]);

  await page.evaluate(() => {
    const second = document.querySelector<HTMLButtonElement>("#second");
    if (!second?.parentElement) throw new Error("Missing remaining sibling");
    const first = document.createElement("button");
    second.parentElement.insertBefore(first, second);
    if (!second.matches("button:nth-child(2)") || first.matches("button:nth-child(2)")) {
      throw new Error("Browser did not apply the expected sibling selector state");
    }
  });

  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(2);
  const alerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(alerts.map((alert) => alert.reason)).toEqual([
    "protected-element-unmatched",
    "protected-element-added",
  ]);
  expect(alerts[0]?.targetId).toBe(alerts[1]?.targetId);
});

test("alerts on mocked external fetch changes to the monitored DOM while blocking real network requests", async ({ page }) => {
  const fixtureUrl = "https://fixture.invalid/dom-change.json";
  const interceptedRequests: string[] = [];
  await prepare(page, `
    <main id="app">
      <form action="/checkout">
        <button class="pay" type="submit" formaction="/pay">Pay securely</button>
      </form>
    </main>
  `, interceptedRequests, {
    url: fixtureUrl,
    body: { text: "Safe fixture label", action: "/fixture/continue" },
  });

  await page.evaluate(async (url) => {
    const response = await fetch(url);
    const fixture = await response.json() as { text: string; action: string };
    const button = document.querySelector<HTMLButtonElement>("button.pay");
    if (!button) throw new Error("Missing payment button");
    button.textContent = fixture.text;
    button.setAttribute("formaction", fixture.action);
  }, fixtureUrl);

  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBeGreaterThanOrEqual(2);
  const alerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(alerts.map((alert) => alert.reason)).toContain("attribute-changed");
  expect(alerts.map((alert) => alert.reason)).toContain("text-changed");
  expect(alerts.map((alert) => alert.ruleId)).toContain("payment-button");
  expect(interceptedRequests).toEqual([fixtureUrl]);
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

test("refresh absorbs a pending mutation and observes later changes from the new baseline", async ({ page }) => {
  const attemptedRequests: string[] = [];
  await prepare(page, `
    <main id="app"><button class="pay" type="submit">Pay</button></main>
  `, attemptedRequests);

  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("button.pay");
    if (!button) throw new Error("Missing payment button");
    button.setAttribute("type", "button");
    window.__sentinelController.refresh();
  });
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
  expect(await page.evaluate(() => window.__sentinelAlerts)).toHaveLength(0);

  await page.evaluate(() => document.querySelector("button.pay")!.setAttribute("type", "reset"));
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(1);
  const alerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(alerts[0]?.reason).toBe("attribute-changed");
  expect(alerts[0]?.attribute).toBe("type");
  expect(attemptedRequests).toEqual([]);
});

test("nested roots do not duplicate mutations and separate same-key events remain separate", async ({ page }) => {
  const attemptedRequests: string[] = [];
  await prepare(page, `
    <main id="app"><form><button class="pay" type="submit">Pay</button></form></main>
  `, attemptedRequests);

  await page.evaluate(() => {
    window.__sentinelController.stop();
    window.__sentinelAlerts = [];
    const outer = document.querySelector<HTMLElement>("#app");
    const inner = document.querySelector<HTMLFormElement>("form");
    if (!outer || !inner) throw new Error("Missing nested roots");
    window.__sentinelController = window.SemanticDomSentinel.createSentinel({
      roots: [outer, inner],
      rules: [
        { id: "all-buttons", selector: "button", watchAttributes: ["type"] },
        { id: "payment-button", selector: "button.pay", watchAttributes: ["type"] },
      ],
      onAlert: (alert) => window.__sentinelAlerts.push(alert),
    });
    const button = document.querySelector<HTMLButtonElement>("button.pay")!;
    button.setAttribute("type", "button");
    button.setAttribute("type", "submit");
  });
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
  expect(await page.evaluate(() => window.__sentinelAlerts)).toHaveLength(0);

  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("button.pay")!;
    button.setAttribute("type", "button");
    button.setAttribute("type", "reset");
  });
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(4);
  const alerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(alerts.map((alert) => alert.reason)).toEqual(Array(4).fill("attribute-changed"));
  expect(alerts.filter((alert) => alert.ruleId === "all-buttons")).toHaveLength(2);
  expect(alerts.filter((alert) => alert.ruleId === "payment-button")).toHaveLength(2);
  expect(new Set(alerts.map((alert) => alert.targetId)).size).toBe(1);
  expect(attemptedRequests).toEqual([]);
});

test("keeps detached roots monitored and reconciles elements that leave and re-enter the roots union", async ({ page }) => {
  const attemptedRequests: string[] = [];
  await prepare(page, `
    <main id="app"><section id="inner"><button class="pay" type="submit">Pay</button></section></main>
    <aside id="destination"></aside>
  `, attemptedRequests);

  await page.evaluate(() => {
    window.__sentinelController.stop();
    window.__sentinelAlerts = [];
    const outer = document.querySelector<HTMLElement>("#app");
    const inner = document.querySelector<HTMLElement>("#inner");
    const destination = document.querySelector<HTMLElement>("#destination");
    if (!outer || !inner || !destination) throw new Error("Missing root fixture");
    window.__sentinelController = window.SemanticDomSentinel.createSentinel({
      roots: [inner, outer, destination],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"], watchText: true }],
      onAlert: (alert) => window.__sentinelAlerts.push(alert),
    });

    const button = document.querySelector<HTMLButtonElement>("button.pay");
    if (!button) throw new Error("Missing protected button");
    window.__sentinelTestRoots = { outer, inner, destination, button };
    inner.remove();
    button.setAttribute("type", "button");
  });
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(1);
  expect((await page.evaluate(() => window.__sentinelAlerts)).map((alert) => alert.reason))
    .toEqual(["attribute-changed"]);

  await page.evaluate(() => {
    const { inner, outer } = window.__sentinelTestRoots;
    outer.append(inner);
  });
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
  expect(await page.evaluate(() => window.__sentinelAlerts.length)).toBe(1);

  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("button.pay");
    if (!button) throw new Error("Missing protected button");
    document.body.append(button);
  });
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(2);
  expect((await page.evaluate(() => window.__sentinelAlerts)).map((alert) => alert.reason))
    .toEqual(["attribute-changed", "protected-element-removed"]);

  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("button.pay")!.setAttribute("type", "reset");
  });
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
  expect(await page.evaluate(() => window.__sentinelAlerts.length)).toBe(2);

  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("button.pay");
    const destination = document.querySelector<HTMLElement>("#destination");
    if (!button || !destination) throw new Error("Missing return fixture");
    destination.append(button);
  });
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(4);
  const alerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(alerts.map((alert) => alert.reason)).toEqual([
    "attribute-changed",
    "protected-element-removed",
    "protected-element-added",
    "attribute-changed",
  ]);
  expect(new Set(alerts.map((alert) => alert.targetId)).size).toBe(1);

  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("button.pay");
    const outer = document.querySelector<HTMLElement>("#app");
    if (!button || !outer) throw new Error("Missing cross-root move fixture");
    outer.append(button);
    button.setAttribute("type", "button");
  });
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(5);
  const finalAlerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(finalAlerts.map((alert) => alert.reason)).toEqual([
    "attribute-changed",
    "protected-element-removed",
    "protected-element-added",
    "attribute-changed",
    "attribute-changed",
  ]);
  expect(finalAlerts[4]?.targetId).toBe(finalAlerts[0]?.targetId);
  expect(JSON.stringify(finalAlerts)).not.toContain("reset");

  await page.evaluate(() => {
    const { button } = window.__sentinelTestRoots;
    button.setAttribute("type", "reset");
    document.body.append(button);
    button.setAttribute("type", "button");
  });
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(7);
  const exitAlerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(exitAlerts.slice(5).map((alert) => alert.reason)).toEqual([
    "attribute-changed",
    "protected-element-removed",
  ]);

  await page.evaluate(() => {
    const { button, destination } = window.__sentinelTestRoots;
    destination.append(button);
  });
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(9);
  const returnAlerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(returnAlerts.slice(5).map((alert) => alert.reason)).toEqual([
    "attribute-changed",
    "protected-element-removed",
    "protected-element-added",
    "attribute-changed",
  ]);
  expect(returnAlerts[8]?.targetId).toBe(returnAlerts[5]?.targetId);
  expect(JSON.stringify(returnAlerts)).not.toContain("reset");

  await page.evaluate(() => {
    const { button, destination, outer } = window.__sentinelTestRoots;
    destination.removeChild(button);
    button.setAttribute("type", "submit");
    button.setAttribute("type", "reset");
    outer.append(button);
  });
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(10);
  const batchReturnAlerts = await page.evaluate(() => window.__sentinelAlerts);
  expect(batchReturnAlerts.slice(9).map((alert) => alert.reason)).toEqual(["attribute-changed"]);

  await page.evaluate(() => {
    window.__sentinelTestRoots.button.setAttribute("type", "button");
  });
  await expect.poll(() => page.evaluate(() => window.__sentinelAlerts.length)).toBe(11);
  expect((await page.evaluate(() => window.__sentinelAlerts)).slice(9).map((alert) => alert.reason))
    .toEqual(["attribute-changed", "attribute-changed"]);
  expect(attemptedRequests).toEqual([]);
});
