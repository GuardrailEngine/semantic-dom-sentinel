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

  let fingerprints = new WeakMap<Element, Map<string, DomFingerprint>>();
  let lastObservedStates = new WeakMap<Element, Map<string, DomFingerprint>>();
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

  const rememberCurrentState = (element: Element, rule: ProtectionRule): void => {
    let snapshots = lastObservedStates.get(element);
    if (!snapshots) {
      snapshots = new Map();
      lastObservedStates.set(element, snapshots);
    }
    snapshots.set(rule.id, currentFingerprint(element, rule));
  };

  const rememberAttributeState = (
    element: Element,
    rule: ProtectionRule,
    attribute: string,
    value: string | null,
  ): void => {
    let snapshots = lastObservedStates.get(element);
    if (!snapshots) {
      snapshots = new Map();
      lastObservedStates.set(element, snapshots);
    }
    const previous = snapshots.get(rule.id) ?? fingerprints.get(element)?.get(rule.id);
    if (!previous) return;
    snapshots.set(rule.id, {
      ...previous,
      attributes: { ...previous.attributes, [attribute]: value },
    });
  };

  const rememberTextState = (element: Element, rule: ProtectionRule, text: string): void => {
    let snapshots = lastObservedStates.get(element);
    if (!snapshots) {
      snapshots = new Map();
      lastObservedStates.set(element, snapshots);
    }
    const previous = snapshots.get(rule.id) ?? fingerprints.get(element)?.get(rule.id);
    if (!previous) return;
    snapshots.set(rule.id, { ...previous, text });
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
    rememberCurrentState(element, rule);
    let active = activeRules.get(element);
    if (!active) {
      active = new Set();
      activeRules.set(element, active);
    }
    active.add(rule.id);
  };

  const establishBaseline = (): void => {
    fingerprints = new WeakMap();
    lastObservedStates = new WeakMap();
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

  const isInScope = (element: Element): boolean =>
    roots.some((root) => root === element || root.contains(element));

  const isWithinSuppliedRoot = (node: Node): boolean =>
    roots.some((root) => root === node || root.contains(node));

  const isRetainedByRootInsideSubtree = (subtree: Node, element: Element): boolean =>
    roots.some((root) => {
      const rootIsInSubtree = root === subtree ||
        (subtree.nodeType === 1 && (subtree as Element).contains(root));
      return rootIsInSubtree && (root === element || root.contains(element));
    });

  const reportRemoved = (node: Node): void => {
    for (const element of elementsIn(node)) {
      // A move between supplied roots does not leave the union scope.
      if (isInScope(element)) continue;
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

  const reconcileReactivatedElement = (
    element: Element,
    rule: ProtectionRule,
    records: readonly MutationRecord[],
    addedRecordIndex: number,
    onlyUnrecordedChanges: boolean,
  ): void => {
    const baseline = fingerprints.get(element)?.get(rule.id);
    if (!baseline) return;
    const previous = lastObservedStates.get(element)?.get(rule.id) ?? baseline;

    for (const attribute of watchedAttributes(rule)) {
      const hasAttributeRecord = records.some((record) =>
        record.type === "attributes" && record.target === element && record.attributeName === attribute,
      );
      if (onlyUnrecordedChanges && hasAttributeRecord) continue;
      const firstPostEntryChange = records.find((record, index) =>
        index > addedRecordIndex &&
        record.type === "attributes" &&
        record.target === element &&
        record.attributeName === attribute,
      );
      const currentValue = firstPostEntryChange
        ? firstPostEntryChange.oldValue
        : element.getAttribute(attribute);
      if (previous.attributes[attribute] === currentValue) continue;
      if (!inspectAttributeValues(baseline, rule, attribute, [currentValue]).changed) continue;
      emit(element, "attribute-changed", rule.id, rule.selector, attribute);
      if (!canContinueBatch()) return;
    }

    if (!rule.watchText) {
      rememberCurrentState(element, rule);
      return;
    }
    const textMutation = (record: MutationRecord): boolean =>
      (record.type === "characterData" || record.type === "childList") &&
      (record.target === element || element.contains(record.target));
    const hasTextRecord = onlyUnrecordedChanges
      ? records.some(textMutation)
      : records.some((record, index) => index > addedRecordIndex && textMutation(record));
    if (hasTextRecord) {
      rememberCurrentState(element, rule);
      return;
    }
    const text = normalizeText(element.textContent);
    if (previous.text !== text && !isExpectedText(baseline, rule, text)) {
      emit(element, "text-changed", rule.id, rule.selector);
    }
    rememberCurrentState(element, rule);
  };

  const reportAdded = (
    node: Node,
    records: readonly MutationRecord[],
    addedRecordIndex: number,
    returnedFromThisAdd: WeakSet<Element>,
  ): void => {
    for (const element of elementsIn(node)) {
      if (!isInScope(element)) continue;
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
        if (active?.has(rule.id)) {
          reconcileReactivatedElement(
            element,
            rule,
            records,
            addedRecordIndex,
            !returnedFromThisAdd.has(element),
          );
          if (!canContinueBatch()) return;
          continue;
        }
        if (!known) storeBaseline(element, rule);
        else {
          let activeSet = activeRules.get(element);
          if (!activeSet) {
            activeSet = new Set();
            activeRules.set(element, activeSet);
          }
          activeSet.add(rule.id);
        }
        emit(element, "protected-element-added", rule.id, rule.selector);
        if (!canContinueBatch()) return;
        if (known) reconcileReactivatedElement(element, rule, records, addedRecordIndex, false);
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

  const findRoot = (element: Element): Element | undefined => {
    const containingRoots = roots.filter((root) => root === element || root.contains(element));
    return containingRoots.find((root) =>
      !containingRoots.some((candidate) => candidate !== root && candidate.contains(root)),
    );
  };

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
          rememberCurrentState(element, rule);
        } else if (!matches && isActive) {
          active?.delete(rule.id);
          emit(element, "protected-element-unmatched", rule.id, rule.selector);
          if (!canContinueBatch()) return;
          rememberCurrentState(element, rule);
        }
      }
    }
  };

  const processAttribute = (
    record: MutationRecord,
    element: Element,
    nextValue: string | null,
    temporarilyOutOfScope: WeakSet<Element>,
  ): void => {
    const attribute = record.attributeName;
    if (!attribute || temporarilyOutOfScope.has(element)) return;
    for (const rule of options.rules) {
      if (!canContinueBatch()) return;
      if (!activeRules.get(element)?.has(rule.id)) continue;
      if (!watchedAttributes(rule).includes(attribute)) continue;
      const baseline = fingerprints.get(element)?.get(rule.id);
      if (!baseline) continue;
      const current = element.getAttribute(attribute);
      const currentIsUnexpected = inspectAttributeValues(baseline, rule, attribute, [current]).changed;
      const nextIsUnexpected = inspectAttributeValues(baseline, rule, attribute, [nextValue]).changed;
      if (currentIsUnexpected && record.oldValue !== nextValue && nextIsUnexpected) {
        emit(element, "attribute-changed", rule.id, rule.selector, attribute);
        if (!canContinueBatch()) return;
      }
      // If the element ends this batch outside the roots and no later record
      // establishes an in-scope value, do not accept its final detached state.
      if (isInScope(element) || nextValue !== current) {
        rememberAttributeState(element, rule, attribute, nextValue);
      }
    }
  };

  const processTextMutation = (
    record: MutationRecord,
    temporarilyOutOfScope: WeakSet<Element>,
    elementsWithTemporaryExit: WeakSet<Element>,
    returnedFromScope: WeakSet<Element>,
  ): void => {
    if (!canContinueBatch()) return;
    for (const rule of options.rules) {
      if (!canContinueBatch()) return;
      if (!rule.watchText) continue;
      const boundary = findRoot(record.target.nodeType === 1
        ? (record.target as Element)
        : record.target.parentElement ?? roots[0]!);
      if (!boundary) continue;
      for (const element of protectedAncestors(record.target, rule, boundary)) {
        if (temporarilyOutOfScope.has(element)) continue;
        if (elementsWithTemporaryExit.has(element) && !returnedFromScope.has(element)) continue;
        const baseline = fingerprints.get(element)?.get(rule.id);
        if (!baseline) continue;
        const text = normalizeText(element.textContent);
        if (!isExpectedText(baseline, rule, text)) {
          emit(element, "text-changed", rule.id, rule.selector);
          if (!canContinueBatch()) return;
        }
        if (isInScope(element)) rememberTextState(element, rule, text);
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

    const temporarilyOutOfScope = new WeakSet<Element>();
    const elementsWithTemporaryExit = new WeakSet<Element>();
    const returnedFromScope = new WeakSet<Element>();
    for (const record of records) {
      if (record.type !== "childList") continue;
      for (const node of record.removedNodes) {
        for (const element of elementsIn(node)) {
          if (isInScope(element) && !isRetainedByRootInsideSubtree(node, element)) {
            elementsWithTemporaryExit.add(element);
          }
        }
      }
    }

    const membershipSubtrees = new Set<Element>();
    flushing = true;
    abortCurrentBatch = false;
    try {
      for (const [recordIndex, record] of records.entries()) {
        if (!canContinueBatch()) return;
        if (record.type === "attributes" && record.target.nodeType === 1) {
          const element = record.target as Element;
          const nextValue = nextAttributeValues.has(record)
            ? nextAttributeValues.get(record) ?? null
            : element.getAttribute(record.attributeName ?? "");
          processAttribute(record, element, nextValue, temporarilyOutOfScope);
          membershipSubtrees.add(element);
        }
        if (record.type === "characterData" || record.type === "childList") {
          processTextMutation(
            record,
            temporarilyOutOfScope,
            elementsWithTemporaryExit,
            returnedFromScope,
          );
        }
        if (!canContinueBatch()) return;
        if (record.type === "childList") {
          for (const node of record.removedNodes) {
            for (const element of elementsIn(node)) {
              if (!isRetainedByRootInsideSubtree(node, element)) temporarilyOutOfScope.add(element);
            }
            reportRemoved(node);
            if (!canContinueBatch()) return;
            if (node.nodeType === 1 && isInScope(node as Element)) membershipSubtrees.add(node as Element);
          }
          for (const node of record.addedNodes) {
            const returnedFromThisAdd = new WeakSet<Element>();
            if (isWithinSuppliedRoot(record.target)) {
              for (const element of elementsIn(node)) {
                if (!temporarilyOutOfScope.delete(element)) continue;
                returnedFromThisAdd.add(element);
                returnedFromScope.add(element);
              }
            }
            reportAdded(node, records, recordIndex, returnedFromThisAdd);
            if (!canContinueBatch()) return;
            if (node.nodeType === 1 && isInScope(node as Element)) membershipSubtrees.add(node as Element);
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
  const observer = new MutationObserver((records) => enqueue(records));
  for (const root of roots) {
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
  }
  observers.push(observer);

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
