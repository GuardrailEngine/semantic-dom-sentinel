import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { InspectorOverlay, SentinelAlert, SentinelController, SentinelOptions, SentinelReason } from "../../src/types.js";

const bundle = readFileSync(resolve(process.cwd(), "dist/index.global.js"), "utf8");

// “Positive” means the fixture violates this test's explicit monitoring policy,
// not that it represents a real attack.
type CorpusOperation =
  | "unexpected-attribute"
  | "text-changed"
  | "protected-element-added"
  | "protected-element-removed"
  | "protected-element-unmatched"
  | "risky-element-added"
  | "allowed-value"
  | "unwatched-attribute"
  | "outside-root"
  | "same-batch-revert"
  | "risky-node-in-baseline";

type CorpusScenario = {
  id: string;
  expectedReasons: readonly SentinelReason[];
  operation: CorpusOperation;
  baselineRiskyNode?: boolean;
};

declare global {
  interface Window {
    SemanticDomSentinel: {
      createSentinel: (options: SentinelOptions) => SentinelController;
      mountInspectorOverlay: (host?: HTMLElement, title?: string) => InspectorOverlay;
    };
  }
}

const corpus: readonly CorpusScenario[] = [
  { id: "unexpected-watched-attribute", operation: "unexpected-attribute", expectedReasons: ["attribute-changed"] },
  { id: "watched-text-change", operation: "text-changed", expectedReasons: ["text-changed"] },
  { id: "matching-element-added", operation: "protected-element-added", expectedReasons: ["protected-element-added"] },
  { id: "matching-element-removed", operation: "protected-element-removed", expectedReasons: ["protected-element-removed"] },
  { id: "selector-membership-lost", operation: "protected-element-unmatched", expectedReasons: ["protected-element-unmatched"] },
  { id: "risky-element-added", operation: "risky-element-added", expectedReasons: ["risky-element-added"] },
  { id: "allowlisted-value", operation: "allowed-value", expectedReasons: [] },
  { id: "unwatched-attribute", operation: "unwatched-attribute", expectedReasons: [] },
  { id: "mutation-outside-root", operation: "outside-root", expectedReasons: [] },
  { id: "same-batch-revert", operation: "same-batch-revert", expectedReasons: [] },
  {
    id: "risky-element-already-in-baseline",
    operation: "risky-node-in-baseline",
    baselineRiskyNode: true,
    expectedReasons: [],
  },
];

const LATENCY_REPETITIONS = 12;
const BASELINE_ELEMENT_COUNT = 1_000;
const BASELINE_WARMUPS = 3;
const BASELINE_REPETITIONS = 20;

test("classifies the detection corpus and measures browser baseline and callback timing", async ({ page }, testInfo) => {
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ content: bundle });

  const browserResults = await page.evaluate(async ({ cases, latencyRepetitions, baselineElementCount, baselineWarmups, baselineRepetitions }) => {
    type ScenarioRun = {
      alertReasons: SentinelReason[];
      callbackLatencyMs: number | null;
    };
    type ClassificationRun = {
      scenarioId: string;
      expectedAlert: boolean;
      actualAlert: boolean;
      expectedReasons: SentinelReason[];
      actualReasons: SentinelReason[];
    };

    async function runScenario(scenario: CorpusScenario): Promise<ScenarioRun> {
      const root = document.createElement("main");
      root.innerHTML = `<button id="pay" class="pay" type="submit" formaction="/pay">Pay securely</button>${scenario.baselineRiskyNode ? '<iframe title="baseline frame"></iframe>' : ""}`;
      const outside = document.createElement("aside");
      outside.innerHTML = '<button class="pay" type="submit" formaction="/pay">Outside</button>';
      document.body.replaceChildren(root, outside);

      const alerts: SentinelAlert[] = [];
      let firstCallbackAt: number | null = null;
      const options: SentinelOptions = {
        roots: [root],
        rules: [
          {
            id: "payment-button",
            selector: "button.pay",
            watchAttributes: ["type", "formaction"],
            allowAttributeValues: { type: ["button"] },
            watchText: true,
          },
        ],
        onAlert: (alert) => {
          alerts.push(alert);
          firstCallbackAt ??= performance.now();
        },
      };
      const controller = window.SemanticDomSentinel.createSentinel(options);
      const button = root.querySelector<HTMLButtonElement>("#pay");
      const outsideButton = outside.querySelector<HTMLButtonElement>("button");
      if (!button || !outsideButton) throw new Error("Corpus fixture is incomplete");

      const mutationStartedAt = performance.now();
      switch (scenario.operation) {
        case "unexpected-attribute":
          button.setAttribute("formaction", "/unexpected");
          break;
        case "text-changed":
          button.textContent = "Continue elsewhere";
          break;
        case "protected-element-added": {
          const added = document.createElement("button");
          added.className = "pay";
          added.type = "submit";
          added.textContent = "New payment button";
          root.append(added);
          break;
        }
        case "protected-element-removed":
          button.remove();
          break;
        case "protected-element-unmatched":
          button.classList.remove("pay");
          break;
        case "risky-element-added": {
          const frame = document.createElement("iframe");
          frame.title = "new frame";
          root.append(frame);
          break;
        }
        case "allowed-value":
          button.setAttribute("type", "button");
          break;
        case "unwatched-attribute":
          button.setAttribute("title", "ordinary UI metadata");
          break;
        case "outside-root":
          outsideButton.setAttribute("formaction", "/unexpected");
          break;
        case "same-batch-revert":
          button.setAttribute("formaction", "/temporary");
          button.setAttribute("formaction", "/pay");
          break;
        case "risky-node-in-baseline":
          button.setAttribute("title", "ordinary UI metadata");
          break;
      }

      // MutationObserver callbacks run before this timer; the callback timestamp
      // is captured inside the page, so timer scheduling does not enter latency.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      controller.stop();
      return {
        alertReasons: alerts.map((alert) => alert.reason),
        callbackLatencyMs: firstCallbackAt === null ? null : firstCallbackAt - mutationStartedAt,
      };
    }

    function measureLargeBaseline(): number[] {
      const root = document.createElement("main");
      root.innerHTML = Array.from(
        { length: baselineElementCount },
        (_, index) => `<button class="watched" data-index="${index}" type="submit">Pay</button>`,
      ).join("");
      document.body.replaceChildren(root);
      const options: SentinelOptions = {
        roots: [root],
        rules: [{ id: "all-watched-buttons", selector: "button.watched", watchAttributes: ["type"] }],
        onAlert: () => undefined,
      };
      for (let index = 0; index < baselineWarmups; index += 1) {
        window.SemanticDomSentinel.createSentinel(options).stop();
      }
      const samples: number[] = [];
      for (let index = 0; index < baselineRepetitions; index += 1) {
        const startedAt = performance.now();
        const controller = window.SemanticDomSentinel.createSentinel(options);
        samples.push(performance.now() - startedAt);
        controller.stop();
      }
      root.remove();
      return samples;
    }

    const classifications: ClassificationRun[] = [];
    const latencySamples: Record<string, number[]> = {};
    for (const scenario of cases) {
      const run = await runScenario(scenario);
      classifications.push({
        scenarioId: scenario.id,
        expectedAlert: scenario.expectedReasons.length > 0,
        actualAlert: run.alertReasons.length > 0,
        expectedReasons: [...scenario.expectedReasons],
        actualReasons: run.alertReasons,
      });
      if (scenario.expectedReasons.length > 0) {
        const samples: number[] = [];
        if (run.callbackLatencyMs !== null) samples.push(run.callbackLatencyMs);
        for (let repetition = 1; repetition < latencyRepetitions; repetition += 1) {
          const measured = await runScenario(scenario);
          if (measured.callbackLatencyMs !== null) samples.push(measured.callbackLatencyMs);
        }
        latencySamples[scenario.id] = samples;
      }
    }

    return {
      classifications,
      latencySamples,
      baselineSamples: measureLargeBaseline(),
    };
  }, {
    cases: corpus,
    latencyRepetitions: LATENCY_REPETITIONS,
    baselineElementCount: BASELINE_ELEMENT_COUNT,
    baselineWarmups: BASELINE_WARMUPS,
    baselineRepetitions: BASELINE_REPETITIONS,
  });

  const confusion = { TP: 0, FP: 0, FN: 0, TN: 0 };
  for (const scenario of browserResults.classifications) {
    if (scenario.expectedAlert && scenario.actualAlert) confusion.TP += 1;
    else if (!scenario.expectedAlert && scenario.actualAlert) confusion.FP += 1;
    else if (scenario.expectedAlert && !scenario.actualAlert) confusion.FN += 1;
    else confusion.TN += 1;
  }

  const nearestRank = (samples: readonly number[], quantile: number): number => {
    const sorted = [...samples].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
  };
  const summarize = (samples: readonly number[]) => {
    const sorted = [...samples].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : sorted[middle] ?? 0;
    return {
      samples: sorted.length,
      medianMs: Number(median.toFixed(3)),
      p95Ms: Number(nearestRank(sorted, 0.95).toFixed(3)),
      minMs: Number((sorted[0] ?? 0).toFixed(3)),
      maxMs: Number((sorted.at(-1) ?? 0).toFixed(3)),
    };
  };

  const report = {
    browser: testInfo.project.name,
    corpusScenarioCount: browserResults.classifications.length,
    confusion,
    scenarios: browserResults.classifications,
    baselineCapture: {
      matchingElements: BASELINE_ELEMENT_COUNT,
      warmupRuns: BASELINE_WARMUPS,
      ...summarize(browserResults.baselineSamples),
    },
    mutationToFirstCallback: Object.fromEntries(
      Object.entries(browserResults.latencySamples).map(([scenarioId, samples]) => [scenarioId, summarize(samples)]),
    ),
    interpretation: "Synthetic policy corpus and engine-specific timing observations; not comprehensive security evidence.",
  };

  console.info(`[detection-corpus] ${JSON.stringify(report)}`);
  await testInfo.attach(`detection-corpus-${testInfo.project.name}.json`, {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });

  for (const scenario of browserResults.classifications) {
    expect(scenario.actualReasons, `Unexpected alert classification for ${scenario.scenarioId}`).toEqual(scenario.expectedReasons);
  }
  expect(confusion.FP).toBe(0);
  expect(confusion.FN).toBe(0);
  expect(confusion.TP).toBe(6);
  expect(confusion.TN).toBe(5);
  expect(browserResults.baselineSamples).toHaveLength(BASELINE_REPETITIONS);
  for (const scenario of corpus.filter((item) => item.expectedReasons.length > 0)) {
    expect(browserResults.latencySamples[scenario.id]).toHaveLength(LATENCY_REPETITIONS);
  }
});
