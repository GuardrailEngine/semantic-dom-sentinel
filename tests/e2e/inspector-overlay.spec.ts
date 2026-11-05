import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type {
  InspectorOverlay,
  SentinelAlert,
  SentinelController,
  SentinelOptions,
} from "../../src/types.js";

const bundle = readFileSync(resolve(process.cwd(), "dist/index.global.js"), "utf8");

declare global {
  interface Window {
    SemanticDomSentinel: {
      createSentinel: (options: SentinelOptions) => SentinelController;
      mountInspectorOverlay: (host?: HTMLElement, title?: string) => InspectorOverlay;
    };
    __overlay: InspectorOverlay;
    __overlayShadow: ShadowRoot;
    __receivedAlerts: SentinelAlert[];
    __sentinelController: SentinelController;
  }
}

async function mountOverlay(page: Page, title = "Payment monitor"): Promise<void> {
  await page.setContent('<main id="app"><p id="protected">Checkout content</p></main>');
  await page.evaluate(() => {
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const shadow = attachShadow.call(this, init);
      if (init.mode === "closed") window.__overlayShadow = shadow;
      return shadow;
    };
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate((panelTitle) => {
    window.__overlay = window.SemanticDomSentinel.mountInspectorOverlay(document.body, panelTitle);
  }, title);
}

function makeAlert(index: number): SentinelAlert {
  return {
    id: index,
    targetId: `target-${index}`,
    reason: "attribute-changed",
    ruleId: "checkout-form",
    selector: "form",
    attribute: "action",
    detectedAt: index,
  };
}

test("mounts a visible labeled panel in a closed shadow root without changing page content", async ({ page }) => {
  await mountOverlay(page);

  const host = page.locator('section[aria-label="Payment monitor"]');
  await expect(host).toBeVisible();

  const rendered = await page.evaluate(() => {
    const panelHost = document.querySelector<HTMLElement>('section[aria-label="Payment monitor"]');
    const shadow = window.__overlayShadow;
    if (!panelHost) throw new Error("Overlay host was not mounted");
    const panel = shadow.querySelector<HTMLElement>(".panel");
    const empty = shadow.querySelector<HTMLElement>(".empty");
    const list = shadow.querySelector<HTMLOListElement>("ol");
    if (!panel || !empty || !list) throw new Error("Overlay panel is incomplete");

    return {
      shadowMode: shadow.mode,
      hiddenFromPageScript: panelHost.shadowRoot === null,
      heading: shadow.querySelector("header span")?.textContent,
      emptyText: empty.textContent,
      emptyVisible: !empty.hidden,
      listHidden: list.hidden,
      position: getComputedStyle(panelHost).position,
      zIndex: getComputedStyle(panelHost).zIndex,
      panelBackground: getComputedStyle(panel).backgroundColor,
      pageText: document.querySelector("#protected")?.textContent,
    };
  });

  expect(rendered).toEqual({
    shadowMode: "closed",
    hiddenFromPageScript: true,
    heading: "Payment monitor",
    emptyText: "No alerts yet.",
    emptyVisible: true,
    listHidden: true,
    position: "fixed",
    zIndex: "2147483647",
    panelBackground: "rgb(17, 24, 39)",
    pageText: "Checkout content",
  });
});

test("renders untrusted alert text safely, keeps the latest 50 alerts, and clears from the panel button", async ({ page }) => {
  await mountOverlay(page);

  const alerts = Array.from({ length: 50 }, (_, index) => makeAlert(index));
  alerts.push({ ...makeAlert(50), targetId: '<img src=x onerror="alert(1)">' });
  await page.evaluate((alertsToPush) => {
    alertsToPush.forEach((alert) => window.__overlay.push(alert));
  }, alerts);

  const populated = await page.evaluate(() => {
    const shadow = window.__overlayShadow;
    const list = shadow.querySelector<HTMLOListElement>("ol");
    const empty = shadow.querySelector<HTMLElement>(".empty");
    if (!list || !empty) throw new Error("Overlay list is unavailable");
    return {
      count: list.childElementCount,
      first: list.firstElementChild?.textContent,
      last: list.lastElementChild?.textContent,
      imageCount: list.querySelectorAll("img").length,
      emptyHidden: empty.hidden,
    };
  });

  expect(populated.count).toBe(50);
  expect(populated.first).toContain("target-1");
  expect(populated.last).toBe('attribute-changed (action) · checkout-form · <img src=x onerror="alert(1)">');
  expect(populated.imageCount).toBe(0);
  expect(populated.emptyHidden).toBe(true);

  await page.evaluate(() => {
    const clearButton = window.__overlayShadow.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear security alerts"]',
    );
    if (!clearButton) throw new Error("Clear button is unavailable");
    clearButton.click();
  });

  const cleared = await page.evaluate(() => ({
    count: window.__overlayShadow.querySelector("ol")?.childElementCount,
    listHidden: window.__overlayShadow.querySelector<HTMLOListElement>("ol")?.hidden,
    emptyVisible: !window.__overlayShadow.querySelector<HTMLElement>(".empty")?.hidden,
  }));
  expect(cleared).toEqual({ count: 0, listHidden: true, emptyVisible: true });
});

test("displays a real Sentinel alert and removes the panel when destroyed", async ({ page }) => {
  await page.setContent('<main id="app"><form action="/checkout"><button>Pay</button></form></main>');
  await page.evaluate(() => {
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const shadow = attachShadow.call(this, init);
      if (init.mode === "closed") window.__overlayShadow = shadow;
      return shadow;
    };
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const overlay = window.SemanticDomSentinel.mountInspectorOverlay(document.body);
    window.__overlay = overlay;
    window.__receivedAlerts = [];
    const root = document.querySelector<HTMLElement>("#app");
    if (!root) throw new Error("Missing application root");

    window.__sentinelController = window.SemanticDomSentinel.createSentinel({
      roots: [root],
      rules: [{ id: "checkout-form", selector: "form", watchAttributes: ["action"] }],
      onAlert: (alert) => {
        window.__receivedAlerts.push(alert);
        overlay.push(alert);
      },
    });
    root.querySelector("form")?.setAttribute("action", "https://untrusted.invalid/submit?token=private");
  });

  await expect.poll(() => page.evaluate(() => window.__receivedAlerts.length)).toBe(1);
  const rendered = await page.evaluate(() => ({
    reason: window.__receivedAlerts[0]?.reason,
    alertCount: window.__overlayShadow.querySelector("ol")?.childElementCount,
    alertText: window.__overlayShadow.querySelector("ol li")?.textContent,
  }));
  expect(rendered.reason).toBe("attribute-changed");
  expect(rendered.alertCount).toBe(1);
  expect(rendered.alertText).toMatch(/^attribute-changed \(action\) · checkout-form · /);
  expect(rendered.alertText).not.toContain("untrusted.invalid");
  expect(rendered.alertText).not.toContain("private");

  await page.evaluate(() => {
    window.__sentinelController.stop();
    window.__overlay.destroy();
  });
  await expect(page.locator('section[aria-label="DOM Sentinel alerts"]')).toHaveCount(0);
});
