import { afterEach, describe, expect, it, vi } from "vitest";
import { createSentinel } from "../../src/index.js";
import type { ProtectionRule, SentinelAlert, SentinelController } from "../../src/types.js";

const controllers: SentinelController[] = [];
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function rootWith(html = ""): HTMLElement {
  const root = document.createElement("main");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function startMonitoring(
  root: Element,
  onAlert: (alert: SentinelAlert) => void,
  rules: readonly ProtectionRule[] = [
    { id: "payment-button", selector: "button.pay", watchAttributes: ["formaction", "type"] },
  ],
): SentinelController {
  const controller = createSentinel({ roots: [root], rules, onAlert });
  controllers.push(controller);
  return controller;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("observerEngine resilience and lifecycle", () => {
  it("fails clearly when MutationObserver is unavailable", () => {
    vi.stubGlobal("MutationObserver", undefined);
    const root = rootWith('<button class="pay">Pay</button>');

    expect(() => createSentinel({ roots: [root], rules: [], onAlert: () => undefined }))
      .toThrow("Semantic DOM Sentinel requires MutationObserver in a browser environment.");
  });

  it("continues observing later mutations when the consumer callback throws", async () => {
    const root = rootWith('<button class="pay" formaction="/checkout">Pay</button>');
    const observed: SentinelAlert[] = [];
    const onAlert = vi.fn((alert: SentinelAlert) => {
      observed.push(alert);
      throw new Error("consumer callback failure");
    });
    startMonitoring(root, onAlert);
    const button = root.querySelector("button")!;

    button.setAttribute("formaction", "/redirect-one");
    await tick();
    button.setAttribute("formaction", "/redirect-two");
    await tick();

    expect(onAlert).toHaveBeenCalledTimes(2);
    expect(observed.map((alert) => alert.reason)).toEqual([
      "attribute-changed",
      "attribute-changed",
    ]);
  });

  it("absorbs a pending mutation at refresh and observes from the new baseline", async () => {
    const root = rootWith('<button class="pay" type="submit">Pay</button>');
    const alerts: SentinelAlert[] = [];
    const controller = startMonitoring(root, (alert) => alerts.push(alert));
    const button = root.querySelector("button")!;

    button.setAttribute("type", "button");
    controller.refresh();
    await tick();
    expect(alerts).toHaveLength(0);

    button.setAttribute("type", "reset");
    await tick();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.reason).toBe("attribute-changed");
    expect(alerts[0]?.attribute).toBe("type");
  });

  it("absorbs a mutation already enqueued before refresh runs", async () => {
    const root = rootWith('<button class="pay" type="submit">Pay</button>');
    const alerts: SentinelAlert[] = [];
    const controller = startMonitoring(root, (alert) => alerts.push(alert));
    const button = root.querySelector("button")!;

    button.setAttribute("type", "button");
    await Promise.resolve();
    controller.refresh();
    await tick();
    expect(alerts).toHaveLength(0);

    button.setAttribute("type", "reset");
    await tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.attribute).toBe("type");
  });

  it("refresh inside onAlert completes the current alert and abandons the rest of its batch", async () => {
    const root = rootWith('<button class="pay" type="submit">First</button><button class="pay" type="submit">Second</button>');
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [root],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"] }],
      onAlert: (alert) => {
        alerts.push(alert);
        if (alerts.length === 1) controller.refresh();
      },
    });
    controllers.push(controller);
    const buttons = root.querySelectorAll("button");

    buttons[0]!.setAttribute("type", "button");
    buttons[1]!.setAttribute("type", "button");
    await tick();
    expect(alerts).toHaveLength(1);

    buttons[1]!.setAttribute("type", "reset");
    await tick();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.reason).toBe("attribute-changed");
  });

  it("stop inside onAlert completes the current alert and abandons the rest of its batch", async () => {
    const root = rootWith('<button class="pay" type="submit">First</button><button class="pay" type="submit">Second</button>');
    const alerts: SentinelAlert[] = [];
    const controller = createSentinel({
      roots: [root],
      rules: [{ id: "payment-button", selector: "button.pay", watchAttributes: ["type"] }],
      onAlert: (alert) => {
        alerts.push(alert);
        if (alerts.length === 1) controller.stop();
      },
    });
    controllers.push(controller);
    const buttons = root.querySelectorAll("button");

    buttons[0]!.setAttribute("type", "button");
    buttons[1]!.setAttribute("type", "button");
    await tick();
    expect(alerts).toHaveLength(1);

    controller.stop();
    buttons[1]!.setAttribute("type", "reset");
    await tick();
    expect(alerts).toHaveLength(1);
    expect(() => controller.refresh()).toThrow("Cannot refresh a stopped Semantic DOM Sentinel controller.");

    controller.stop();
  });
});

describe("observerEngine configuration validation", () => {
  it("rejects missing roots and blank rule identifiers", () => {
    expect(() => createSentinel({ roots: [], rules: [], onAlert: () => undefined }))
      .toThrow("Provide at least one explicit DOM root.");

    const root = rootWith();
    expect(() => createSentinel({
      roots: [root],
      rules: [{ id: "   ", selector: "button" }],
      onAlert: () => undefined,
    })).toThrow("Every protection rule needs a non-empty id.");
  });

  it("rejects malformed rule selectors and blank watched attribute names", () => {
    const root = rootWith();

    expect(() => createSentinel({
      roots: [root],
      rules: [{ id: "bad-selector", selector: "[" }],
      onAlert: () => undefined,
    })).toThrow(/Invalid CSS selector for rule bad-selector/);

    expect(() => createSentinel({
      roots: [root],
      rules: [{ id: "blank-attribute", selector: "button", watchAttributes: ["  "] }],
      onAlert: () => undefined,
    })).toThrow(/contains an empty attribute name/);
  });

  it("rejects malformed additional risky selectors", () => {
    const root = rootWith();

    expect(() => createSentinel({
      roots: [root],
      rules: [],
      riskySelectors: ["["],
      onAlert: () => undefined,
    })).toThrow(/Invalid CSS selector for riskySelectors/);
  });
});
