import { afterEach, describe, expect, it } from "vitest";
import { createDomFingerprint } from "../../src/core/domFingerprint.js";
import { createSentinel } from "../../src/index.js";
import type { ProtectionRule, SentinelAlert, SentinelController } from "../../src/types.js";

const controllers: SentinelController[] = [];
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function rootWith(html: string): HTMLElement {
  const root = document.createElement("main");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function monitor(root: Element, alerts: SentinelAlert[], rules: readonly ProtectionRule[] = [
  { id: "payment-button", selector: "button.pay", watchAttributes: ["formaction", "type"], watchText: true },
]) {
  const controller = createSentinel({ roots: [root], rules, onAlert: (alert) => alerts.push(alert) });
  controllers.push(controller);
  return controller;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  document.body.replaceChildren();
});

describe("DOM fingerprinting", () => {
  it("captures only configured attributes and opt-in text, never input.value", () => {
    const input = document.createElement("input");
    input.setAttribute("name", "account");
    input.value = "private-value";
    const fingerprint = createDomFingerprint(input, {
      id: "field",
      selector: "input",
      watchAttributes: ["name"],
      watchText: true,
    });

    expect(fingerprint).toEqual({ tagName: "input", attributes: { name: "account" }, text: "" });
    expect(JSON.stringify(fingerprint)).not.toContain("private-value");
  });
});

describe("deterministic DOM monitoring", () => {
  it("alerts on a protected payment-button attribute and text change without disclosing values", async () => {
    const root = rootWith('<button class="pay" type="submit" formaction="/pay">Pay securely</button>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts);
    const button = root.querySelector("button")!;
    button.setAttribute("formaction", "https://untrusted.invalid/pay?token=private");
    button.textContent = "Send funds elsewhere";
    await tick();

    expect(alerts.map((alert) => alert.reason)).toContain("attribute-changed");
    expect(alerts.map((alert) => alert.reason)).toContain("text-changed");
    expect(JSON.stringify(alerts)).not.toContain("untrusted.invalid");
    expect(JSON.stringify(alerts)).not.toContain("private");
  });

  it("allows configured expected values and ignores unmonitored attributes", async () => {
    const root = rootWith('<button class="pay" aria-expanded="false">Pay</button>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts, [{
      id: "payment-button",
      selector: "button.pay",
      watchAttributes: ["aria-expanded", "formaction"],
      allowAttributeValues: { "aria-expanded": ["true", "false"] },
    }]);
    const button = root.querySelector("button")!;
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("class", "pay highlighted");
    await tick();
    expect(alerts).toHaveLength(0);

    button.setAttribute("formaction", "/unexpected");
    await tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.attribute).toBe("formaction");
  });

  it("detects protected form changes and new risky iframe elements", async () => {
    const root = rootWith('<form action="/checkout"><button class="pay">Pay</button></form>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts, [
      { id: "checkout-form", selector: "form", watchAttributes: ["action", "method"] },
      { id: "payment-button", selector: "button.pay", watchAttributes: ["type", "formaction"] },
    ]);
    root.querySelector("form")!.setAttribute("action", "/redirected");
    const frame = document.createElement("iframe");
    root.append(frame);
    await tick();

    expect(alerts.map((alert) => alert.ruleId)).toContain("checkout-form");
    expect(alerts.some((alert) => alert.reason === "risky-element-added" && alert.selector === "iframe")).toBe(true);
  });

  it("reports removed protected elements and newly inserted protected elements", async () => {
    const root = rootWith('<button class="pay">Pay</button>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts);
    root.querySelector("button")!.remove();
    const replacement = document.createElement("button");
    replacement.className = "pay";
    replacement.textContent = "Pay";
    root.append(replacement);
    await tick();

    expect(alerts.map((alert) => alert.reason)).toContain("protected-element-removed");
    expect(alerts.map((alert) => alert.reason)).toContain("protected-element-added");
  });

  it("detects an existing element that begins matching a protection selector", async () => {
    const root = rootWith("<button>Pay</button>");
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts, [{ id: "payment-button", selector: "button.pay", watchAttributes: ["formaction"] }]);
    const button = root.querySelector("button")!;

    button.classList.add("pay");
    await tick();
    expect(alerts.map((alert) => alert.reason)).toContain("protected-element-added");

    button.setAttribute("formaction", "/unexpected");
    await tick();
    expect(alerts.map((alert) => alert.reason)).toContain("attribute-changed");
  });

  it("reports selector membership changes caused by an ancestor attribute", async () => {
    const root = rootWith('<section class="checkout"><button class="pay" formaction="/pay">Pay</button></section>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts, [{ id: "payment-button", selector: ".checkout button.pay", watchAttributes: ["formaction"] }]);
    const section = root.querySelector("section")!;
    const button = root.querySelector("button")!;

    section.classList.remove("checkout");
    await tick();
    expect(alerts.map((alert) => alert.reason)).toContain("protected-element-unmatched");

    section.classList.add("checkout");
    await tick();
    button.setAttribute("formaction", "/redirected");
    await tick();
    expect(alerts.map((alert) => alert.reason)).toContain("protected-element-added");
    expect(alerts.map((alert) => alert.reason)).toContain("attribute-changed");
  });

  it("re-alerts when the same protected or risky node is removed and reinserted", async () => {
    const root = rootWith('<button class="pay" formaction="/checkout">Pay</button><iframe></iframe>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts);
    const button = root.querySelector("button")!;
    const frame = root.querySelector("iframe")!;

    button.setAttribute("formaction", "/changed");
    await tick();
    button.remove();
    frame.remove();
    await tick();
    root.append(button, frame);
    await tick();
    button.setAttribute("formaction", "/changed");
    await tick();

    expect(alerts.filter((alert) => alert.reason === "attribute-changed")).toHaveLength(2);
    expect(alerts.filter((alert) => alert.reason === "risky-element-added")).toHaveLength(1);
    expect(alerts.filter((alert) => alert.reason === "protected-element-removed")).toHaveLength(1);
  });

  it("deduplicates repeated mutations caused by an alert callback", async () => {
    const root = rootWith('<button class="pay" formaction="/checkout">Pay</button>');
    const button = root.querySelector("button")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [root],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["formaction"] }],
      onAlert: (alert) => {
        alerts.push(alert);
        button.setAttribute("formaction", "https://untrusted.invalid/checkout");
      },
    });
    controllers.push(controller);
    button.setAttribute("formaction", "https://untrusted.invalid/checkout");
    await tick();
    await tick();

    expect(alerts).toHaveLength(1);
  });

  it("can intentionally refresh a baseline and stops observing when requested", async () => {
    const root = rootWith('<button class="pay" type="submit">Pay</button>');
    const alerts: SentinelAlert[] = [];
    const controller = monitor(root, alerts);
    const button = root.querySelector("button")!;
    button.setAttribute("type", "button");
    await tick();
    controller.refresh();
    button.setAttribute("type", "reset");
    await tick();
    expect(alerts).toHaveLength(2);

    controller.stop();
    button.setAttribute("type", "submit");
    await tick();
    expect(alerts).toHaveLength(2);
  });

  it("rejects duplicate rule identifiers and invalid selectors", () => {
    const root = rootWith("<button></button>");
    expect(() => createSentinel({
      roots: [root],
      rules: [
        { id: "same", selector: "button" },
        { id: "same", selector: "form" },
      ],
      onAlert: () => undefined,
    })).toThrow(/Duplicate protection rule id/);
    expect(() => createSentinel({
      roots: [root],
      rules: [{ id: "bad", selector: "[" }],
      onAlert: () => undefined,
    })).toThrow(/Invalid CSS selector/);
  });
});
