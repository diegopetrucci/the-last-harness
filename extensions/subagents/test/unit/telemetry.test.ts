import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  appendSubagentTelemetryContinuation,
  buildSubagentRunTelemetry,
  continuationTelemetryMetadata,
  mergeSubagentRunTelemetry,
  normalizeSubagentRunTelemetry,
  resolveParallelSubagentTelemetryOutcome,
  resolveSubagentTelemetryOutcome,
  telemetryFromRunnerResults,
  telemetryFromSingleResults,
  type SubagentRunTelemetry,
  type SubagentTelemetryControls,
  type SubagentTelemetryProvenance,
} from "../../src/shared/telemetry.ts";
import type {
  AcceptanceLedgerStatus,
  ResolvedControlConfig,
  SingleResult,
} from "../../src/shared/types.ts";
import { captureSubagentTelemetryProvenance } from "../../src/extension/telemetry-provenance.ts";

const provenance: SubagentTelemetryProvenance = {
  tlhVersion: "0.41.0",
  piVersion: "0.85.1",
  installGeneration: "2026-09-13T16:31:49.000Z",
  loadedAt: 100,
};

const controls: ResolvedControlConfig = {
  enabled: true,
  needsAttentionAfterMs: 2_000,
  failedToolAttemptsBeforeAttention: 3,
  notifyOn: ["needs_attention"],
  notifyChannels: ["event", "async"],
};

function buildTelemetry(overrides: Partial<SubagentRunTelemetry> = {}): SubagentRunTelemetry {
  return buildSubagentRunTelemetry({
    runId: "run-1",
    execution: "foreground",
    mode: "single",
    provenance,
    controls,
    startedAt: 100,
    endedAt: 250,
    steps: [{ index: 0, agent: "worker", outcome: { state: "completed" } }],
    ...overrides,
  });
}

function acceptanceForTelemetry(
  status: AcceptanceLedgerStatus,
): NonNullable<SingleResult["acceptance"]> {
  return {
    status,
    explicit: false,
    effectiveAcceptance: {
      level: "checked",
      explicit: false,
      inferredReason: [],
      criteria: [],
      evidence: [],
      verify: [],
      stopRules: [],
    },
    inferredReason: [],
    criteria: [],
    runtimeChecks: [],
    verifyRuns: [],
  };
}

describe("subagent run telemetry", () => {
  it("builds the compact allowlisted envelope without fabricated activity fields", () => {
    const telemetry = buildSubagentRunTelemetry({
      runId: "run-1",
      execution: "foreground",
      mode: "single",
      provenance,
      controls,
      startedAt: 100,
      endedAt: 250,
      steps: [
        {
          index: 0,
          agent: "worker",
          activity: {},
          timing: {},
          outcome: { state: "completed", terminationReason: "completed" },
        },
      ],
    });

    assert.deepEqual(telemetry.timing, {
      startedAt: 100,
      endedAt: 250,
      durationMs: 150,
    });
    assert.deepEqual(telemetry.steps, [
      {
        index: 0,
        agent: "worker",
        outcome: { state: "completed", terminationReason: "completed" },
      },
    ]);
    assert.equal("usage" in telemetry, false);
    assert.equal("activity" in telemetry.steps[0]!, false);
    assert.equal("timing" in telemetry.steps[0]!, false);

    const serialized = JSON.stringify(telemetry);
    assert.doesNotMatch(serialized, /"(?:task|prompt|output|cwd|path|args|settings)"\s*:/);
  });

  it("degrades malformed optional subobjects while retaining a valid envelope", () => {
    const source = buildTelemetry({
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 5,
      },
      lineage: {
        continuationFrom: { sourceRunId: "source", sourceStepIndex: 0 },
      },
    });
    const malformed = {
      ...source,
      usage: { inputTokens: "not-a-number" },
      timing: { durationMs: -1 },
      outcome: { state: "not-a-state" },
      lineage: {
        continuationFrom: { sourceRunId: "" },
        continuations: [{ continuationRunId: "valid" }, { continuationRunId: 42 }],
        nested: { rootRunId: "", parentRunId: "parent" },
      },
      steps: [
        {
          ...source.steps[0],
          activity: { toolCalls: "not-a-number" },
          timing: { activeRuntimeMs: -1 },
          outcome: { state: "invalid" },
          model: { provider: "", model: "" },
        },
      ],
    };

    const normalized = normalizeSubagentRunTelemetry(malformed);
    assert.ok(normalized);
    assert.equal("usage" in normalized, false);
    assert.equal("timing" in normalized, false);
    assert.equal("outcome" in normalized, false);
    assert.deepEqual(normalized.lineage, {
      continuations: [{ continuationRunId: "valid" }],
    });
    assert.deepEqual(normalized.steps, [{ index: 0, agent: "worker" }]);
    assert.deepEqual(normalized.provenance, provenance);
    assert.deepEqual(normalized.controls, {
      needsAttentionAfterMs: controls.needsAttentionAfterMs,
      failedToolAttemptsBeforeAttention: controls.failedToolAttemptsBeforeAttention,
      notifyOn: controls.notifyOn,
      notifyChannels: controls.notifyChannels,
    });
  });

  it("preserves cancellation and terminal cohort states over interrupt flags", () => {
    assert.deepEqual(
      resolveSubagentTelemetryOutcome({
        state: "cancelled",
        interrupted: true,
        success: false,
        terminationReason: "cancelled",
      }),
      { state: "cancelled", terminationReason: "cancelled" },
    );
    assert.deepEqual(resolveSubagentTelemetryOutcome({ state: "complete", interrupted: true }), {
      state: "completed",
    });
    assert.deepEqual(resolveSubagentTelemetryOutcome({ state: "pausing" }), {
      state: "paused",
    });
  });

  it("keeps explicit cancel/pause state consistent between run and single-result step outcomes", () => {
    const cases: Array<{
      state: "cancelled" | "paused";
      terminationReason?: "model_error";
      acceptanceStatus: "accepted" | "rejected";
      resultState: Record<string, unknown>;
    }> = [
      {
        state: "cancelled",
        terminationReason: "model_error",
        acceptanceStatus: "accepted",
        resultState: { cancel: { summary: "cancelled by parent", cancelledAt: 123 } },
      },
      {
        state: "paused",
        acceptanceStatus: "rejected",
        resultState: { pause: { kind: "awaiting_supervisor", requestedAt: 123 } },
      },
    ];

    for (const testCase of cases) {
      const expected = {
        state: testCase.state,
        ...(testCase.terminationReason ? { terminationReason: testCase.terminationReason } : {}),
        acceptanceStatus: testCase.acceptanceStatus,
      };
      const telemetry = telemetryFromSingleResults({
        runId: `foreground-${testCase.state}`,
        mode: "single",
        provenance,
        controls,
        results: [
          {
            agent: "worker",
            task: "telemetry state test",
            exitCode: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            acceptance: acceptanceForTelemetry(testCase.acceptanceStatus),
            ...(testCase.terminationReason
              ? { terminationReason: testCase.terminationReason }
              : {}),
            ...testCase.resultState,
          },
        ],
        outcome: expected,
      });

      assert.deepEqual(telemetry.outcome, expected);
      assert.deepEqual(telemetry.steps[0]?.outcome, expected);
    }
  });

  it("selects aggregate termination reasons by outcome precedence, not completion order", () => {
    const completed = {
      index: 0,
      agent: "completed-child",
      success: true,
      terminationReason: "completed" as const,
    };
    const failed = {
      index: 1,
      agent: "failed-child",
      success: false,
      terminationReason: "model_error" as const,
    };
    const expected = { state: "failed" as const, terminationReason: "model_error" as const };

    assert.deepEqual(resolveParallelSubagentTelemetryOutcome([completed, failed]), expected);
    assert.deepEqual(resolveParallelSubagentTelemetryOutcome([failed, completed]), expected);

    const cancelled = {
      index: 2,
      agent: "cancelled-child",
      success: false,
      terminationReason: "cancelled" as const,
    };
    const paused = {
      index: 3,
      agent: "paused-child",
      interrupted: true,
      terminationReason: "paused" as const,
    };
    assert.deepEqual(resolveParallelSubagentTelemetryOutcome([failed, paused, cancelled]), {
      state: "cancelled",
      terminationReason: "cancelled",
    });
    assert.deepEqual(resolveParallelSubagentTelemetryOutcome([failed, paused]), {
      state: "paused",
      terminationReason: "paused",
    });
  });

  it("uses deterministic aggregate outcomes in foreground and async fallbacks", () => {
    const foregroundResult = (input: {
      agent: string;
      exitCode: number;
      terminationReason: "completed" | "model_error";
    }) => ({
      agent: input.agent,
      task: "telemetry test",
      exitCode: input.exitCode,
      terminationReason: input.terminationReason,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    });
    const foreground = telemetryFromSingleResults({
      runId: "foreground-order-variant",
      mode: "parallel",
      provenance,
      controls,
      results: [
        foregroundResult({ agent: "complete", exitCode: 0, terminationReason: "completed" }),
        foregroundResult({ agent: "failure", exitCode: 1, terminationReason: "model_error" }),
      ],
    });
    const foregroundReversed = telemetryFromSingleResults({
      runId: "foreground-order-variant",
      mode: "parallel",
      provenance,
      controls,
      results: [
        foregroundResult({ agent: "failure", exitCode: 1, terminationReason: "model_error" }),
        foregroundResult({ agent: "complete", exitCode: 0, terminationReason: "completed" }),
      ],
    });
    assert.deepEqual(foreground.outcome, {
      state: "failed",
      terminationReason: "model_error",
    });
    assert.deepEqual(foregroundReversed.outcome, foreground.outcome);

    const asyncResults = [
      { index: 0, agent: "complete", success: true, terminationReason: "completed" as const },
      { index: 1, agent: "failure", success: false, terminationReason: "model_error" as const },
    ];
    const asyncTelemetry = telemetryFromRunnerResults({
      runId: "async-order-variant",
      mode: "parallel",
      provenance,
      controls,
      startedAt: 100,
      endedAt: 200,
      results: asyncResults,
    });
    const asyncTelemetryReversed = telemetryFromRunnerResults({
      runId: "async-order-variant",
      mode: "parallel",
      provenance,
      controls,
      startedAt: 100,
      endedAt: 200,
      results: [...asyncResults].reverse(),
    });
    assert.deepEqual(asyncTelemetry?.outcome, {
      state: "failed",
      terminationReason: "model_error",
    });
    assert.deepEqual(asyncTelemetryReversed?.outcome, asyncTelemetry?.outcome);
  });

  it("retains real async child indexes and derives run duration", () => {
    const telemetry = telemetryFromRunnerResults({
      runId: "async-run",
      mode: "parallel",
      provenance,
      controls,
      startedAt: 1_000,
      endedAt: 1_500,
      results: [
        {
          index: 2,
          agent: "late-worker",
          success: true,
          modelIdentity: { provider: "anthropic", model: "claude", thinking: "high" },
          attemptedModels: ["anthropic/claude"],
          modelAttempts: [
            {
              model: "anthropic/claude",
              usage: {
                input: 10,
                output: 20,
                cacheRead: 3,
                cacheWrite: 4,
                cost: 0.5,
                turns: 2,
              },
            },
          ],
        },
      ],
      statusSteps: [{}, {}, { status: "complete", endedAt: 1_400, turnCount: 2, toolCount: 4 }],
      outcome: { state: "completed", terminationReason: "completed" },
    });
    assert.ok(telemetry);

    assert.deepEqual(telemetry.timing, {
      startedAt: 1_000,
      endedAt: 1_500,
      durationMs: 500,
    });
    assert.equal(telemetry.steps[0]?.index, 2);
    assert.deepEqual(telemetry.steps[0]?.model, {
      provider: "anthropic",
      model: "claude",
      thinking: "high",
    });
    assert.deepEqual(telemetry.steps[0]?.activity, { turns: 2, toolCalls: 4 });
    assert.deepEqual(telemetry.usage, {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.5,
    });
  });

  it("omits aggregate model attribution for fallback attempts in foreground and async telemetry", () => {
    const model = { provider: "anthropic", model: "claude-final" };
    const failedUsage = {
      input: 4,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.2,
      turns: 1,
    };
    const finalUsage = {
      input: 10,
      output: 20,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 0.5,
      turns: 2,
    };
    const aggregateUsage = {
      input: failedUsage.input + finalUsage.input,
      output: failedUsage.output + finalUsage.output,
      cacheRead: failedUsage.cacheRead + finalUsage.cacheRead,
      cacheWrite: failedUsage.cacheWrite + finalUsage.cacheWrite,
      cost: failedUsage.cost + finalUsage.cost,
      turns: failedUsage.turns + finalUsage.turns,
    };
    const attemptedModels = ["anthropic/claude-failed", "anthropic/claude-final"];
    const modelAttempts = [
      { model: attemptedModels[0]!, success: false, usage: failedUsage },
      { model: attemptedModels[1]!, success: true, usage: finalUsage },
    ];

    const foreground = telemetryFromSingleResults({
      runId: "foreground-fallback",
      mode: "single",
      provenance,
      controls,
      results: [
        {
          agent: "worker",
          task: "telemetry test",
          exitCode: 0,
          modelIdentity: model,
          attemptedModels,
          modelAttempts,
          usage: aggregateUsage,
        },
      ],
    });
    assert.equal("model" in foreground.steps[0]!, false);
    assert.deepEqual(foreground.usage, {
      inputTokens: aggregateUsage.input,
      outputTokens: aggregateUsage.output,
      cacheReadTokens: aggregateUsage.cacheRead,
      cacheWriteTokens: aggregateUsage.cacheWrite,
      costUsd: aggregateUsage.cost,
    });

    const foregroundSingle = telemetryFromSingleResults({
      runId: "foreground-single",
      mode: "single",
      provenance,
      controls,
      results: [
        {
          agent: "worker",
          task: "telemetry test",
          exitCode: 0,
          modelIdentity: model,
          attemptedModels: ["anthropic/claude-final"],
          modelAttempts: [{ model: "anthropic/claude-final", success: true, usage: finalUsage }],
          usage: finalUsage,
        },
      ],
    });
    assert.deepEqual(foregroundSingle.steps[0]?.model, model);

    const asyncTelemetry = telemetryFromRunnerResults({
      runId: "async-fallback",
      mode: "single",
      provenance,
      controls,
      startedAt: 100,
      endedAt: 200,
      results: [
        {
          agent: "worker",
          success: true,
          modelIdentity: model,
          attemptedModels,
          modelAttempts,
        },
      ],
    });
    assert.ok(asyncTelemetry);
    assert.equal("model" in asyncTelemetry.steps[0]!, false);
    assert.deepEqual(asyncTelemetry.usage, {
      inputTokens: aggregateUsage.input,
      outputTokens: aggregateUsage.output,
      cacheReadTokens: aggregateUsage.cacheRead,
      cacheWriteTokens: aggregateUsage.cacheWrite,
      costUsd: aggregateUsage.cost,
    });

    const asyncSingle = telemetryFromRunnerResults({
      runId: "async-single",
      mode: "single",
      provenance,
      controls,
      startedAt: 100,
      endedAt: 200,
      results: [
        {
          agent: "worker",
          success: true,
          modelIdentity: model,
          attemptedModels: ["anthropic/claude-final"],
          modelAttempts: [{ model: "anthropic/claude-final", usage: finalUsage }],
        },
      ],
    });
    assert.ok(asyncSingle);
    assert.deepEqual(asyncSingle.steps[0]?.model, model);

    const partial = telemetryFromSingleResults({
      runId: "foreground-partial",
      mode: "single",
      provenance,
      controls,
      results: [
        {
          agent: "worker",
          task: "telemetry test",
          exitCode: 0,
          modelIdentity: model,
          attemptedModels: ["anthropic/claude-final"],
          modelAttempts: [{ model: "anthropic/claude-final", success: true }],
          usage: finalUsage,
        },
      ],
    });
    assert.equal("model" in partial.steps[0]!, false);
  });

  it("does not use planned status attempts for zero-attempt async results", () => {
    const model = { provider: "anthropic", model: "claude-planned" };
    const plannedUsage = {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.5,
      turns: 1,
    };
    // A checkpoint may expose the candidate selected for dispatch and stale
    // attempt data even when the terminal result contains no model attempt.
    const plannedStatusStep = {
      status: "failed",
      modelIdentity: model,
      attemptedModels: ["anthropic/claude-planned"],
      modelAttempts: [{ model: "anthropic/claude-planned", usage: plannedUsage }],
    };
    const telemetry = telemetryFromRunnerResults({
      runId: "async-zero-attempt",
      mode: "single",
      provenance,
      controls,
      startedAt: 100,
      endedAt: 200,
      results: [{ agent: "worker", success: false }],
      statusSteps: [plannedStatusStep],
    });

    assert.ok(telemetry);
    assert.equal("model" in telemetry.steps[0]!, false);
    assert.equal("usage" in telemetry.steps[0]!, false);
    assert.equal("usage" in telemetry, false);
  });

  it("omits attribution for present-empty and inconsistent attempt evidence", () => {
    const model = { provider: "anthropic", model: "claude-final" };
    const usage = {
      input: 10,
      output: 20,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 0.5,
      turns: 2,
    };
    const cases: Array<{
      name: string;
      attemptedModels?: string[];
      modelAttempts?: Array<{ model: string; success: boolean; usage: typeof usage }>;
    }> = [
      { name: "empty attemptedModels", attemptedModels: [] },
      { name: "empty modelAttempts", modelAttempts: [] },
      {
        name: "mismatched attempted model",
        attemptedModels: ["anthropic/claude-other"],
        modelAttempts: [{ model: "anthropic/claude-final", success: true, usage }],
      },
      {
        name: "inconsistent attempt model",
        attemptedModels: ["anthropic/claude-final"],
        modelAttempts: [{ model: "anthropic/claude-other", success: true, usage }],
      },
    ];

    for (const testCase of cases) {
      const { name, ...evidence } = testCase;
      const telemetry = telemetryFromSingleResults({
        runId: `foreground-inconsistent-${name}`,
        mode: "single",
        provenance,
        controls,
        results: [
          {
            agent: "worker",
            task: "telemetry test",
            exitCode: 0,
            modelIdentity: model,
            usage,
            ...evidence,
          },
        ],
      });
      const step = telemetry.steps[0]!;
      assert.equal("model" in step, false, name);
      assert.ok(step.usage, name);
    }
  });

  it("keeps persisted provenance and controls authoritative during merges", () => {
    const persistedControls: SubagentTelemetryControls = {
      needsAttentionAfterMs: 10,
      failedToolAttemptsBeforeAttention: 1,
      notifyOn: [],
      notifyChannels: ["event"],
    };
    const persisted = buildTelemetry({
      provenance: { ...provenance, tlhVersion: "old", loadedAt: 10 },
      controls: persistedControls,
      timing: { startedAt: 100, endedAt: 300, durationMs: 200 },
      outcome: { state: "cancelled", terminationReason: "cancelled" },
    });
    const current = buildTelemetry({
      provenance: { ...provenance, tlhVersion: "stale", loadedAt: 20 },
      controls: { ...controls, notifyChannels: ["async"] },
      timing: { startedAt: 100 },
      outcome: { state: "paused", terminationReason: "paused" },
    });

    const merged = mergeSubagentRunTelemetry(current, persisted, {
      persistedOutcomeWins: true,
    });
    assert.ok(merged);
    assert.deepEqual(merged.provenance, persisted.provenance);
    assert.deepEqual(merged.controls, persisted.controls);
    assert.deepEqual(merged.timing, persisted.timing);
    assert.deepEqual(merged.outcome, persisted.outcome);
  });

  it("preserves persisted terminal step outcomes without changing ordinary merge precedence", () => {
    const terminalStates = ["completed", "failed", "cancelled", "continued"] as const;
    for (const state of terminalStates) {
      const persisted = buildTelemetry({
        outcome: { state: "paused", terminationReason: "paused" },
        steps: [
          {
            index: 0,
            agent: "worker",
            model: { provider: "persisted", model: "terminal-model" },
            usage: {
              inputTokens: 1,
              outputTokens: 2,
              cacheReadTokens: 3,
              cacheWriteTokens: 4,
              costUsd: 0.1,
            },
            activity: { turns: 1, toolCalls: 2 },
            outcome: {
              state,
              terminationReason:
                state === "completed"
                  ? "completed"
                  : state === "cancelled"
                    ? "cancelled"
                    : "model_error",
            },
          },
        ],
      });
      const current = buildTelemetry({
        outcome: { state: "paused", terminationReason: "paused" },
        steps: [
          {
            index: 0,
            agent: "worker",
            model: { provider: "current", model: "source-model" },
            usage: {
              inputTokens: 10,
              outputTokens: 20,
              cacheReadTokens: 30,
              cacheWriteTokens: 40,
              costUsd: 0.5,
            },
            activity: { turns: 5, toolCalls: 6 },
            outcome: { state: "paused", terminationReason: "paused" },
          },
        ],
      });
      const currentSnapshot = structuredClone(current);
      const persistedSnapshot = structuredClone(persisted);

      const ordinary = mergeSubagentRunTelemetry(current, persisted);
      assert.equal(ordinary?.outcome?.state, "paused");
      assert.equal(ordinary?.steps[0]?.outcome?.state, "paused");

      const merged = mergeSubagentRunTelemetry(current, persisted, {
        persistedTerminalStepOutcomesWin: true,
      });
      assert.ok(merged);
      assert.equal(merged.outcome?.state, "paused");
      assert.deepEqual(merged.steps[0]?.outcome, persisted.steps[0]?.outcome);
      assert.deepEqual(merged.steps[0]?.usage, current.steps[0]?.usage);
      assert.deepEqual(merged.steps[0]?.activity, current.steps[0]?.activity);
      assert.deepEqual(merged.steps[0]?.model, current.steps[0]?.model);

      // The merge returns an independent envelope: mutating the selected
      // persisted outcome cannot mutate either caller-owned input.
      merged.steps[0]!.outcome!.state = "failed";
      assert.deepEqual(current, currentSnapshot);
      assert.deepEqual(persisted, persistedSnapshot);
    }
  });

  it("does not preserve paused, running, or queued persisted step outcomes", () => {
    for (const state of ["paused", "running", "queued"] as const) {
      const current = buildTelemetry({
        outcome: { state: "paused", terminationReason: "paused" },
        steps: [
          {
            index: 0,
            agent: "worker",
            outcome: {
              state: "completed",
              terminationReason: "completed",
              acceptanceStatus: "attested",
            },
          },
        ],
      });
      const persisted = buildTelemetry({
        outcome: { state: "paused", terminationReason: "paused" },
        steps: [
          {
            index: 0,
            agent: "worker",
            outcome: { state, acceptanceStatus: "skipped" },
          },
        ],
      });

      const merged = mergeSubagentRunTelemetry(current, persisted, {
        persistedTerminalStepOutcomesWin: true,
      });
      assert.ok(merged);
      assert.deepEqual(merged.steps[0]?.outcome, current.steps[0]?.outcome);
    }
  });

  it("clears stale model attribution when a newer usage snapshot omits it", () => {
    const persisted = buildTelemetry({
      steps: [
        {
          index: 0,
          agent: "worker",
          model: { provider: "anthropic", model: "claude-final" },
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.5,
          },
        },
      ],
    });
    const current = buildTelemetry({
      steps: [
        {
          index: 0,
          agent: "worker",
          usage: {
            inputTokens: 14,
            outputTokens: 25,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.7,
          },
        },
      ],
    });

    const merged = mergeSubagentRunTelemetry(current, persisted);
    assert.ok(merged);
    assert.equal("model" in merged.steps[0]!, false);
    assert.deepEqual(merged.steps[0]?.usage, current.steps[0]?.usage);
  });

  it("preserves legacy model attribution when newer metadata is absent", () => {
    const persisted = buildTelemetry({
      steps: [
        {
          index: 0,
          agent: "worker",
          model: { provider: "anthropic", model: "claude-legacy" },
        },
      ],
    });
    const current = buildTelemetry({
      steps: [{ index: 0, agent: "worker" }],
    });

    const merged = mergeSubagentRunTelemetry(current, persisted);
    assert.ok(merged);
    assert.deepEqual(merged.steps[0]?.model, {
      provider: "anthropic",
      model: "claude-legacy",
    });
  });

  it("carries continuation lineage and deduplicates source edges", () => {
    const source = buildTelemetry();
    const metadata = continuationTelemetryMetadata(source, "run-1", 0);
    assert.deepEqual(metadata, {
      provenance,
      lineage: { continuationFrom: { sourceRunId: "run-1", sourceStepIndex: 0 } },
    });

    const first = appendSubagentTelemetryContinuation(source, {
      sourceStepIndex: 0,
      continuationRunId: "run-2",
    });
    const second = appendSubagentTelemetryContinuation(first, {
      sourceStepIndex: 0,
      continuationRunId: "run-2",
    });
    assert.deepEqual(second?.lineage?.continuations, [
      { sourceStepIndex: 0, continuationRunId: "run-2" },
    ]);
  });

  it("captures the load timestamp once at the parent extension boundary", () => {
    const captured = captureSubagentTelemetryProvenance(456);
    assert.equal(captured.loadedAt, 456);
    assert.equal(typeof captured.tlhVersion, "string");
    assert.ok(captured.tlhVersion.length > 0);
    assert.equal(typeof captured.piVersion, "string");
    assert.ok(captured.piVersion.length > 0);
  });

  it("keeps legacy records without telemetry readable", () => {
    assert.equal(normalizeSubagentRunTelemetry(undefined), undefined);
    assert.equal(normalizeSubagentRunTelemetry({ schemaVersion: 1 }), undefined);
  });

  it("keeps the detached runner telemetry module free of runtime package imports", () => {
    const source = fs.readFileSync(
      path.resolve("extensions/subagents/src/shared/telemetry.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /from\s+["']@/);
    assert.doesNotMatch(source, /the-last-harness/);
    assert.match(source, /import type \{/);
    assert.match(source, /from "\.\/types\.ts"/);
  });

  it("guards every generated detached-runner import transitively", () => {
    const sourceRoot = path.resolve("extensions/subagents/src");
    const runnerPath = path.join(sourceRoot, "runs/background/subagent-runner.js");
    // types.js intentionally shares this one generated helper with the parent
    // extension. Keep the exception exact instead of opening the whole sibling
    // directory or allowing arbitrary imports outside the detached-runner tree.
    const allowedGeneratedDependency = path.resolve("extensions/shared/subagent-temp-root.js");
    const isAllowedImport = (resolved: string): boolean =>
      resolved.startsWith(`${sourceRoot}${path.sep}`) || resolved === allowedGeneratedDependency;
    const pending = [runnerPath];
    const visited = new Set<string>();
    const violations: string[] = [];
    const importPatterns = [
      /\b(?:from|import)\s*["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];

    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (!fs.existsSync(current)) {
        violations.push(`missing generated module: ${path.relative(sourceRoot, current)}`);
        continue;
      }
      const source = fs.readFileSync(current, "utf8");
      for (const match of source.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
        const expression = match[1]!.trim();
        if (
          !expression.startsWith('"') &&
          !expression.startsWith("'") &&
          !expression.startsWith("__rewriteRelativeImportExtension(")
        ) {
          violations.push(
            `${path.relative(sourceRoot, current)} has unapproved dynamic import '${expression}'`,
          );
        }
      }
      for (const pattern of importPatterns) {
        for (const match of source.matchAll(pattern)) {
          const specifier = match[1]!;
          if (specifier.startsWith("node:")) continue;
          if (!specifier.startsWith(".")) {
            violations.push(`${path.relative(sourceRoot, current)} has bare import '${specifier}'`);
            continue;
          }
          const resolved = path.resolve(path.dirname(current), specifier);
          if (!isAllowedImport(resolved)) {
            violations.push(
              `${path.relative(sourceRoot, current)} escapes generated source root via '${specifier}'`,
            );
            continue;
          }
          pending.push(resolved);
        }
      }
    }

    assert.deepEqual(violations, []);
    assert.equal(isAllowedImport(allowedGeneratedDependency), true);
    assert.equal(
      isAllowedImport(path.resolve("extensions/shared/project-agent-worktree.js")),
      false,
    );
  });
});
