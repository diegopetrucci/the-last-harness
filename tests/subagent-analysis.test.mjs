import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSubagentSessions, scanSessionFile } from "../scripts/lib/session-analysis.mjs";
import {
  mergeTelemetrySnapshots,
  parseNormalizedTelemetry,
} from "../scripts/lib/subagent-analysis-parser.mjs";
import {
  BACKGROUND_COMPLETION_NUDGE,
  CONTROL_NOTICE_NUDGE,
} from "../scripts/lib/subagent-analysis-wakeup.mjs";
import {
  BACKGROUND_COMPLETION_NUDGE_TEXT,
  CONTROL_NOTICE_NUDGE_TEXT,
} from "../extensions/subagents/src/runs/shared/nudge-texts.js";
import {
  assistantMessageLine,
  completionBatchMessage,
  messageEntry,
  sessionHeader,
  telemetryEnvelope,
  toolResultLine,
  writeFixture,
} from "./session-analysis-fixtures.mjs";

function freezeDeep(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// Subagent analysis tests
// ---------------------------------------------------------------------------

test("subagent analysis wakeup literals match runtime nudge constants", () => {
  assert.equal(BACKGROUND_COMPLETION_NUDGE, BACKGROUND_COMPLETION_NUDGE_TEXT);
  assert.equal(CONTROL_NOTICE_NUDGE, CONTROL_NOTICE_NUDGE_TEXT);
});

test("subagent analysis: deduplicates telemetry and attributes only the immediate wakeup turn", async (t) => {
  const foregroundTelemetry = telemetryEnvelope("run-foreground", "foreground", {
    agent: "code-agent",
    outcome: { state: "completed", terminationReason: "completed" },
  });
  const asyncTelemetry = telemetryEnvelope("run-async", "async", {
    agent: "review-agent",
    index: 1,
    outcome: { state: "running" },
  });
  asyncTelemetry.lineage = {
    continuationFrom: { sourceRunId: "run-foreground", sourceStepIndex: 0 },
  };
  const completedAsyncTelemetry = {
    ...asyncTelemetry,
    outcome: { state: "completed", terminationReason: "completed" },
  };

  const filePath = writeFixture(t, [
    sessionHeader("subagent-analysis"),
    messageEntry({
      role: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: "launch-foreground",
          arguments: { agent: "code-agent", task: "do not emit this task" },
        },
      ],
    }),
    toolResultLine("2026-01-01T00:00:01.000Z", "launch-foreground", "subagent", {
      details: { runId: "run-foreground", telemetry: foregroundTelemetry },
    }),
    messageEntry({
      role: "assistant",
      timestamp: "2026-01-01T00:00:02.000Z",
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: "launch-async",
          arguments: { agent: "review-agent", task: "hidden task", async: true },
        },
      ],
    }),
    toolResultLine("2026-01-01T00:00:03.000Z", "launch-async", "subagent", {
      details: { runId: "run-async", asyncId: "run-async", telemetry: asyncTelemetry },
    }),
    messageEntry({
      role: "custom",
      customType: "subagent-notify",
      content: "Background task completed: hidden output /private/path",
      details: {
        agent: "review-agent",
        status: "completed",
        asyncId: "run-async",
        resultPreview: "hidden output",
        telemetry: completedAsyncTelemetry,
      },
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
    messageEntry({
      role: "assistant",
      usage: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.75 },
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: "management-status",
          arguments: { action: "status", id: "run-async", message: "hidden guidance" },
        },
        {
          type: "toolCall",
          toolName: "other-tool",
          toolCallId: "not-a-management-call",
          arguments: { action: "status", id: "run-async" },
        },
      ],
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.runs.length, 2);
  assert.match(output.runs.find((run) => run.execution === "foreground")?.runId ?? "", /^run-\d+$/);
  assert.match(output.runs.find((run) => run.execution === "async")?.runId ?? "", /^run-\d+$/);
  assert.equal(output.aggregates.usage.costUsd, 0.51, "duplicate snapshots must not double cost");
  assert.equal(output.operations.launches.total, 2);
  assert.equal(output.operations.launches.foreground, 1);
  assert.equal(output.operations.launches.async, 1);
  assert.equal(output.operations.management.total, 1);
  assert.equal(output.operations.management.byAction.status, 1);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.wakeups[0]?.managementCalls.byAction.status, 1);
  assert.equal(output.wakeups[0]?.assistantUsage?.costUsd, 0.75);
  assert.equal(output.aggregates.attributedWakeupUsage.costUsd, 0.75);
  assert.equal(output.lineage.continuationEdges.length, 1);
  assert.equal(
    output.lineage.continuationEdges[0]?.sourceRunId,
    output.runs.find((run) => run.execution === "foreground")?.runId,
  );
  assert.equal(
    output.lineage.continuationEdges[0]?.continuationRunId,
    output.runs.find((run) => run.execution === "async")?.runId,
  );
  assert.equal(output.coverage.telemetry.recordsValid, 3);
  assert.ok(output.coverage.telemetry.recordsDeduplicated >= 1);
  assert.equal(output.coverage.wakeups.attributed, 1);
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes("/private/path"));
  assert.ok(!serialized.includes("hidden task"));
  assert.ok(!serialized.includes("hidden output"));
  assert.ok(!serialized.includes("hidden guidance"));
  assert.ok(!serialized.includes("run-foreground"));
  assert.ok(!serialized.includes("run-async"));
});

test("subagent analysis: preserves aggregate fallback usage without charging the final model", async (t) => {
  const initialTelemetry = telemetryEnvelope("fallback-report-run", "async", {
    agent: "fallback-agent",
    outcome: { state: "running" },
  });
  const finalTelemetry = telemetryEnvelope("fallback-report-run", "async", {
    agent: "fallback-agent",
    outcome: { state: "completed", terminationReason: "completed" },
  });
  delete finalTelemetry.steps[0].model;

  const olderSnapshot = parseNormalizedTelemetry(initialTelemetry);
  const newerSnapshot = parseNormalizedTelemetry(finalTelemetry);
  assert.ok(olderSnapshot);
  assert.ok(newerSnapshot);
  freezeDeep(olderSnapshot);
  freezeDeep(newerSnapshot);
  const mergedSnapshot = mergeTelemetrySnapshots(olderSnapshot, newerSnapshot);
  assert.equal("model" in mergedSnapshot.steps[0], false);
  assert.ok(olderSnapshot.steps[0]?.model);

  const filePath = writeFixture(t, [
    sessionHeader("subagent-fallback-report"),
    messageEntry({
      role: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: "fallback-launch",
          arguments: { agent: "fallback-agent", task: "redacted" },
        },
      ],
    }),
    toolResultLine("2026-01-01T00:00:01.000Z", "fallback-launch", "subagent", {
      details: { runId: "fallback-report-run", telemetry: initialTelemetry },
    }),
    messageEntry({
      role: "custom",
      customType: "subagent-notify",
      timestamp: "2026-01-01T00:00:02.000Z",
      details: {
        status: "completed",
        asyncId: "fallback-report-run",
        telemetry: finalTelemetry,
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  const beforeAnalysis = structuredClone(scan.entries);
  freezeDeep(scan.entries);
  const output = analyzeSubagentSessions([scan]);
  assert.deepEqual(scan.entries, beforeAnalysis, "snapshot merging must not mutate evidence");
  assert.equal(output.runs.length, 1);
  assert.equal(output.runs[0]?.telemetryRecordCount, 2);
  assert.equal(output.aggregates.usage.costUsd, 0.25);
  const mergedStep = output.runs[0]?.steps[0];
  assert.ok(mergedStep);
  assert.equal("model" in mergedStep, false);
  const modelAggregate = output.aggregates.byModel[JSON.stringify(["anthropic", "claude-test"])];
  assert.ok(modelAggregate);
  assert.equal(modelAggregate.steps, 0);
  assert.equal(modelAggregate.usageReportedSteps, 0);
  assert.deepEqual(modelAggregate.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  });
});

test("subagent analysis: derives duplicate coverage from frozen canonical snapshots", async (t) => {
  const foregroundInitial = telemetryEnvelope("coverage-foreground", "foreground", {
    agent: "foreground-agent",
    outcome: { state: "running" },
  });
  const foregroundUpdate = structuredClone(foregroundInitial);
  const initialStep = foregroundUpdate.steps[0];
  foregroundUpdate.steps.push({
    ...initialStep,
    index: 1,
    agent: "foreground-follow-up",
    usage: {
      ...initialStep.usage,
      inputTokens: initialStep.usage.inputTokens + 1,
      outputTokens: initialStep.usage.outputTokens + 1,
    },
  });
  const asyncInitial = telemetryEnvelope("coverage-async", "async", {
    agent: "async-agent",
    outcome: { state: "completed", terminationReason: "completed" },
  });
  const asyncDuplicate = structuredClone(asyncInitial);
  const invalidTelemetry = {};
  const telemetryToolPair = (callId, timestamp, telemetry) => [
    messageEntry({
      role: "assistant",
      timestamp,
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: callId,
          arguments: { agent: "coverage-agent", task: "redacted" },
        },
      ],
    }),
    toolResultLine(timestamp, callId, "subagent", { details: { telemetry } }),
  ];
  const filePath = writeFixture(t, [
    sessionHeader("subagent-coverage-duplicates"),
    ...telemetryToolPair("foreground-initial", "2026-01-01T00:00:00.000Z", foregroundInitial),
    ...telemetryToolPair("foreground-update", "2026-01-01T00:00:01.000Z", foregroundUpdate),
    ...telemetryToolPair("async-initial", "2026-01-01T00:00:02.000Z", asyncInitial),
    ...telemetryToolPair("async-duplicate", "2026-01-01T00:00:03.000Z", asyncDuplicate),
    ...telemetryToolPair("malformed", "2026-01-01T00:00:04.000Z", invalidTelemetry),
  ]);

  const scan = await scanSessionFile(filePath);
  const beforeAnalysis = structuredClone(scan.entries);
  freezeDeep(scan.entries);
  const output = analyzeSubagentSessions([scan]);

  assert.deepEqual(scan.entries, beforeAnalysis, "coverage analysis must not mutate evidence");
  assert.equal(output.coverage.telemetry.recordsObserved, 5);
  assert.equal(output.coverage.telemetry.recordsValid, 4);
  assert.equal(output.coverage.telemetry.recordsInvalid, 1);
  assert.equal(output.coverage.telemetry.recordsDeduplicated, 2);
  assert.equal(output.coverage.telemetry.uniqueSourceIdentities, 3);
  assert.deepEqual(output.coverage.telemetry.foreground, {
    records: 2,
    validRecords: 2,
    invalidRecords: 0,
    runs: 1,
    runsWithUsage: 1,
    steps: 2,
    stepsWithUsage: 2,
  });
  assert.deepEqual(output.coverage.telemetry.async, {
    records: 2,
    validRecords: 2,
    invalidRecords: 0,
    runs: 1,
    runsWithUsage: 1,
    steps: 1,
    stepsWithUsage: 1,
  });
  assert.deepEqual(output.coverage.telemetry.unknownExecution, {
    records: 1,
    validRecords: 0,
    invalidRecords: 1,
    runs: 0,
    runsWithUsage: 0,
    steps: 0,
    stepsWithUsage: 0,
  });
});

test("subagent analysis: counts nonduplicate telemetry coverage per execution", async (t) => {
  const foregroundTelemetry = telemetryEnvelope("coverage-foreground-unique", "foreground", {
    agent: "foreground-agent",
    index: 0,
    outcome: { state: "completed", terminationReason: "completed" },
  });
  const asyncTelemetry = telemetryEnvelope("coverage-async-unique", "async", {
    agent: "async-agent",
    index: 1,
    outcome: { state: "completed", terminationReason: "completed" },
  });
  const telemetryToolPair = (callId, timestamp, telemetry) => [
    messageEntry({
      role: "assistant",
      timestamp,
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: callId,
          arguments: { agent: "coverage-agent", task: "redacted" },
        },
      ],
    }),
    toolResultLine(timestamp, callId, "subagent", { details: { telemetry } }),
  ];
  const filePath = writeFixture(t, [
    sessionHeader("subagent-coverage-unique"),
    ...telemetryToolPair("foreground-unique", "2026-01-01T00:00:00.000Z", foregroundTelemetry),
    ...telemetryToolPair("async-unique", "2026-01-01T00:00:01.000Z", asyncTelemetry),
  ]);

  const scan = await scanSessionFile(filePath);
  const beforeAnalysis = structuredClone(scan.entries);
  freezeDeep(scan.entries);
  const output = analyzeSubagentSessions([scan]);

  assert.deepEqual(scan.entries, beforeAnalysis, "coverage analysis must not mutate evidence");
  assert.equal(output.coverage.telemetry.recordsObserved, 2);
  assert.equal(output.coverage.telemetry.recordsValid, 2);
  assert.equal(output.coverage.telemetry.recordsInvalid, 0);
  assert.equal(output.coverage.telemetry.recordsDeduplicated, 0);
  assert.equal(output.coverage.telemetry.uniqueSourceIdentities, 2);
  assert.equal(output.coverage.telemetry.foreground.steps, 1);
  assert.equal(output.coverage.telemetry.foreground.stepsWithUsage, 1);
  assert.equal(output.coverage.telemetry.foreground.runs, 1);
  assert.equal(output.coverage.telemetry.foreground.runsWithUsage, 1);
  assert.equal(output.coverage.telemetry.async.steps, 1);
  assert.equal(output.coverage.telemetry.async.stepsWithUsage, 1);
  assert.equal(output.coverage.telemetry.async.runs, 1);
  assert.equal(output.coverage.telemetry.async.runsWithUsage, 1);
});

test("subagent analysis: joins grouped completion chunks once and attributes all runs", async (t) => {
  const firstTelemetry = telemetryEnvelope("batch-run-one", "async", {
    agent: "batch-agent-one",
    outcome: { state: "completed", terminationReason: "completed" },
  });
  const secondTelemetry = telemetryEnvelope("batch-run-two", "async", {
    agent: "batch-agent-two",
    index: 1,
    outcome: { state: "completed", terminationReason: "completed" },
  });
  const batchId = "batch-secret-do-not-export / 42";
  const chunkOne = {
    schemaVersion: 1,
    kind: "subagent_completion_batch",
    batchId,
    batchIndex: 0,
    batchCount: 2,
    triggersTurn: false,
    completions: [
      {
        agent: "batch-agent-one",
        status: "completed",
        asyncId: "legacy-one",
        telemetry: firstTelemetry,
      },
    ],
  };
  const chunkTwo = {
    schemaVersion: 1,
    kind: "subagent_completion_batch",
    batchId,
    batchIndex: 1,
    batchCount: 2,
    triggersTurn: true,
    completions: [
      {
        agent: "batch-agent-two",
        status: "completed",
        asyncId: "legacy-two",
        telemetry: secondTelemetry,
      },
    ],
  };
  const filePath = writeFixture(t, [
    sessionHeader("subagent-grouped"),
    completionBatchMessage(chunkOne, "Background tasks completed (2):"),
    completionBatchMessage(chunkOne),
    completionBatchMessage(chunkTwo),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
    messageEntry({
      role: "assistant",
      usage: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.75 },
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: "grouped-management",
          arguments: { action: "status", id: "batch-run-two" },
        },
      ],
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  assert.ok(!JSON.stringify(scan.entries).includes(batchId));
  const output = analyzeSubagentSessions([scan]);
  assert.equal(output.runs.length, 2);
  assert.equal(output.coverage.telemetry.recordsValid, 2);
  assert.equal(output.aggregates.usage.costUsd, 0.51);
  assert.equal(output.coverage.evidence.completionBatchesObserved, 1);
  assert.equal(output.coverage.evidence.completionBatchesComplete, 1);
  assert.equal(output.coverage.evidence.completionBatchChunksDuplicate, 1);
  assert.equal(output.coverage.evidence.completionBatchEntriesObserved, 2);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.runIds?.length, 2);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.wakeups[0]?.managementCalls.byAction.status, 1);
  assert.equal(output.wakeups[0]?.assistantUsage?.costUsd, 0.75);
  assert.equal(output.aggregates.attributedWakeupUsage.costUsd, 0.75);
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes(batchId));
  assert.ok(!serialized.includes("batch-run-one"));
  assert.ok(!serialized.includes("batch-run-two"));
});

test("subagent analysis: keeps 512/513-entry logical batches intact", async (t) => {
  const entryCount = 513;
  // The runtime logical-batch bound is 512; persisted parser chunks carry 8.
  const entriesPerChunk = 8;
  const logicalBatchEntries = [512, 1];
  const flushId = "persisted-flush-private-id";
  let notificationIndex = 0;
  const notificationLines = [];
  for (const [flushIndex, logicalEntryCount] of logicalBatchEntries.entries()) {
    const batchId = `persisted-logical-batch-${flushIndex}`;
    const batchCount = Math.ceil(logicalEntryCount / entriesPerChunk);
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
      const start = flushIndex * 512 + batchIndex * entriesPerChunk;
      const chunkLength = Math.min(
        entriesPerChunk,
        logicalEntryCount - batchIndex * entriesPerChunk,
      );
      const completions = Array.from({ length: chunkLength }, (_, offset) => {
        const runIndex = start + offset;
        return {
          agent: `batch-agent-${runIndex}`,
          status: "completed",
          asyncId: `persisted-run-${runIndex}`,
          telemetry: telemetryEnvelope(`persisted-run-${runIndex}`, "async", {
            agent: `batch-agent-${runIndex}`,
            index: runIndex,
            outcome: { state: "completed", terminationReason: "completed" },
          }),
        };
      });
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, notificationIndex++)).toISOString();
      notificationLines.push(
        JSON.stringify({
          type: "message",
          message: {
            role: "custom",
            customType: "subagent-notify",
            timestamp,
            content: start === 0 ? "Background tasks completed (513):" : "",
            details: {
              schemaVersion: 1,
              kind: "subagent_completion_batch",
              batchId,
              batchIndex,
              batchCount,
              flushId,
              flushIndex,
              flushCount: logicalBatchEntries.length,
              triggersTurn:
                flushIndex === logicalBatchEntries.length - 1 && batchIndex === batchCount - 1,
              completions,
            },
          },
        }),
      );
    }
  }

  const filePath = writeFixture(t, [
    sessionHeader("subagent-grouped-boundary"),
    ...notificationLines,
    messageEntry({
      role: "user",
      timestamp: "2026-01-01T01:00:00.000Z",
      content: BACKGROUND_COMPLETION_NUDGE,
    }),
    messageEntry({
      role: "assistant",
      timestamp: "2026-01-01T01:00:01.000Z",
      usage: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.75 },
      content: [],
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  assert.equal(scan.projectionGapCount, 0);
  assert.ok(!JSON.stringify(scan.entries).includes(flushId));
  const output = analyzeSubagentSessions([scan]);
  assert.equal(output.runs.length, entryCount);
  assert.equal(output.aggregates.runs, entryCount);
  assert.equal(output.coverage.telemetry.recordsValid, entryCount);
  assert.equal(output.coverage.telemetry.async.steps, entryCount);
  assert.equal(output.coverage.telemetry.async.stepsWithUsage, entryCount);
  assert.equal(output.coverage.telemetry.async.runs, entryCount);
  assert.equal(output.coverage.telemetry.async.runsWithUsage, entryCount);
  assert.equal(output.aggregates.usage.inputTokens, 136458);
  assert.equal(output.aggregates.usage.outputTokens, 141588);
  assert.equal(output.coverage.evidence.completionBatchesObserved, 2);
  assert.equal(output.coverage.evidence.completionBatchesComplete, 2);
  assert.equal(output.coverage.evidence.completionBatchChunksObserved, 65);
  assert.equal(output.coverage.evidence.completionBatchChunksValid, 65);
  assert.equal(output.coverage.evidence.completionBatchChunksInvalid, 0);
  assert.equal(output.coverage.evidence.completionBatchChunksMissing, 0);
  assert.equal(output.coverage.evidence.completionBatchEntriesObserved, entryCount);
  assert.equal(output.coverage.totalProjectionGaps, 0);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.wakeups[0]?.runIds?.length, entryCount);
  assert.equal(output.coverage.wakeups.attributed, 1);
  const projectedBatchIds = [
    ...new Set(
      scan.entries
        .map((entry) => entry.message?.details)
        .filter((details) => details?.kind === "subagent_completion_batch")
        .map((details) => details.batchId),
    ),
  ];
  assert.equal(projectedBatchIds.length, 2);
  assert.equal(new Set(projectedBatchIds).size, projectedBatchIds.length);
});

test("subagent analysis: revokes a late conflicting flush wakeup without touching a later flush", async (t) => {
  const groupedEntry = (batchId, flushId, flushIndex, triggersTurn, runId) =>
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId,
      batchIndex: 0,
      batchCount: 1,
      flushId,
      flushIndex,
      flushCount: 2,
      triggersTurn,
      completions: [
        {
          agent: "late-conflict-agent",
          status: "completed",
          asyncId: runId,
          telemetry: telemetryEnvelope(runId, "async"),
        },
      ],
    });
  const filePath = writeFixture(t, [
    sessionHeader("subagent-grouped-late-conflict"),
    groupedEntry("affected-first", "affected-flush", 0, false, "affected-first-run"),
    groupedEntry("affected-final", "affected-flush", 1, true, "affected-final-run"),
    messageEntry({ role: "user", content: BACKGROUND_COMPLETION_NUDGE }),
    messageEntry({
      role: "assistant",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.75 },
      content: [],
    }),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "unrelated-batch",
      batchIndex: 0,
      batchCount: 1,
      triggersTurn: true,
      completions: [
        {
          agent: "unrelated-agent",
          status: "completed",
          asyncId: "unrelated-run",
          telemetry: telemetryEnvelope("unrelated-run", "async"),
        },
      ],
    }),
    messageEntry({ role: "user", content: BACKGROUND_COMPLETION_NUDGE }),
    messageEntry({
      role: "assistant",
      usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.4 },
      content: [],
    }),
    // The same-index replacement arrives after both attributions and invalidates
    // the overall flush, not just the batch that carried the duplicate.
    groupedEntry("affected-first", "affected-flush", 0, false, "affected-replacement-run"),
    // Repeating the invalidation must not decrement the unrelated wakeup twice.
    groupedEntry("affected-first", "affected-flush", 0, false, "affected-repeat-run"),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.runs.length, 3, "the conflicting replacement must not add a run");
  assert.equal(output.coverage.evidence.completionBatchChunksDuplicate, 1);
  assert.equal(output.coverage.evidence.completionBatchChunksInvalid, 2);
  assert.equal(output.coverage.evidence.completionBatchesIncomplete, 1);
  assert.equal(output.coverage.evidence.completionBatchesComplete, 2);
  assert.equal(output.wakeups.length, 1, "only the unrelated flush should remain");
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.wakeups[0]?.assistantUsage?.costUsd, 0.4);
  assert.equal(output.aggregates.attributedWakeupUsage.costUsd, 0.4);
  assert.equal(output.coverage.wakeups.observed, 1);
  assert.equal(output.coverage.wakeups.attributed, 1);
  assert.equal(output.coverage.wakeups.unattributed, 0);
});

test("subagent analysis: malformed, missing, and legacy grouped entries are covered", async (t) => {
  const telemetry = telemetryEnvelope("mixed-batch-run", "async", {
    outcome: { state: "completed", terminationReason: "completed" },
  });
  const filePath = writeFixture(t, [
    sessionHeader("subagent-grouped-gaps"),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "malformed-batch",
      batchIndex: 0,
      batchCount: 2,
      triggersTurn: true,
      // completions intentionally omitted
    }),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "missing-batch",
      batchIndex: 1,
      batchCount: 2,
      triggersTurn: true,
      completions: [{ agent: "missing-agent", status: "completed", asyncId: "missing-run" }],
    }),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "mixed-batch",
      batchIndex: 0,
      batchCount: 1,
      triggersTurn: true,
      completions: [
        { agent: "mixed-agent", status: "completed", asyncId: "mixed-legacy" },
        { agent: "mixed-agent", status: "completed", asyncId: "mixed-telemetry", telemetry },
      ],
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
    messageEntry({ role: "assistant", usage: { input: 1, output: 1 }, content: [] }),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  // The first missing-batch chunk is reversed (index 1 before index 0), so it
  // invalidates the batch rather than being admitted as a partial state.
  assert.equal(output.coverage.evidence.completionBatchChunksInvalid, 2);
  assert.equal(output.coverage.evidence.completionBatchesIncomplete, 1);
  assert.equal(output.coverage.evidence.completionBatchChunksMissing, 2);
  assert.equal(output.coverage.evidence.completionBatchesMixedLegacy, 1);
  assert.equal(output.coverage.evidence.completionBatchEntriesWithoutTelemetry, 1);
  assert.equal(output.wakeups.length, 1, "only the complete mixed batch should wake once");
  assert.equal(output.coverage.wakeups.unmatchedNudges, 1);
});

test("subagent analysis: grouped batches reject reversed, skipped, and conflicting chunks", async (t) => {
  const batch = (batchId, batchIndex, batchCount, triggersTurn, runId) =>
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId,
      batchIndex,
      batchCount,
      triggersTurn,
      completions: [
        {
          agent: "adversarial-agent",
          status: "completed",
          telemetry: telemetryEnvelope(runId, "async"),
        },
      ],
    });
  const filePath = writeFixture(t, [
    sessionHeader("subagent-grouped-adversarial"),
    // Reversed: index 1 is observed before index 0.
    batch("reversed", 1, 2, true, "reversed-run"),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
    // Skipped: index 2 follows index 0, leaving index 1 unobserved.
    batch("skipped", 0, 3, false, "skipped-run"),
    batch("skipped", 2, 3, true, "skipped-final-run"),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
    // Conflicting duplicate: the same index carries different telemetry.
    batch("conflicting", 0, 2, false, "conflicting-first-run"),
    batch("conflicting", 0, 2, false, "conflicting-replacement-run"),
    batch("conflicting", 1, 2, true, "conflicting-final-run"),
    // A non-final logical batch cannot claim the overall flush wakeup.
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "early-flush-trigger",
      batchIndex: 0,
      batchCount: 1,
      flushId: "early-flush-trigger",
      flushIndex: 0,
      flushCount: 2,
      triggersTurn: true,
      completions: [
        {
          agent: "early-trigger-agent",
          status: "completed",
          telemetry: telemetryEnvelope("early-trigger-run", "async"),
        },
      ],
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 0, "incoherent batches must never register a wakeup");
  assert.equal(output.coverage.wakeups.unmatchedNudges, 3);
  assert.equal(output.coverage.evidence.completionBatchesIncomplete, 3);
  assert.equal(output.coverage.evidence.completionBatchChunksInvalid, 4);
  assert.equal(output.coverage.evidence.completionBatchChunksMissing, 5);
  assert.equal(output.coverage.evidence.completionBatchChunksDuplicate, 1);
  assert.equal(
    output.coverage.telemetry.recordsValid,
    3,
    "independently accepted chunks remain visible",
  );
  assert.equal(output.runs.length, 3);
});

test("subagent analysis: grouped batch-state eviction admits a later valid batch", async (t) => {
  const lines = [sessionHeader("subagent-grouped-eviction")];
  for (let index = 0; index < 256; index++) {
    lines.push(
      completionBatchMessage({
        schemaVersion: 1,
        kind: "subagent_completion_batch",
        batchId: `incomplete-${index}`,
        batchIndex: 0,
        batchCount: 2,
        triggersTurn: false,
        completions: [{ agent: "evicted-agent", status: "completed" }],
      }),
    );
  }
  lines.push(
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "after-eviction",
      batchIndex: 0,
      batchCount: 1,
      triggersTurn: true,
      completions: [
        {
          agent: "surviving-agent",
          status: "completed",
          telemetry: telemetryEnvelope("surviving-run", "async"),
        },
      ],
    }),
  );
  lines.push(
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
  );
  lines.push(
    messageEntry({
      role: "assistant",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
      content: [],
    }),
  );

  const output = analyzeSubagentSessions([await scanSessionFile(writeFixture(t, lines))]);
  assert.equal(output.coverage.evidence.completionBatchStateEvictions, 1);
  assert.equal(output.coverage.evidence.completionBatchesIncomplete, 256);
  assert.equal(output.coverage.evidence.completionBatchesComplete, 1);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.runs.length, 1);
});

test("subagent analysis: audits completion-flush eviction without hiding bounded loss", async (t) => {
  const linesFor = (count) => {
    const lines = [sessionHeader(`subagent-flush-audit-${count}`)];
    for (let index = 0; index < count; index++) {
      const notification = JSON.parse(
        completionBatchMessage({
          schemaVersion: 1,
          kind: "subagent_completion_batch",
          batchId: `audit-batch-${index}`,
          batchIndex: 0,
          batchCount: 1,
          flushId: `audit-flush-${index}`,
          flushIndex: 0,
          flushCount: 1,
          triggersTurn: true,
          completions: [
            {
              agent: "audit-agent",
              status: "completed",
              telemetry: telemetryEnvelope(`audit-run-${index}`, "async"),
            },
          ],
        }),
      );
      notification.message.timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      lines.push(
        JSON.stringify(notification),
        messageEntry({
          role: "user",
          timestamp: "2026-01-02T00:00:00.000Z",
          content: BACKGROUND_COMPLETION_NUDGE,
        }),
        messageEntry({
          role: "assistant",
          timestamp: "2026-01-02T00:00:01.000Z",
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 1 },
          content: [],
        }),
      );
    }
    return lines;
  };
  const analyze = async (count) =>
    analyzeSubagentSessions([await scanSessionFile(writeFixture(t, linesFor(count)))]);

  const atLimit = await analyze(256);
  assert.equal(atLimit.coverage.evidence.completionFlushStateEvictions, 0);
  assert.equal(atLimit.wakeups.length, 256);
  assert.equal(atLimit.coverage.wakeups.attributed, 256);
  assert.equal(atLimit.aggregates.attributedWakeupUsage.costUsd, 256);
  assert.equal(atLimit.coverage.totalProjectionGaps, 0);

  const overLimit = await analyze(257);
  assert.equal(overLimit.coverage.evidence.completionFlushStateEvictions, 1);
  assert.equal(overLimit.wakeups.length, 256);
  assert.equal(overLimit.coverage.wakeups.attributed, 256);
  assert.equal(overLimit.aggregates.attributedWakeupUsage.costUsd, 256);
  assert.equal(overLimit.coverage.totalProjectionGaps, 0);
});

test("subagent analysis: rejects a different batch at an occupied flush position", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("subagent-grouped-position-conflict"),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "position-original",
      batchIndex: 0,
      batchCount: 1,
      flushId: "position-flush",
      flushIndex: 0,
      flushCount: 2,
      triggersTurn: false,
      completions: [
        {
          agent: "position-agent",
          status: "completed",
          telemetry: telemetryEnvelope("position-original-run", "async"),
        },
      ],
    }),
    // A different logical batch cannot claim the same overall-flush position.
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "position-replacement",
      batchIndex: 0,
      batchCount: 1,
      flushId: "position-flush",
      flushIndex: 0,
      flushCount: 2,
      triggersTurn: false,
      completions: [
        {
          agent: "position-agent",
          status: "completed",
          telemetry: telemetryEnvelope("position-replacement-run", "async"),
        },
      ],
    }),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "position-final",
      batchIndex: 0,
      batchCount: 1,
      flushId: "position-flush",
      flushIndex: 1,
      flushCount: 2,
      triggersTurn: true,
      completions: [
        {
          agent: "position-agent",
          status: "completed",
          telemetry: telemetryEnvelope("position-final-run", "async"),
        },
      ],
    }),
    messageEntry({ role: "user", content: BACKGROUND_COMPLETION_NUDGE }),
  ]);

  const scan = await scanSessionFile(filePath);
  const beforeAnalysis = structuredClone(scan.entries);
  freezeDeep(scan.entries);
  const output = analyzeSubagentSessions([scan]);
  assert.deepEqual(scan.entries, beforeAnalysis, "analysis must not mutate projected evidence");
  assert.equal(output.runs.length, 1, "conflicting positions must not add replacement runs");
  assert.equal(output.coverage.telemetry.recordsValid, 1);
  assert.equal(output.coverage.evidence.completionBatchChunksValid, 1);
  assert.equal(output.coverage.evidence.completionBatchChunksInvalid, 2);
  assert.equal(output.wakeups.length, 0, "an invalid flush cannot wake");
  assert.equal(output.coverage.wakeups.unmatchedNudges, 1);
});

test("subagent analysis: rejects a replacement after batch-state eviction", async (t) => {
  const lines = [
    sessionHeader("subagent-grouped-post-eviction"),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "evicted-batch",
      batchIndex: 0,
      batchCount: 1,
      flushId: "evicted-flush",
      flushIndex: 0,
      flushCount: 1,
      triggersTurn: true,
      completions: [
        {
          agent: "evicted-agent",
          status: "completed",
          telemetry: telemetryEnvelope("evicted-original-run", "async"),
        },
      ],
    }),
    messageEntry({ role: "user", content: BACKGROUND_COMPLETION_NUDGE }),
    messageEntry({
      role: "assistant",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.7 },
      content: [],
    }),
  ];
  // Keep the target flush tombstone alive while forcing its batch state out.
  for (let index = 0; index < 256; index++) {
    lines.push(
      completionBatchMessage({
        schemaVersion: 1,
        kind: "subagent_completion_batch",
        batchId: `post-eviction-pressure-${index}`,
        batchIndex: 0,
        batchCount: 1,
        flushId: "post-eviction-pressure-flush",
        flushIndex: index,
        flushCount: 256,
        triggersTurn: false,
        completions: [{ agent: "pressure-agent", status: "completed" }],
      }),
    );
  }
  lines.push(
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "evicted-batch",
      batchIndex: 0,
      batchCount: 1,
      flushId: "evicted-flush",
      flushIndex: 0,
      flushCount: 1,
      triggersTurn: true,
      completions: [
        {
          agent: "evicted-agent",
          status: "completed",
          telemetry: telemetryEnvelope("evicted-replacement-run", "async"),
        },
      ],
    }),
    messageEntry({ role: "user", content: BACKGROUND_COMPLETION_NUDGE }),
  );

  const scan = await scanSessionFile(writeFixture(t, lines));
  const beforeAnalysis = structuredClone(scan.entries);
  freezeDeep(scan.entries);
  const output = analyzeSubagentSessions([scan]);
  assert.deepEqual(scan.entries, beforeAnalysis, "tombstone checks must be read-only");
  assert.ok(output.coverage.evidence.completionBatchStateEvictions >= 1);
  assert.equal(output.runs.length, 1, "a tombstoned batch cannot fabricate a replacement run");
  assert.equal(output.coverage.evidence.completionBatchChunksDuplicate, 1);
  assert.equal(output.coverage.evidence.completionBatchChunksInvalid, 1);
  assert.equal(output.wakeups.length, 0, "the conflicting flush wakeup is revoked");
  assert.equal(output.aggregates.attributedWakeupUsage.costUsd, 0);
  assert.equal(output.coverage.wakeups.unmatchedNudges, 1);
});

test("subagent analysis: flush tombstone pressure revokes only the forgotten flush", async (t) => {
  const lines = [
    sessionHeader("subagent-grouped-flush-pressure"),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "pressure-target",
      batchIndex: 0,
      batchCount: 1,
      flushId: "pressure-target-flush",
      flushIndex: 0,
      flushCount: 1,
      triggersTurn: true,
      completions: [
        {
          agent: "pressure-target-agent",
          status: "completed",
          telemetry: telemetryEnvelope("pressure-target-run", "async"),
        },
      ],
    }),
    messageEntry({ role: "user", content: BACKGROUND_COMPLETION_NUDGE }),
    messageEntry({
      role: "assistant",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.7 },
      content: [],
    }),
  ];
  // 256 additional flush identities force the target tombstone out of the
  // bounded flush map. Their entries carry no run IDs or telemetry.
  for (let index = 0; index < 256; index++) {
    lines.push(
      completionBatchMessage({
        schemaVersion: 1,
        kind: "subagent_completion_batch",
        batchId: `flush-pressure-${index}`,
        batchIndex: 0,
        batchCount: 1,
        flushId: `flush-pressure-id-${index}`,
        flushIndex: 0,
        flushCount: 1,
        triggersTurn: false,
        completions: [{ agent: "pressure-agent", status: "completed" }],
      }),
    );
  }
  lines.push(
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "unrelated-after-pressure",
      batchIndex: 0,
      batchCount: 1,
      flushId: "unrelated-after-pressure-flush",
      flushIndex: 0,
      flushCount: 1,
      triggersTurn: true,
      completions: [
        {
          agent: "unrelated-agent",
          status: "completed",
          telemetry: telemetryEnvelope("unrelated-after-pressure-run", "async"),
        },
      ],
    }),
    messageEntry({ role: "user", content: BACKGROUND_COMPLETION_NUDGE }),
    messageEntry({
      role: "assistant",
      usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.4 },
      content: [],
    }),
  );

  const scan = await scanSessionFile(writeFixture(t, lines));
  const beforeAnalysis = structuredClone(scan.entries);
  freezeDeep(scan.entries);
  const output = analyzeSubagentSessions([scan]);
  assert.deepEqual(scan.entries, beforeAnalysis, "pressure handling must not mutate evidence");
  assert.ok(output.coverage.evidence.completionBatchStateEvictions >= 1);
  assert.equal(output.coverage.evidence.completionFlushStateEvictions, 2);
  assert.equal(output.runs.length, 2, "the unrelated flush remains valid");
  assert.equal(output.wakeups.length, 1, "the forgotten target wakeup was revoked");
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.equal(output.wakeups[0]?.assistantUsage?.costUsd, 0.4);
  assert.equal(output.aggregates.attributedWakeupUsage.costUsd, 0.4);
});

test("subagent analysis: malformed grouped telemetry invalidates wakeup but preserves valid siblings", async (t) => {
  const validTelemetry = telemetryEnvelope("valid-sibling-run", "async");
  const malformedTelemetry = {
    ...telemetryEnvelope("malformed-sibling-run", "async"),
    controls: undefined,
  };
  const filePath = writeFixture(t, [
    sessionHeader("subagent-grouped-mixed-siblings"),
    completionBatchMessage({
      schemaVersion: 1,
      kind: "subagent_completion_batch",
      batchId: "mixed-siblings",
      batchIndex: 0,
      batchCount: 1,
      triggersTurn: true,
      completions: [
        { agent: "valid-sibling", status: "completed", telemetry: validTelemetry },
        { agent: "malformed-sibling", status: "completed", telemetry: malformedTelemetry },
      ],
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.runs.length, 1, "the valid nested envelope remains canonicalized");
  assert.equal(output.coverage.telemetry.recordsObserved, 2);
  assert.equal(output.coverage.telemetry.recordsValid, 1);
  assert.equal(output.coverage.telemetry.recordsInvalid, 1);
  assert.equal(output.coverage.evidence.completionBatchEntriesObserved, 2);
  assert.equal(output.coverage.evidence.completionBatchChunksInvalid, 1);
  assert.equal(output.coverage.evidence.completionBatchesIncomplete, 1);
  assert.equal(output.wakeups.length, 0, "a malformed sibling must withhold the batch wakeup");
  assert.equal(output.coverage.wakeups.unmatchedNudges, 1);
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes("valid-sibling-run"));
  assert.ok(!serialized.includes("malformed-sibling-run"));
});

test("subagent analysis: malformed and legacy records become coverage gaps", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("subagent-gaps"),
    messageEntry({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: "orphan-launch",
          arguments: { agent: "legacy-agent", task: "secret task" },
        },
      ],
    }),
    messageEntry({
      role: "custom",
      customType: "subagent-notify",
      content: "Background task completed: secret output /private/path",
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
    messageEntry({ role: "user", content: "Human input interrupts the synthetic turn." }),
    messageEntry({
      role: "custom",
      customType: "subagent_control_notice",
      content: "Subagent needs attention: secret output /private/path",
      details: { event: { runId: "bad/run", type: "needs_attention" } },
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Subagent run needs attention — see notice above.",
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.operations.launches.withoutRunId, 1);
  assert.equal(output.operations.launches.withoutResult, 1);
  assert.equal(output.coverage.telemetry.recordsInvalid, 0);
  assert.equal(output.coverage.evidence.legacyProseNotifications, 2);
  assert.equal(output.coverage.wakeups.interruptedByHumanInput, 1);
  assert.equal(output.coverage.wakeups.missingAssistantTurn, 1);
  assert.equal(output.coverage.wakeups.attributed, 0);
  assert.equal(output.coverage.wakeups.unattributed, 2);
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes("/private/path"));
  assert.ok(!serialized.includes("secret task"));
  assert.ok(!serialized.includes("secret output"));
});

test("subagent analysis: legacy details retain bounded usage, model, outcome, and runtime evidence", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("subagent-legacy-details"),
    messageEntry({
      role: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: "legacy-call",
          arguments: JSON.stringify({
            agent: "legacy-agent",
            task: "private legacy task",
            async: false,
          }),
        },
      ],
    }),
    toolResultLine("2026-01-01T00:00:01.000Z", "legacy-call", "subagent", {
      details: {
        runId: "legacy-run",
        mode: "single",
        totalCost: { costUsd: 0.4 },
        results: [
          {
            index: 0,
            agent: "legacy-agent",
            model: "legacy-provider/legacy-model/variant",
            usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 0, cost: 0.4 },
            exitCode: 0,
            startedAt: 100,
            endedAt: 150,
          },
        ],
      },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  const run = output.runs[0];
  assert.equal(output.operations.launches.foreground, 1);
  assert.equal(run?.execution, "foreground");
  assert.equal(run?.roles[0], "legacy-agent");
  assert.deepEqual(run?.models[0], {
    provider: "legacy-provider",
    model: "legacy-model/variant",
  });
  assert.equal(run?.usage?.costUsd, 0.4);
  assert.equal(run?.runtime.durationMs, 50);
  assert.equal(run?.outcome?.state, "completed");
  assert.equal(output.coverage.runsWithoutTelemetry, 1);
  assert.equal(output.coverage.missingEvidence.telemetryForRun, 1);
  assert.ok(!JSON.stringify(output).includes("private legacy task"));
});

test("subagent analysis: malformed qualified model references become projection gaps", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("subagent-invalid-model"),
    messageEntry({
      role: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: [
        {
          type: "toolCall",
          toolName: "subagent",
          toolCallId: "invalid-model-call",
        },
      ],
    }),
    toolResultLine("2026-01-01T00:00:01.000Z", "invalid-model-call", "subagent", {
      details: {
        runId: "invalid-model-run",
        results: [{ agent: "invalid-model-agent", model: "provider/" }],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  assert.ok(scan.projectionGapCount > 0);
  const output = analyzeSubagentSessions([scan]);
  assert.equal(output.runs[0]?.models.length, 0);
});

test("subagent analysis: invalid telemetry is reported without trusting raw fields", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("subagent-invalid"),
    messageEntry({
      role: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: [
        { type: "toolCall", toolName: "subagent", toolCallId: "invalid-call", arguments: {} },
      ],
    }),
    toolResultLine("2026-01-01T00:00:01.000Z", "invalid-call", "subagent", {
      details: {
        runId: "invalid-run",
        telemetry: {
          schemaVersion: 1,
          run: { id: "invalid-run", execution: "async", mode: "single" },
          steps: [],
          provenance: { tlhVersion: "test", piVersion: "test", loadedAt: 1 },
          // Missing controls intentionally makes the envelope invalid.
        },
      },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.coverage.telemetry.recordsObserved, 1);
  assert.equal(output.coverage.telemetry.recordsInvalid, 1);
  assert.equal(output.coverage.runsWithoutTelemetry, 1);
  assert.match(output.runs[0]?.runId ?? "", /^run-\d+$/);
  assert.equal(output.runs[0]?.usage, null);
});

test("subagent analysis: direct and nested control events are paired once", async (t) => {
  const directEvent = {
    type: "needs_attention",
    to: "needs_attention",
    ts: 100,
    runId: "run-direct/control",
    agent: "control-agent",
    index: 0,
    message: "control event",
    reason: "idle",
  };
  const nestedEvent = {
    type: "needs_attention",
    to: "needs_attention",
    ts: 200,
    runId: "run-nested-control",
    agent: "nested-agent",
    index: 0,
    message: "nested control event",
    reason: "tool_failures",
  };
  const filePath = writeFixture(t, [
    sessionHeader("subagent-control-events"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "direct-control", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "direct-control", "subagent", {
      details: {
        runId: "run-direct/control",
        asyncId: "run-direct/control",
        asyncDir: "/private/async/run-direct",
        controlEvents: [directEvent],
      },
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Subagent run needs attention — see notice above.",
    }),
    messageEntry({
      role: "assistant",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
      content: [],
    }),
    assistantMessageLine("2026-01-01T00:00:02.000Z", [
      { toolCallId: "nested-control", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:03.000Z", "nested-control", "subagent", {
      details: {
        runId: "run-nested-control",
        asyncId: "run-nested-control",
        results: [{ agent: "nested-agent", controlEvents: [nestedEvent] }],
      },
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Subagent run needs attention — see notice above.",
    }),
    messageEntry({ role: "assistant", content: [] }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.coverage.evidence.malformedControlDetails, 0);
  assert.equal(output.coverage.wakeups.observed, 2);
  assert.equal(output.coverage.wakeups.attributed, 2);
  assert.equal(output.wakeups.filter((wakeup) => wakeup.kind === "control").length, 2);
  assert.ok(output.wakeups.every((wakeup) => /^run-\d+$/.test(wakeup.runId ?? "")));
  assert.equal(
    output.wakeups[0]?.runId,
    output.runs.find((run) => run.roles.includes("control-agent"))?.runId,
  );
  assert.equal(output.runs.find((run) => run.roles.includes("control-agent"))?.execution, "async");
});

test("subagent analysis: accepts retired active-long-running control events", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("retired-control-event"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "retired-control-call", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "retired-control-call", "subagent", {
      details: {
        runId: "retired-control-run",
        asyncId: "retired-control-run",
        results: [
          {
            agent: "retired-control-agent",
            controlEvents: [
              {
                type: "active_long_running",
                to: "active_long_running",
                ts: 100,
                runId: "retired-control-run",
                agent: "retired-control-agent",
                message: "bounded legacy control event",
                reason: "time_threshold",
              },
            ],
          },
        ],
      },
    }),
  ]);

  const scan = await scanSessionFile(filePath);
  assert.equal(scan.projectionGapCount, 0);
  const output = analyzeSubagentSessions([scan]);
  assert.equal(output.coverage.evidence.controlNotifications, 1);
  assert.equal(output.coverage.evidence.malformedControlDetails, 0);
  assert.equal(output.coverage.wakeups.missingNudge, 1);
  assert.equal(output.runs.length, 1);
});

test("subagent analysis: structured custom completion IDs accept opaque values", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("opaque-custom-completion"),
    messageEntry({
      role: "custom",
      customType: "subagent-notify",
      content: "Background task completed: opaque result",
      details: {
        agent: "opaque-completion-agent",
        status: "completed",
        asyncId: "custom /completion",
      },
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
    messageEntry({ role: "assistant", content: [] }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.runs.length, 1);
  assert.match(output.runs[0]?.runId ?? "", /^run-\d+$/);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, true);
  assert.ok(!JSON.stringify(output).includes("custom /completion"));
});

test("subagent analysis: invalid optional telemetry fields remain coverage gaps", async (t) => {
  const malformedTiming = telemetryEnvelope("run-malformed-timing", "async");
  malformedTiming.timing = { durationMs: "not-a-duration" };
  const malformedLineage = telemetryEnvelope("run-malformed-lineage", "foreground");
  malformedLineage.lineage = { continuationFrom: {} };
  const filePath = writeFixture(t, [
    sessionHeader("subagent-invalid-optional"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "timing-result", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "timing-result", "subagent", {
      details: { telemetry: malformedTiming },
    }),
    assistantMessageLine("2026-01-01T00:00:01.500Z", [
      { toolCallId: "lineage-result", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:02.000Z", "lineage-result", "subagent", {
      details: { telemetry: malformedLineage },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.coverage.telemetry.recordsObserved, 2);
  assert.equal(output.coverage.telemetry.recordsInvalid, 2);
  assert.equal(output.coverage.telemetry.recordsValid, 0);
  assert.equal(output.coverage.evidence.malformedTelemetryRecords, 2);
  assert.equal(output.runs.length, 0);
});

test("subagent analysis: a missing assistant turn is never attributed", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("subagent-no-assistant"),
    messageEntry({
      role: "custom",
      customType: "subagent-notify",
      content: "Background task completed: no assistant yet",
      details: {
        agent: "async-agent",
        status: "completed",
        asyncId: "run-no-assistant",
        resultPreview: "bounded",
      },
    }),
    messageEntry({
      role: "user",
      content: "[tlh] Background subagent completed — see notification above.",
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.wakeups.length, 1);
  assert.equal(output.wakeups[0]?.attributed, false);
  assert.equal(output.wakeups[0]?.reason, "missing-assistant-turn");
  assert.equal(output.coverage.wakeups.missingAssistantTurn, 1);
});

test("subagent analysis: scanner retains bounded allowlisted projections instead of raw messages", async (t) => {
  const secret = "projection-secret-" + "x".repeat(200_000);
  const filePath = writeFixture(t, [
    sessionHeader("projection-session", "/private/cwd"),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: [
          { type: "text", text: secret },
          {
            type: "toolCall",
            toolName: "subagent",
            toolCallId: "projection-call",
            arguments: { agent: "projection-agent", task: secret, settings: { secret } },
          },
        ],
        unrelatedField: secret,
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        timestamp: "2026-01-01T00:00:01.000Z",
        toolCallId: "projection-call",
        toolName: "subagent",
        content: [{ type: "text", text: secret }],
        details: {
          runId: "projection-run",
          results: [
            {
              agent: "projection-agent",
              output: secret,
              sessionFile: "/private/projection-secret/session.jsonl",
            },
          ],
          output: secret,
          prompt: secret,
        },
      },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "custom", customType: "unrelated", content: secret, details: { secret } },
    }),
    JSON.stringify({ type: "message", message: { role: "user", content: secret } }),
  ]);

  const scan = await scanSessionFile(filePath);
  const serialized = JSON.stringify(scan.entries);
  assert.ok(serialized.length < 10_000, "projection should stay bounded despite huge bodies");
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes("output"));
  assert.ok(!serialized.includes("prompt"));
  assert.ok(!serialized.includes("/private/projection-secret/session.jsonl"));
  assert.ok(!JSON.stringify(scan.toolPairs).includes("/private/projection-secret/session.jsonl"));
  assert.equal(scan.entries.length, 3, "unrelated custom messages should not be retained");
  assert.equal(scan.toolPairs.length, 1);
});

test("subagent analysis: orphan and non-subagent tool details are counted but not trusted", async (t) => {
  const orphanTelemetry = telemetryEnvelope("orphan-telemetry", "async");
  const controlEvent = {
    type: "needs_attention",
    to: "needs_attention",
    ts: 100,
    runId: "not-trusted",
    agent: "not-trusted-agent",
    message: "not trusted",
  };
  const filePath = writeFixture(t, [
    sessionHeader("orphan-evidence"),
    toolResultLine("2026-01-01T00:00:01.000Z", "orphan-result", "subagent", {
      details: { telemetry: orphanTelemetry, runId: "orphan-telemetry" },
    }),
    assistantMessageLine("2026-01-01T00:00:02.000Z", [
      { toolCallId: "other-result", toolName: "bash" },
    ]),
    toolResultLine("2026-01-01T00:00:03.000Z", "other-result", "bash", {
      details: { controlEvents: [controlEvent], runId: "not-trusted" },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.runs.length, 0);
  assert.equal(output.coverage.telemetry.recordsObserved, 0);
  assert.equal(output.coverage.evidence.controlNotifications, 0);
  assert.equal(output.coverage.evidence.unmatchedEvidence, 2);
});

test("subagent analysis: explicitly non-subagent results are not trusted by ID alone", async (t) => {
  const filePath = writeFixture(t, [
    sessionHeader("mismatched-tool-result"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "mismatched-result", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "mismatched-result", "bash", {
      details: {
        runId: "must-not-be-trusted",
        results: [{ agent: "must-not-be-trusted", sessionFile: "/private/secret.jsonl" }],
      },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.runs.length, 0);
  assert.equal(output.operations.launches.withResult, 0);
  assert.equal(output.operations.launches.withoutResult, 1);
});

test("subagent analysis: derives canonical parallel outcome when run outcome is absent", async (t) => {
  const telemetry = telemetryEnvelope("parallel-outcome-run", "async", {
    agent: "failed-agent",
    index: 2,
    outcome: { state: "failed", terminationReason: "model_error" },
  });
  telemetry.run.mode = "parallel";
  telemetry.steps.push({
    ...telemetry.steps[0],
    index: 1,
    agent: "paused-interrupted-agent",
    outcome: { state: "paused", terminationReason: "interrupted" },
  });
  telemetry.steps.push({
    ...telemetry.steps[0],
    index: 0,
    agent: "paused-agent",
    outcome: { state: "paused", terminationReason: "paused" },
  });
  delete telemetry.outcome;

  const filePath = writeFixture(t, [
    sessionHeader("parallel-outcome-session"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "parallel-outcome-call", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "parallel-outcome-call", "subagent", {
      details: { telemetry },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.deepEqual(output.runs[0]?.outcome, {
    state: "paused",
    terminationReason: "paused",
  });
});

test("subagent analysis: canonical run usage wins over step usage and is counted once", async (t) => {
  const telemetry = telemetryEnvelope("canonical-usage", "foreground", {
    agent: "canonical-agent",
  });
  telemetry.steps.push({
    ...telemetry.steps[0],
    index: 1,
    agent: "second-agent",
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      costUsd: 4,
    },
  });
  telemetry.usage = {
    inputTokens: 7,
    outputTokens: 8,
    cacheReadTokens: 9,
    cacheWriteTokens: 10,
    costUsd: 11,
  };
  const filePath = writeFixture(t, [
    sessionHeader("canonical-usage-session"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "canonical-call", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "canonical-call", "subagent", {
      details: { telemetry },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.deepEqual(output.runs[0]?.usage, telemetry.usage);
  assert.deepEqual(output.aggregates.usage, telemetry.usage);
  assert.deepEqual(output.aggregates.byExecution.foreground?.usage, telemetry.usage);
});

test("subagent analysis: opaque tuple keys preserve model and lineage collisions", async (t) => {
  const firstTelemetry = telemetryEnvelope("child", "async", { agent: "collision-agent" });
  firstTelemetry.steps[0].model = { provider: "anthropic/cloud", model: "claude" };
  firstTelemetry.lineage = {
    continuationFrom: { sourceRunId: "source:run", sourceStepIndex: 1 },
    nested: { rootRunId: "root", parentRunId: "a:parent:run" },
  };
  const secondTelemetry = telemetryEnvelope("run:child", "async", { agent: "collision-agent" });
  secondTelemetry.steps[0].model = { provider: "anthropic", model: "cloud/claude" };
  secondTelemetry.lineage = {
    continuationFrom: { sourceRunId: "source", sourceStepIndex: 1 },
    nested: { rootRunId: "root", parentRunId: "a:parent" },
  };
  const filePath = writeFixture(t, [
    sessionHeader("opaque-tuple-collisions"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "collision-one", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "collision-one", "subagent", {
      details: { telemetry: firstTelemetry },
    }),
    assistantMessageLine("2026-01-01T00:00:02.000Z", [
      { toolCallId: "collision-two", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:03.000Z", "collision-two", "subagent", {
      details: { telemetry: secondTelemetry },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  const firstModelKey = JSON.stringify(["anthropic/cloud", "claude"]);
  const secondModelKey = JSON.stringify(["anthropic", "cloud/claude"]);
  assert.equal(output.aggregates.byModel[firstModelKey]?.runs, 1);
  assert.equal(output.aggregates.byModel[secondModelKey]?.runs, 1);
  assert.equal(output.lineage.continuationEdges.length, 2);
  assert.equal(output.lineage.nestedEdges.length, 2);
  assert.deepEqual(
    new Set(output.runs.flatMap((run) => run.models.map((model) => JSON.stringify(model)))),
    new Set([
      JSON.stringify({ provider: "anthropic/cloud", model: "claude" }),
      JSON.stringify({ provider: "anthropic", model: "cloud/claude" }),
    ]),
  );
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes("source:run"));
  assert.ok(!serialized.includes("a:parent:run"));
});

test("subagent analysis: accepts slash-qualified structured model identities", async (t) => {
  const telemetry = telemetryEnvelope("opaque /model-run", "async", {
    agent: "model-agent",
  });
  telemetry.steps[0].model = {
    provider: "anthropic/cloud",
    model: "claude/3.5-sonnet",
    thinking: "extended/thinking",
  };
  const filePath = writeFixture(t, [
    sessionHeader("opaque-model-session"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "opaque-model-call", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "opaque-model-call", "subagent", {
      details: { telemetry },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  const run = output.runs[0];
  assert.match(run?.runId ?? "", /^run-\d+$/);
  assert.deepEqual(run?.models[0], telemetry.steps[0].model);
  assert.equal(
    output.aggregates.byModel[JSON.stringify(["anthropic/cloud", "claude/3.5-sonnet"])]?.runs,
    1,
  );
  assert.ok(!JSON.stringify(output).includes("opaque /model-run"));
});

test("subagent analysis: nested sibling runs retain opaque child identity", async (t) => {
  const firstTelemetry = telemetryEnvelope("child /one", "async", { agent: "nested-agent" });
  firstTelemetry.lineage = {
    nested: {
      rootRunId: "root /opaque",
      parentRunId: "parent/opaque",
      parentStepIndex: 0,
      depth: 1,
    },
  };
  const secondTelemetry = telemetryEnvelope("child/two", "async", { agent: "nested-agent" });
  secondTelemetry.lineage = {
    nested: {
      rootRunId: "root /opaque",
      parentRunId: "parent/opaque",
      parentStepIndex: 0,
      depth: 1,
    },
  };
  const filePath = writeFixture(t, [
    sessionHeader("nested-opaque-session"),
    assistantMessageLine("2026-01-01T00:00:00.000Z", [
      { toolCallId: "nested-one-call", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:01.000Z", "nested-one-call", "subagent", {
      details: { telemetry: firstTelemetry },
    }),
    assistantMessageLine("2026-01-01T00:00:02.000Z", [
      { toolCallId: "nested-two-call", toolName: "subagent" },
    ]),
    toolResultLine("2026-01-01T00:00:03.000Z", "nested-two-call", "subagent", {
      details: { telemetry: secondTelemetry },
    }),
  ]);

  const output = analyzeSubagentSessions([await scanSessionFile(filePath)]);
  assert.equal(output.runs.length, 2);
  assert.equal(output.lineage.nestedEdges.length, 2);
  assert.equal(new Set(output.lineage.nestedEdges.map((edge) => edge.childRunId)).size, 2);
  assert.deepEqual(
    new Set(output.lineage.nestedEdges.map((edge) => edge.childRunId)),
    new Set(output.runs.map((run) => run.runId)),
  );
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes("child /one"));
  assert.ok(!serialized.includes("child/two"));
  assert.ok(!serialized.includes("root /opaque"));
  assert.ok(!serialized.includes("parent/opaque"));
});
