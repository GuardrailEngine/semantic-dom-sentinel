import { createSentinel, mountInspectorOverlay } from "../src/index.js";

/** Invoke this only after the application has finished hydration. */
export function startCheckoutMonitoring(): () => void {
  const checkout = document.querySelector("#checkout-root");
  if (!(checkout instanceof HTMLElement)) throw new Error("#checkout-root was not found");

  const overlay = mountInspectorOverlay();
  const controller = createSentinel({
    roots: [checkout],
    rules: [
      { id: "checkout-form", selector: "form[data-checkout]", watchAttributes: ["action", "method"] },
      {
        id: "payment-submit",
        selector: "button[data-payment-submit]",
        watchAttributes: ["type", "formaction", "aria-label"],
        watchText: true,
      },
    ],
    onAlert(alert) {
      overlay.push(alert);
      console.warn("DOM integrity alert", alert);
    },
  });

  return () => {
    controller.stop();
    overlay.destroy();
  };
}
