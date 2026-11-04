import type { ProtectionRule } from "../types.js";
import type { DomFingerprint } from "./domFingerprint.js";

export interface AttributeAnomaly {
  changed: boolean;
  state: string;
}

export function inspectAttributeValues(
  baseline: DomFingerprint,
  rule: ProtectionRule,
  attribute: string,
  values: readonly (string | null)[],
): AttributeAnomaly {
  const expected = baseline.attributes[attribute] ?? null;
  const allowlisted = new Set(rule.allowAttributeValues?.[attribute] ?? []);
  const unexpected = values.filter((value) => value !== expected && !(value !== null && allowlisted.has(value)));
  return {
    changed: unexpected.length > 0,
    // Private deduplication state; values are never copied into an alert.
    state: [...new Set(unexpected.map((value) => value ?? "<null>"))].sort().join("\u0000"),
  };
}

export function isExpectedText(
  baseline: DomFingerprint,
  rule: ProtectionRule,
  currentText: string,
): boolean {
  return currentText === baseline.text || (rule.allowTextValues ?? []).includes(currentText);
}
