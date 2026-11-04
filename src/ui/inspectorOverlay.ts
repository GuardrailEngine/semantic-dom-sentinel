import type { InspectorOverlay, SentinelAlert } from "../types.js";

const MAX_VISIBLE_ALERTS = 50;

/** Mounts a local-only, text-only alert panel. It does not inspect or modify protected page nodes. */
export function mountInspectorOverlay(
  host: HTMLElement = document.body,
  title = "DOM Sentinel alerts",
): InspectorOverlay {
  const container = document.createElement("section");
  container.setAttribute("aria-label", title);
  container.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;font:12px/1.4 system-ui,sans-serif";
  const shadow = container.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .panel { width:min(360px,calc(100vw - 32px)); max-height:40vh; overflow:auto; color:#f8fafc; background:#111827; border:1px solid #475569; border-radius:10px; box-shadow:0 8px 28px #0006; }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-bottom:1px solid #334155; font-weight:700; }
    button { color:inherit; background:transparent; border:1px solid #64748b; border-radius:5px; padding:3px 7px; cursor:pointer; }
    ol { margin:0; padding:8px 12px 8px 32px; }
    li { padding:5px 0; overflow-wrap:anywhere; }
    .empty { padding:12px; color:#cbd5e1; }
  `;
  const panel = document.createElement("div");
  panel.className = "panel";
  const header = document.createElement("header");
  const heading = document.createElement("span");
  heading.textContent = title;
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.textContent = "Clear";
  clearButton.setAttribute("aria-label", "Clear security alerts");
  header.append(heading, clearButton);
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = "No alerts yet.";
  const list = document.createElement("ol");
  list.hidden = true;
  panel.append(header, empty, list);
  shadow.append(style, panel);
  host.append(container);

  const refreshEmptyState = (): void => {
    empty.hidden = list.childElementCount > 0;
    list.hidden = !empty.hidden;
  };
  clearButton.addEventListener("click", () => {
    list.replaceChildren();
    refreshEmptyState();
  });

  return {
    push(alert: SentinelAlert): void {
      const item = document.createElement("li");
      const attribute = alert.attribute ? ` (${alert.attribute})` : "";
      item.textContent = `${alert.reason}${attribute} · ${alert.ruleId} · ${alert.targetId}`;
      list.append(item);
      while (list.childElementCount > MAX_VISIBLE_ALERTS) list.firstElementChild?.remove();
      refreshEmptyState();
    },
    clear(): void {
      list.replaceChildren();
      refreshEmptyState();
    },
    destroy(): void {
      container.remove();
    },
  };
}
