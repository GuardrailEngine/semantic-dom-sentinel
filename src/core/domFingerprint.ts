import { DEFAULT_WATCH_ATTRIBUTES, type ProtectionRule } from "../types.js";

export interface DomFingerprint {
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string | null>>;
  /** Stored only in the controller's private memory when the app explicitly opts in. */
  readonly text?: string;
}

export function watchedAttributes(rule: ProtectionRule): readonly string[] {
  const names = new Set(rule.watchAttributes ?? DEFAULT_WATCH_ATTRIBUTES);
  for (const name of Object.keys(rule.allowAttributeValues ?? {})) names.add(name);
  return [...names];
}

export function normalizeText(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Captures only configured, non-property DOM state; it never reads input.value. */
export function createDomFingerprint(element: Element, rule: ProtectionRule): DomFingerprint {
  const attributes: Record<string, string | null> = {};
  for (const name of watchedAttributes(rule)) attributes[name] = element.getAttribute(name);

  return {
    tagName: element.tagName.toLowerCase(),
    attributes,
    ...(rule.watchText ? { text: normalizeText(element.textContent) } : {}),
  };
}

export function fingerprintState(fingerprint: DomFingerprint): string {
  const attrs = Object.keys(fingerprint.attributes)
    .sort()
    .map((name) => `${name.length}:${name}=${fingerprint.attributes[name] ?? "<null>"}`)
    .join("|");
  return `${fingerprint.tagName}|${attrs}|${fingerprint.text ?? "<text-unwatched>"}`;
}
