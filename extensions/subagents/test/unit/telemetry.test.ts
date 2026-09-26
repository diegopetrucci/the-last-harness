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
import type { ResolvedControlConfig } from "../../src/shared/types.ts";
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
          modelAttempts: [
            {
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
          if (!resolved.startsWith(`${sourceRoot}${path.sep}`)) {
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
  });
});
