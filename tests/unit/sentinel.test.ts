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

  it("uses the current matched DOM as a synchronous baseline without a retroactive alert", async () => {
    const root = rootWith('<button class="pay" type="button">Pay</button>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts);

    await tick();
    expect(alerts).toHaveLength(0);
    root.querySelector("button")!.setAttribute("type", "reset");
    await tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.attribute).toBe("type");
  });

  it("uses the final value for an A-to-B-to-A attribute batch", async () => {
    const root = rootWith('<button class="pay" type="submit">Pay</button>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts);
    const button = root.querySelector("button")!;

    button.setAttribute("type", "button");
    button.setAttribute("type", "submit");
    button.textContent = "Transient label";
    button.textContent = "Pay";
    await tick();

    expect(alerts).toHaveLength(0);
  });

  it("does not merge separate unexpected attribute events in one batch", async () => {
    const root = rootWith('<button class="pay" type="submit">Pay</button>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts);
    const button = root.querySelector("button")!;

    button.setAttribute("type", "button");
    button.setAttribute("type", "reset");
    await tick();

    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.attribute)).toEqual(["type", "type"]);
    expect(alerts[0]?.targetId).toBe(alerts[1]?.targetId);
  });

  it("preserves the absent attribute state between distinct events in a batch", async () => {
    const root = rootWith('<button class="pay">Pay</button>');
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts);
    const button = root.querySelector("button")!;

    button.setAttribute("type", "button");
    button.removeAttribute("type");
    button.setAttribute("type", "reset");
    await tick();

    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.attribute)).toEqual(["type", "type"]);
  });

  it("observes nested roots once while keeping different rules independent", async () => {
    const outer = rootWith('<section><button class="pay" type="submit">Pay</button></section>');
    const inner = outer.querySelector("section")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [outer, inner],
      rules: [
        { id: "all-buttons", selector: "button", watchAttributes: ["type"] },
        { id: "payment-button", selector: "button.pay", watchAttributes: ["type"] },
      ],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    outer.querySelector("button")!.setAttribute("type", "button");
    await tick();

    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.ruleId)).toEqual(["all-buttons", "payment-button"]);
    expect(alerts[0]?.targetId).toBe(alerts[1]?.targetId);
  });

  it("keeps an explicitly supplied nested root observed while detached", async () => {
    const outer = rootWith('<section><button class="pay" type="submit">Pay</button></section>');
    const inner = outer.querySelector("section")!;
    const button = inner.querySelector("button")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [inner, outer],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"] }],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    inner.remove();
    button.setAttribute("type", "button");
    await tick();
    expect(alerts.map((alert) => alert.reason)).toEqual(["attribute-changed"]);

    outer.append(inner);
    await tick();
    button.setAttribute("type", "reset");
    await tick();

    expect(alerts.map((alert) => alert.reason)).toEqual(["attribute-changed", "attribute-changed"]);
    expect(new Set(alerts.map((alert) => alert.targetId)).size).toBe(1);
  });

  it("continues observing a top-level root while the root itself is detached", async () => {
    const root = rootWith('<button class="pay" type="submit">Pay</button>');
    const button = root.querySelector("button")!;
    const alerts: SentinelAlert[] = [];
    monitor(root, alerts);

    root.remove();
    button.setAttribute("type", "button");
    await tick();
    document.body.append(root);
    button.setAttribute("type", "reset");
    await tick();

    expect(alerts.map((alert) => alert.reason)).toEqual(["attribute-changed", "attribute-changed"]);
  });

  it("does not report a protected element moving between supplied roots as removed or added", async () => {
    const first = rootWith('<button class="pay" type="submit">Pay</button>');
    const second = rootWith("");
    const button = first.querySelector("button")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [first, second],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"] }],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    second.append(button);
    await tick();
    expect(alerts).toHaveLength(0);

    button.setAttribute("type", "button");
    await tick();
    expect(alerts.map((alert) => alert.reason)).toEqual(["attribute-changed"]);
  });

  it("reconciles only the return state after distinct writes while outside the roots union", async () => {
    const first = rootWith('<button class="pay" type="submit">Pay</button>');
    const second = rootWith("");
    const button = first.querySelector("button")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [first, second],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"] }],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    button.remove();
    button.setAttribute("type", "button");
    button.setAttribute("type", "reset");
    second.append(button);
    await tick();

    expect(alerts.map((alert) => alert.reason)).toEqual(["attribute-changed"]);

    button.setAttribute("type", "button");
    await tick();
    expect(alerts.map((alert) => alert.reason)).toEqual([
      "attribute-changed",
      "attribute-changed",
    ]);
  });

  it("reconciles the final text only after a same-batch exit and return", async () => {
    const first = rootWith('<button class="pay" type="submit">Pay</button>');
    const second = rootWith("");
    const button = first.querySelector("button")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [first, second],
      rules: [{ id: "payment-button", selector: "button.pay", watchText: true }],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    button.remove();
    button.textContent = "Detached intermediate";
    button.textContent = "Detached final";
    second.append(button);
    await tick();

    expect(alerts.map((alert) => alert.reason)).toEqual(["text-changed"]);
    expect(JSON.stringify(alerts)).not.toContain("Detached");
  });

  it("reconciles watched state when a known element re-enters the roots union", async () => {
    const first = rootWith('<button class="pay" type="submit">Pay</button>');
    const second = rootWith("");
    const button = first.querySelector("button")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [first, second],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"], watchText: true }],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    button.remove();
    await tick();
    button.setAttribute("type", "reset");
    button.textContent = "Changed while outside";
    await tick();
    expect(alerts.map((alert) => alert.reason)).toEqual(["protected-element-removed"]);

    second.append(button);
    await tick();

    expect(alerts.map((alert) => alert.reason)).toEqual([
      "protected-element-removed",
      "protected-element-added",
      "attribute-changed",
      "text-changed",
    ]);
    expect(new Set(alerts.map((alert) => alert.targetId)).size).toBe(1);
    expect(JSON.stringify(alerts)).not.toContain("Changed while outside");
  });

  it("separates a return-state reconciliation from a later in-scope attribute event", async () => {
    const first = rootWith('<button class="pay" type="submit">Pay</button>');
    const second = rootWith("");
    const button = first.querySelector("button")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [first, second],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"] }],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    button.remove();
    await tick();
    button.setAttribute("type", "reset");
    await tick();
    second.append(button);
    button.setAttribute("type", "button");
    await tick();

    expect(alerts.map((alert) => alert.reason)).toEqual([
      "protected-element-removed",
      "protected-element-added",
      "attribute-changed",
      "attribute-changed",
    ]);
    expect(alerts.filter((alert) => alert.reason === "attribute-changed").map((alert) => alert.attribute))
      .toEqual(["type", "type"]);
  });

  it("does not accept a detached final attribute value after an in-scope exit in the same batch", async () => {
    const first = rootWith('<button class="pay" type="submit">Pay</button>');
    const second = rootWith("");
    const button = first.querySelector("button")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [first, second],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"] }],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    button.setAttribute("type", "button");
    button.remove();
    button.setAttribute("type", "reset");
    await tick();
    expect(alerts.map((alert) => alert.reason)).toEqual([
      "attribute-changed",
      "protected-element-removed",
    ]);

    second.append(button);
    await tick();
    expect(alerts.map((alert) => alert.reason)).toEqual([
      "attribute-changed",
      "protected-element-removed",
      "protected-element-added",
      "attribute-changed",
    ]);
    expect(new Set(alerts.map((alert) => alert.targetId)).size).toBe(1);
  });

  it("keeps the root set fixed for a controller and requires recreation for replacement roots", async () => {
    const originalRoot = rootWith('<button class="pay" type="submit">Old</button>');
    const originalButton = originalRoot.querySelector("button")!;
    const replacementRoot = document.createElement("main");
    replacementRoot.innerHTML = '<button class="pay" type="submit">New</button>';
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [originalRoot],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"] }],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    originalRoot.replaceWith(replacementRoot);
    const replacementButton = replacementRoot.querySelector("button")!;
    replacementButton.setAttribute("type", "button");
    await tick();
    expect(alerts).toHaveLength(0);

    originalButton.setAttribute("type", "button");
    await tick();
    expect(alerts.map((alert) => alert.reason)).toEqual(["attribute-changed"]);

    const replacementAlerts: SentinelAlert[] = [];
    const replacementController = createSentinel({
      roots: [replacementRoot],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"] }],
      onAlert: (alert) => replacementAlerts.push(alert),
    });
    controllers.push(replacementController);
    replacementButton.setAttribute("type", "reset");
    await tick();
    expect(replacementAlerts.map((alert) => alert.reason)).toEqual(["attribute-changed"]);
  });

  it("uses root containment rather than roots array order for text ancestor checks", async () => {
    const outer = rootWith('<button class="pay" type="submit"><span>Pay</span></button>');
    const inner = outer.querySelector("span")!;
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [inner, outer],
      rules: [{ id: "payment-button", selector: "button.pay", watchText: true }],
      onAlert: (alert) => alerts.push(alert),
    });
    controllers.push(controller);

    inner.textContent = "Changed";
    await tick();
    expect(alerts.map((alert) => alert.reason)).toEqual(["text-changed"]);
  });

  it("keeps a node targetId across refresh and reinsertion but assigns replacements a new one", async () => {
    const root = rootWith('<button class="pay" type="submit">Pay</button>');
    const alerts: SentinelAlert[] = [];
    const controller = monitor(root, alerts);
    const original = root.querySelector("button")!;

    original.setAttribute("type", "button");
    await tick();
    const originalTargetId = alerts[0]?.targetId;
    expect(originalTargetId).toBeDefined();

    controller.refresh();
    original.setAttribute("type", "reset");
    await tick();
    expect(alerts[1]?.targetId).toBe(originalTargetId);

    original.remove();
    await tick();
    root.append(original);
    await tick();
    expect(alerts.find((alert) => alert.reason === "protected-element-added")?.targetId).toBe(originalTargetId);

    original.remove();
    await tick();
    const replacement = document.createElement("button");
    replacement.className = "pay";
    replacement.type = "reset";
    root.append(replacement);
    await tick();
    const replacementTargetId = alerts.filter((alert) => alert.reason === "protected-element-added").at(-1)?.targetId;
    expect(replacementTargetId).toBeDefined();
    expect(replacementTargetId).not.toBe(originalTargetId);
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
    button.setAttribute("formaction", "/changed-again");
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
