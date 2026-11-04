import { inspectAttributeValues, isExpectedText } from "./anomalyDetector.js";
import {
  createDomFingerprint,
  normalizeText,
  type DomFingerprint,
  watchedAttributes,
} from "./domFingerprint.js";
import type {
  ProtectionRule,
  SentinelAlert,
  SentinelController,
  SentinelOptions,
} from "../types.js";

const BUILTIN_RISKY_SELECTORS = Object.freeze([
  "iframe",
  "object",
  "embed",
  "script",
  "[srcdoc]",
]);
const BUILTIN_RULE_ID = "__sentinel_risky_node__";

type Observer = MutationObserver;

function assertSelector(selector: string, label: string): void {
  try {
    document.createElement("div").matches(selector);
  } catch {
    throw new TypeError(`Invalid CSS selector for ${label}: ${selector}`);
  }
}

function queryWithin(root: Element, selector: string): Element[] {
  const result: Element[] = [];
  if (root.matches(selector)) result.push(root);
  result.push(...root.querySelectorAll(selector));
  return result;
}

function elementsIn(node: Node): Element[] {
  const elements: Element[] = [];
  if (node.nodeType === 1) elements.push(node as Element);
  const parent = node as Node & ParentNode;
  if (typeof parent.querySelectorAll === "function") {
    elements.push(...parent.querySelectorAll("*"));
  }
  return elements;
}

function hasTextNode(node: Node): boolean {
  if (node.nodeType === 3) return true;
  for (const child of node.childNodes) if (hasTextNode(child)) return true;
  return false;
}

function currentFingerprint(element: Element, rule: ProtectionRule): DomFingerprint {
  return createDomFingerprint(element, rule);
}

export function createSentinel(options: SentinelOptions): SentinelController {
  if (typeof MutationObserver === "undefined") {
    throw new Error("Semantic DOM Sentinel requires MutationObserver in a browser environment.");
  }
  if (!options.roots.length) throw new TypeError("Provide at least one explicit DOM root.");

  const roots = [...new Set(options.roots)];
  const ids = new Set<string>();
  for (const rule of options.rules) {
    if (!rule.id.trim()) throw new TypeError("Every protection rule needs a non-empty id.");
    if (ids.has(rule.id)) throw new TypeError(`Duplicate protection rule id: ${rule.id}`);
    ids.add(rule.id);
    assertSelector(rule.selector, `rule ${rule.id}`);
    for (const name of watchedAttributes(rule)) {
      if (!name.trim()) throw new TypeError(`Rule ${rule.id} contains an empty attribute name.`);
    }
  }

  const riskySelectors = [...new Set([...BUILTIN_RISKY_SELECTORS, ...(options.riskySelectors ?? [])])];
  for (const selector of riskySelectors) assertSelector(selector, "riskySelectors");

  let fingerprints = new WeakMap<Element, Map<string, DomFingerprint>>();
  let activeRules = new WeakMap<Element, Set<string>>();
  let baselineRisky = new WeakSet<Element>();
  let seenRisky = new WeakSet<Element>();
  let lastStates = new WeakMap<Element, Map<string, string>>();
  let nodeIds = new WeakMap<Element, string>();
  let nextNodeId = 1;
  let nextAlertId = 1;
  let pending: MutationRecord[] = [];
  let scheduled = false;
  let stopped = false;
  const observers: Observer[] = [];

  const getTargetId = (element: Element): string => {
    let id = nodeIds.get(element);
    if (!id) {
      id = `node-${nextNodeId++}`;
      nodeIds.set(element, id);
    }
    return id;
  };

  const emit = (
    element: Element,
    reason: SentinelAlert["reason"],
    ruleId: string,
    selector: string,
    state: string,
    attribute?: string,
  ): void => {
    let stateMap = lastStates.get(element);
    if (!stateMap) {
      stateMap = new Map();
      lastStates.set(element, stateMap);
    }
    const key = `${ruleId}|${reason}|${attribute ?? ""}`;
    if (stateMap.get(key) === state) return;
    stateMap.set(key, state);
    const alert: SentinelAlert = {
      id: nextAlertId++,
      targetId: getTargetId(element),
      reason,
      ruleId,
      selector,
      ...(attribute ? { attribute } : {}),
      detectedAt: Date.now(),
    };
    try {
      options.onAlert(alert);
    } catch {
      // A consumer callback must not break observation of later mutations.
    }
  };

  const clearDeduplication = (element: Element, ruleId: string, reason: string, attribute?: string): void => {
    const key = `${ruleId}|${reason}|${attribute ?? ""}`;
    lastStates.get(element)?.delete(key);
  };

  const storeBaseline = (element: Element, rule: ProtectionRule): void => {
    let snapshots = fingerprints.get(element);
    if (!snapshots) {
      snapshots = new Map();
      fingerprints.set(element, snapshots);
    }
    snapshots.set(rule.id, currentFingerprint(element, rule));
    let active = activeRules.get(element);
    if (!active) {
      active = new Set();
      activeRules.set(element, active);
    }
    active.add(rule.id);
  };

  const establishBaseline = (): void => {
    fingerprints = new WeakMap();
    activeRules = new WeakMap();
    baselineRisky = new WeakSet();
    seenRisky = new WeakSet();
    lastStates = new WeakMap();
    nodeIds = new WeakMap();
    nextNodeId = 1;
    for (const root of roots) {
      for (const rule of options.rules) {
        for (const element of queryWithin(root, rule.selector)) {
          if (!fingerprints.get(element)?.has(rule.id)) storeBaseline(element, rule);
        }
      }
      for (const selector of riskySelectors) {
        for (const element of queryWithin(root, selector)) baselineRisky.add(element);
      }
    }
  };

  const reportRemoved = (node: Node): void => {
    for (const element of elementsIn(node)) {
      for (const rule of options.rules) {
        const active = activeRules.get(element);
        if (!active?.has(rule.id) || !fingerprints.get(element)?.has(rule.id)) continue;
        if (!element.matches(rule.selector)) continue;
        active.delete(rule.id);
        emit(element, "protected-element-removed", rule.id, rule.selector, "removed");
      }
    }
  };

  const reportAdded = (node: Node): void => {
    for (const element of elementsIn(node)) {
      for (const selector of riskySelectors) {
        if (!element.matches(selector) || baselineRisky.has(element) || seenRisky.has(element)) continue;
        seenRisky.add(element);
        emit(element, "risky-element-added", BUILTIN_RULE_ID, selector, "added");
        break;
      }
      for (const rule of options.rules) {
        if (!element.matches(rule.selector)) continue;
        const active = activeRules.get(element);
        const known = fingerprints.get(element)?.has(rule.id) ?? false;
        if (active?.has(rule.id)) continue;
        if (!known) storeBaseline(element, rule);
        else active?.add(rule.id);
        emit(element, "protected-element-added", rule.id, rule.selector, "added");
      }
    }
  };

  const protectedAncestors = (start: Node, rule: ProtectionRule, boundary: Element): Element[] => {
    const matches: Element[] = [];
    let current: Element | null = start.nodeType === 1 ? (start as Element) : start.parentElement;
    while (current) {
      if (current.matches(rule.selector) && activeRules.get(current)?.has(rule.id)) matches.push(current);
      if (current === boundary) break;
      current = current.parentElement;
    }
    return matches;
  };

  const findRoot = (element: Element): Element | undefined =>
    roots.find((root) => root === element || root.contains(element));

  const processAttribute = (record: MutationRecord, element: Element): void => {
    const attribute = record.attributeName;
    if (!attribute) return;
    for (const rule of options.rules) {
      if (!element.matches(rule.selector) || !activeRules.get(element)?.has(rule.id)) continue;
      if (!watchedAttributes(rule).includes(attribute)) continue;
      const baseline = fingerprints.get(element)?.get(rule.id);
      if (!baseline) continue;
      const current = element.getAttribute(attribute);
      const result = inspectAttributeValues(baseline, rule, attribute, [record.oldValue, current]);
      if (result.changed) {
        emit(element, "attribute-changed", rule.id, rule.selector, result.state, attribute);
      } else {
        clearDeduplication(element, rule.id, "attribute-changed", attribute);
      }
    }
  };

  const processTextMutation = (record: MutationRecord): void => {
    const textChangedStructure = record.type === "childList" &&
      [...record.addedNodes, ...record.removedNodes].some(hasTextNode);
    for (const rule of options.rules) {
      if (!rule.watchText) continue;
      const boundary = findRoot(record.target.nodeType === 1
        ? (record.target as Element)
        : record.target.parentElement ?? roots[0]!);
      if (!boundary) continue;
      for (const element of protectedAncestors(record.target, rule, boundary)) {
        const baseline = fingerprints.get(element)?.get(rule.id);
        if (!baseline) continue;
        const text = normalizeText(element.textContent);
        const transientCharacterChange = record.type === "characterData" &&
          record.oldValue !== (record.target as CharacterData).data;
        const unexpected = !isExpectedText(baseline, rule, text);
        if (unexpected || transientCharacterChange || textChangedStructure) {
          const state = unexpected ? `text:${text}` : `text:transient:${record.type}`;
          emit(element, "text-changed", rule.id, rule.selector, state);
        } else {
          clearDeduplication(element, rule.id, "text-changed");
        }
      }
    }
  };

  const flush = (): void => {
    scheduled = false;
    if (stopped || pending.length === 0) return;
    const records = pending;
    pending = [];
    for (const record of records) {
      if (record.type === "attributes" && record.target.nodeType === 1) {
        processAttribute(record, record.target as Element);
      }
      if (record.type === "characterData" || record.type === "childList") processTextMutation(record);
      if (record.type === "childList") {
        for (const node of record.removedNodes) reportRemoved(node);
        for (const node of record.addedNodes) reportAdded(node);
      }
    }
  };

  const enqueue = (records: MutationRecord[]): void => {
    if (stopped || records.length === 0) return;
    pending.push(...records);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };

  establishBaseline();
  for (const root of roots) {
    const observer = new MutationObserver((records) => enqueue(records));
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
    observers.push(observer);
  }

  return {
    refresh(): void {
      if (stopped) throw new Error("Cannot refresh a stopped Semantic DOM Sentinel controller.");
      for (const observer of observers) observer.takeRecords();
      pending = [];
      establishBaseline();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      pending = [];
      for (const observer of observers) observer.disconnect();
    },
  };
}
