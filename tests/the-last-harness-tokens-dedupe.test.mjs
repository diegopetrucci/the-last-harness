import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { analyzeSessionEntries } = await jiti.import(
  "../extensions/the-last-harness/tokens-analyzer.ts",
);

const CHILD_USAGE = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { total: 0.5 },
};
const PRIMARY_USAGE = {
  ...CHILD_USAGE,
  input: 10,
  output: 5,
  totalTokens: 15,
  cost: { total: 0.1 },
};

const resultsView = () => [
  {
    agent: "worker",
    task: "synthetic task",
    exitCode: 0,
    usage: { ...CHILD_USAGE, turns: 1 },
    model: "m-child",
    artifactPaths: {},
    sessionFile: "/tmp/synthetic/child.jsonl",
    toolCalls: [],
  },
];
const telemetryView = () => ({
  schemaVersion: 1,
  run: { runId: "run-1", mode: "single", agent: "worker" },
  steps: [
    {
      index: 0,
      agent: "worker",
      model: "m-child",
      usage: { ...CHILD_USAGE, turns: 1 },
      activity: {},
      timing: {},
      outcome: {},
    },
  ],
  usage: { ...CHILD_USAGE, turns: 1 },
  timing: {},
  outcome: {},
  provenance: {},
  controls: {},
});

function analyze(details, extra = []) {
  return analyzeSessionEntries(
    [
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-05-01T10:00:00Z",
        message: {
          role: "assistant",
          provider: "p",
          model: "m",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "tc1", name: "subagent", arguments: {} }],
          usage: PRIMARY_USAGE,
        },
      },
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-05-01T10:00:05Z",
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "subagent",
          isError: false,
          content: [{ type: "text", text: "ok" }],
          details,
        },
      },
      ...extra,
    ],
    {},
  );
}

for (const [name, details] of [
  ["results + telemetry", { results: resultsView(), telemetry: telemetryView() }],
  ["results only", { results: resultsView() }],
  ["telemetry only", { telemetry: telemetryView() }],
]) {
  test(`subagent usage is counted once for ${name}`, () => {
    const report = analyze(details);
    assert.equal(report.totals.subagents.totalTokens, 120);
    assert.equal(report.totals.subagents.costUsd, 0.5);
  });
}

test("compaction and branch_summary usage is non-turn primary spend", () => {
  const base = analyze({ results: resultsView() });
  const report = analyze({ results: resultsView() }, [
    {
      type: "compaction",
      id: "c1",
      parentId: "r1",
      timestamp: "2026-05-01T10:01:00Z",
      summary: "s",
      usage: CHILD_USAGE,
    },
    {
      type: "branch_summary",
      id: "b1",
      parentId: "c1",
      timestamp: "2026-05-01T10:02:00Z",
      summary: "s",
      usage: CHILD_USAGE,
    },
  ]);
  assert.equal(report.totals.primary.totalTokens, base.totals.primary.totalTokens + 240);
  assert.equal(report.totals.combined.totalTokens, base.totals.combined.totalTokens + 240);
  assert.equal(report.totals.primary.turns, base.totals.primary.turns);
  assert.equal(report.totals.primary.assistantMessages, base.totals.primary.assistantMessages);
  // Summary spend gets its own non-turn bucket; primary totals are unchanged.
  assert.equal(report.primaryAssistant.summaryUsage.totalTokens, 240);
  assert.equal(report.primaryAssistant.summaryUsage.costUsd, 1);
  assert.equal(report.primaryAssistant.summaryUsage.turns, 0);
  assert.equal(report.primaryAssistant.summaryUsage.assistantMessages, 0);
  assert.equal(report.primaryAssistant.cacheWarmUsage.totalTokens, 0);
  assert.equal(base.primaryAssistant.summaryUsage.totalTokens, 0);
});
