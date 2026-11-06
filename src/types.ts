export const DEFAULT_WATCH_ATTRIBUTES = Object.freeze([
  "action",
  "aria-label",
  "aria-controls",
  "formaction",
  "href",
  "method",
  "name",
  "role",
  "src",
  "target",
  "type",
] as const);

export type SentinelReason =
  | "protected-element-added"
  | "protected-element-removed"
  | "protected-element-unmatched"
  | "attribute-changed"
  | "text-changed"
  | "risky-element-added";

/** A deterministic policy for one class of sensitive DOM elements. */
export interface ProtectionRule {
  /** Stable, app-chosen identifier; do not put user data here. */
  id: string;
  /** A CSS selector scoped to the explicitly supplied roots. */
  selector: string;
  /** Attributes to compare with the post-hydration baseline. Defaults to the security-sensitive list. */
  watchAttributes?: readonly string[];
  /** Values that represent intentional states for a watched attribute. */
  allowAttributeValues?: Readonly<Record<string, readonly string[]>>;
  /** Opt in to watching visible text. Never use this for inputs or user-entered content. */
  watchText?: boolean;
  /** Exact text states that are expected when watchText is enabled. */
  allowTextValues?: readonly string[];
}

export interface SentinelAlert {
  /** Monotonic, per-controller identifier; it contains no DOM or user content. */
  id: number;
  /** Opaque identifier stable for the same Element across refresh and reinsertion; replacement Elements get distinct identifiers. */
  targetId: string;
  reason: SentinelReason;
  ruleId: string;
  /** The configured selector, or the matching built-in risky selector. */
  selector: string;
  /** Present only for attribute-change alerts; never contains the attribute value. */
  attribute?: string;
  detectedAt: number;
}

export interface SentinelOptions {
  /** Sensitive roots chosen by the application after hydration. */
  roots: readonly Element[];
  rules: readonly ProtectionRule[];
  onAlert: (alert: SentinelAlert) => void;
  /** Additional risky-node selectors. Built-in selectors are always included. */
  riskySelectors?: readonly string[];
}

export interface SentinelController {
  /** Accept the current DOM as a new baseline; unreported older mutations are absorbed without alerts. */
  refresh(): void;
  /** Disconnect observers and discard queued work; safe to call more than once. */
  stop(): void;
}

export interface InspectorOverlay {
  push(alert: SentinelAlert): void;
  clear(): void;
  destroy(): void;
}
