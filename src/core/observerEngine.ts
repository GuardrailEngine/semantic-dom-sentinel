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

  const observationRoots = roots.filter((root) =>
    !roots.some((candidate) => candidate !== root && candidate.contains(root)),
  );

  let fingerprints = new WeakMap<Element, Map<string, DomFingerprint>>();
  let activeRules = new WeakMap<Element, Set<string>>();
  let baselineRisky = new WeakSet<Element>();
  let seenRisky = new WeakSet<Element>();
  const nodeIds = new WeakMap<Element, string>();
  let nextNodeId = 1;
  let nextAlertId = 1;
  let pending: MutationRecord[] = [];
  let scheduled = false;
  let stopped = false;
  let flushing = false;
  let abortCurrentBatch = false;
  const observers: Observer[] = [];

  const canContinueBatch = (): boolean => !stopped && !abortCurrentBatch;

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
    attribute?: string,
  ): void => {
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
      baselineRisky.delete(element);
      seenRisky.delete(element);
      for (const rule of options.rules) {
        const active = activeRules.get(element);
        if (!active?.has(rule.id) || !fingerprints.get(element)?.has(rule.id)) continue;
        active.delete(rule.id);
        emit(element, "protected-element-removed", rule.id, rule.selector);
        if (!canContinueBatch()) return;
      }
    }
  };

  const reportAdded = (node: Node): void => {
    for (const element of elementsIn(node)) {
      for (const selector of riskySelectors) {
        if (!element.matches(selector) || baselineRisky.has(element) || seenRisky.has(element)) continue;
        seenRisky.add(element);
        emit(element, "risky-element-added", BUILTIN_RULE_ID, selector);
        if (!canContinueBatch()) return;
        break;
      }
      for (const rule of options.rules) {
        if (!canContinueBatch()) return;
        if (!element.matches(rule.selector)) continue;
        const active = activeRules.get(element);
        const known = fingerprints.get(element)?.has(rule.id) ?? false;
        if (active?.has(rule.id)) continue;
        if (!known) storeBaseline(element, rule);
        else active?.add(rule.id);
        emit(element, "protected-element-added", rule.id, rule.selector);
        if (!canContinueBatch()) return;
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

  const updateSelectorMembership = (subtree: Element): void => {
    if (!findRoot(subtree)) return;
    const candidates = [subtree, ...subtree.querySelectorAll("*")];
    for (const element of candidates) {
      for (const rule of options.rules) {
        const active = activeRules.get(element);
        const isActive = active?.has(rule.id) ?? false;
        const matches = element.matches(rule.selector);
        if (matches && !isActive) {
          const known = fingerprints.get(element)?.has(rule.id) ?? false;
          if (!known) {
            storeBaseline(element, rule);
          } else {
            let activeSet = activeRules.get(element);
            if (!activeSet) {
              activeSet = new Set();
              activeRules.set(element, activeSet);
            }
            activeSet.add(rule.id);
          }
          emit(element, "protected-element-added", rule.id, rule.selector);
          if (!canContinueBatch()) return;
        } else if (!matches && isActive) {
          active?.delete(rule.id);
          emit(element, "protected-element-unmatched", rule.id, rule.selector);
          if (!canContinueBatch()) return;
        }
      }
    }
  };

  const processAttribute = (record: MutationRecord, element: Element, nextValue: string | null): void => {
    const attribute = record.attributeName;
    if (!attribute) return;
    for (const rule of options.rules) {
      if (!canContinueBatch()) return;
      if (!activeRules.get(element)?.has(rule.id)) continue;
      if (!watchedAttributes(rule).includes(attribute)) continue;
      const baseline = fingerprints.get(element)?.get(rule.id);
      if (!baseline) continue;
      const current = element.getAttribute(attribute);
      if (!inspectAttributeValues(baseline, rule, attribute, [current]).changed) continue;
      if (record.oldValue === nextValue) continue;
      if (!inspectAttributeValues(baseline, rule, attribute, [nextValue]).changed) continue;
      emit(element, "attribute-changed", rule.id, rule.selector, attribute);
      if (!canContinueBatch()) return;
    }
  };

  const processTextMutation = (record: MutationRecord): void => {
    if (!canContinueBatch()) return;
    for (const rule of options.rules) {
      if (!canContinueBatch()) return;
      if (!rule.watchText) continue;
      const boundary = findRoot(record.target.nodeType === 1
        ? (record.target as Element)
        : record.target.parentElement ?? roots[0]!);
      if (!boundary) continue;
      for (const element of protectedAncestors(record.target, rule, boundary)) {
        const baseline = fingerprints.get(element)?.get(rule.id);
        if (!baseline) continue;
        const text = normalizeText(element.textContent);
        if (isExpectedText(baseline, rule, text)) continue;
        emit(element, "text-changed", rule.id, rule.selector);
        if (!canContinueBatch()) return;
      }
    }
  };

  const flush = (): void => {
    scheduled = false;
    if (stopped || pending.length === 0) return;
    const records = pending;
    pending = [];
    const attributeGroups = new Map<Element, Map<string, MutationRecord[]>>();
    for (const record of records) {
      if (record.type !== "attributes" || record.target.nodeType !== 1 || !record.attributeName) continue;
      const element = record.target as Element;
      let attributes = attributeGroups.get(element);
      if (!attributes) {
        attributes = new Map();
        attributeGroups.set(element, attributes);
      }
      const attributeRecords = attributes.get(record.attributeName) ?? [];
      attributeRecords.push(record);
      attributes.set(record.attributeName, attributeRecords);
    }
    const nextAttributeValues = new Map<MutationRecord, string | null>();
    for (const [element, attributes] of attributeGroups) {
      for (const [attribute, attributeRecords] of attributes) {
        for (const [index, record] of attributeRecords.entries()) {
          const nextRecord = attributeRecords[index + 1];
          nextAttributeValues.set(record, nextRecord ? nextRecord.oldValue : element.getAttribute(attribute));
        }
      }
    }

    const membershipSubtrees = new Set<Element>();
    flushing = true;
    abortCurrentBatch = false;
    try {
      for (const record of records) {
        if (!canContinueBatch()) return;
        if (record.type === "attributes" && record.target.nodeType === 1) {
          const element = record.target as Element;
          const nextValue = nextAttributeValues.has(record)
            ? nextAttributeValues.get(record) ?? null
            : element.getAttribute(record.attributeName ?? "");
          processAttribute(record, element, nextValue);
          membershipSubtrees.add(element);
        }
        if (record.type === "characterData" || record.type === "childList") processTextMutation(record);
        if (!canContinueBatch()) return;
        if (record.type === "childList") {
          for (const node of record.removedNodes) {
            reportRemoved(node);
            if (!canContinueBatch()) return;
          }
          for (const node of record.addedNodes) {
            reportAdded(node);
            if (!canContinueBatch()) return;
          }
        }
      }
      for (const subtree of membershipSubtrees) {
        if (!canContinueBatch()) return;
        updateSelectorMembership(subtree);
      }
    } finally {
      flushing = false;
      abortCurrentBatch = false;
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
  for (const root of observationRoots) {
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
      if (flushing) abortCurrentBatch = true;
      for (const observer of observers) observer.takeRecords();
      pending = [];
      establishBaseline();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (flushing) abortCurrentBatch = true;
      pending = [];
      for (const observer of observers) {
        observer.takeRecords();
        observer.disconnect();
      }
    },
  };
}
