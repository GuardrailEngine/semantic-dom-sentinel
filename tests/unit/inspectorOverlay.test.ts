import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountInspectorOverlay } from "../../src/ui/inspectorOverlay.js";
import type { SentinelAlert } from "../../src/types.js";

const capturedShadows: ShadowRoot[] = [];

function createAlert(overrides: Partial<SentinelAlert> = {}): SentinelAlert {
  return {
    id: 1,
    targetId: "target-1",
    reason: "attribute-changed",
    ruleId: "checkout-button",
    selector: "button.pay",
    attribute: "formaction",
    detectedAt: 123,
    ...overrides,
  };
}

function mount(host: HTMLElement = document.body, title?: string) {
  const overlay = title === undefined
    ? mountInspectorOverlay(host)
    : mountInspectorOverlay(host, title);
  const container = host.lastElementChild as HTMLElement;
  const shadow = capturedShadows.at(-1);

  if (!shadow) throw new Error("Inspector overlay did not create a shadow root");
  return { overlay, container, shadow };
}

beforeEach(() => {
  capturedShadows.length = 0;
  const attachShadow = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    const shadow = attachShadow.call(this, init);
    capturedShadows.push(shadow);
    return shadow;
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("InspectorOverlay", () => {
  it("mounts a labeled, closed-shadow panel with an empty state", () => {
    const { container, shadow } = mount();

    expect(container.tagName).toBe("SECTION");
    expect(container.getAttribute("aria-label")).toBe("DOM Sentinel alerts");
    expect(container.shadowRoot).toBeNull();
    expect(shadow.querySelector("header span")?.textContent).toBe("DOM Sentinel alerts");
    expect(shadow.querySelector<HTMLDivElement>(".empty")?.textContent).toBe("No alerts yet.");
    expect(shadow.querySelector<HTMLDivElement>(".empty")?.hidden).toBe(false);
    expect(shadow.querySelector<HTMLOListElement>("ol")?.hidden).toBe(true);

    const host = document.createElement("aside");
    document.body.append(host);
    const custom = mount(host, "Payment monitor");
    expect(host.contains(custom.container)).toBe(true);
    expect(custom.container.getAttribute("aria-label")).toBe("Payment monitor");
    expect(custom.shadow.querySelector("header span")?.textContent).toBe("Payment monitor");
  });

  it("renders alert details as text and toggles from empty to populated", () => {
    const { overlay, shadow } = mount();

    overlay.push(createAlert({ targetId: '<img src=x onerror="alert(1)">' }));

    const list = shadow.querySelector<HTMLOListElement>("ol")!;
    expect(list.hidden).toBe(false);
    expect(shadow.querySelector<HTMLDivElement>(".empty")?.hidden).toBe(true);
    expect(list.children).toHaveLength(1);
    expect(list.querySelector("img")).toBeNull();
    expect(list.firstElementChild?.textContent).toBe(
      'attribute-changed (formaction) · checkout-button · <img src=x onerror="alert(1)">',
    );

    const withoutAttribute = createAlert({
      id: 2,
      targetId: "target-2",
      reason: "protected-element-removed",
    });
    delete withoutAttribute.attribute;
    overlay.push(withoutAttribute);
    expect(list.children).toHaveLength(2);
    expect(list.lastElementChild?.textContent).toBe(
      "protected-element-removed · checkout-button · target-2",
    );
  });

  it("clears alerts through both the button and the public clear method", () => {
    const { overlay, shadow } = mount();
    const list = shadow.querySelector<HTMLOListElement>("ol")!;
    const empty = shadow.querySelector<HTMLDivElement>(".empty")!;

    overlay.push(createAlert());
    shadow.querySelector<HTMLButtonElement>('button[aria-label="Clear security alerts"]')!.click();
    expect(list.childElementCount).toBe(0);
    expect(list.hidden).toBe(true);
    expect(empty.hidden).toBe(false);

    overlay.push(createAlert({ id: 2, targetId: "target-2" }));
    overlay.clear();
    expect(list.childElementCount).toBe(0);
    expect(list.hidden).toBe(true);
    expect(empty.hidden).toBe(false);
  });

  it("keeps only the 50 most recent alerts", () => {
    const { overlay, shadow } = mount();

    for (let index = 0; index < 55; index += 1) {
      overlay.push(createAlert({ id: index, targetId: `target-${index}` }));
    }

    const list = shadow.querySelector<HTMLOListElement>("ol")!;
    expect(list.childElementCount).toBe(50);
    expect(list.firstElementChild?.textContent).toContain("target-5");
    expect(list.lastElementChild?.textContent).toContain("target-54");
    expect(list.textContent).not.toContain("target-4 ·");
  });

  it("removes the panel from its host when destroyed", () => {
    const host = document.createElement("main");
    document.body.append(host);
    const { overlay, container } = mount(host);

    expect(host.contains(container)).toBe(true);
    overlay.destroy();
    expect(host.contains(container)).toBe(false);
    expect(host.childElementCount).toBe(0);
  });
});
