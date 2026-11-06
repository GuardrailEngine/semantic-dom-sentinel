import { describe, expect, it } from "vitest";
import { createSentinel } from "../../src/index.js";
import type { SentinelAlert } from "../../src/types.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("performance smoke tests", () => {
  it("baselines a large DOM tree and coalesces a large synchronous mutation batch", async () => {
    const root = document.createElement("main");
    const elementCount = 8_000;
    root.innerHTML = Array.from(
      { length: elementCount },
      (_, index) => `<button class="sensitive" type="submit" data-index="${index}">Pay</button>`,
    ).join("");
    document.body.append(root);

    const alerts: SentinelAlert[] = [];
    const baselineStart = performance.now();
    const controller = createSentinel({
      roots: [root],
      rules: [{ id: "payments", selector: "button.sensitive", watchAttributes: ["formaction"] }],
      onAlert: (alert) => alerts.push(alert),
    });
    const baselineMs = performance.now() - baselineStart;

    const buttons = [...root.querySelectorAll("button")].slice(0, 1_000);
    const batchStart = performance.now();
    for (const [index, button] of buttons.entries()) button.setAttribute("formaction", `/route/${index}`);
    expect(alerts).toHaveLength(0);
    await tick();
    const batchMs = performance.now() - batchStart;

    expect(alerts).toHaveLength(1_000);
    // Generous bounds catch accidental superlinear regressions without microbenchmark flakiness.
    expect(baselineMs).toBeLessThan(5_000);
    expect(batchMs).toBeLessThan(5_000);
    console.info(`large-tree baseline: ${baselineMs.toFixed(1)}ms; 1,000-change batch: ${batchMs.toFixed(1)}ms`);
    controller.stop();
  }, 15_000);

  it("handles overlapping root registrations without duplicate mutation alerts", async () => {
    const root = document.createElement("main");
    const sections = Array.from({ length: 10 }, () => document.createElement("section"));
    let buttonIndex = 0;
    for (const section of sections) {
      section.innerHTML = Array.from(
        { length: 100 },
        () => `<button class="sensitive" type="submit" data-index="${buttonIndex++}">Pay</button>`,
      ).join("");
    }
    root.append(...sections);
    document.body.append(root);

    const alerts: SentinelAlert[] = [];
    const roots: Element[] = [root, ...sections];
    const baselineStart = performance.now();
    const controller = createSentinel({
      roots,
      rules: [{ id: "payments", selector: "button.sensitive", watchAttributes: ["formaction"] }],
      onAlert: (alert) => alerts.push(alert),
    });
    const baselineMs = performance.now() - baselineStart;

    const buttons = [...root.querySelectorAll("button")];
    const batchStart = performance.now();
    for (const [index, button] of buttons.entries()) button.setAttribute("formaction", `/route/${index}`);
    await tick();
    const batchMs = performance.now() - batchStart;

    expect(alerts).toHaveLength(1_000);
    expect(new Set(alerts.map((alert) => alert.targetId)).size).toBe(1_000);
    // Keep the same generous smoke bounds as the large-tree case.
    expect(baselineMs).toBeLessThan(5_000);
    expect(batchMs).toBeLessThan(5_000);
    console.info(`overlapping-root baseline: ${baselineMs.toFixed(1)}ms; 1,000-change batch: ${batchMs.toFixed(1)}ms`);
    controller.stop();
    root.remove();
  }, 15_000);
});
