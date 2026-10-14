import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { persistContinuationTelemetry } from "../../src/runs/background/async-control-resume.ts";
import { writeNormalizedLifecycleStatus } from "../../src/runs/shared/lifecycle-state.ts";
import {
  buildSubagentRunTelemetry,
  type SubagentRunTelemetry,
  type SubagentTelemetryProvenance,
} from "../../src/shared/telemetry.ts";
import { readStatus } from "../../src/shared/utils.ts";

const provenance: SubagentTelemetryProvenance = {
  tlhVersion: "0.41.0",
  piVersion: "0.85.1",
  installGeneration: "2026-09-13T16:31:49.000Z",
  loadedAt: 100,
};

function makeTelemetry(runId: string): SubagentRunTelemetry {
  return buildSubagentRunTelemetry({
    runId,
    execution: "foreground",
    mode: "single",
    provenance,
    controls: {
      enabled: true,
      needsAttentionAfterMs: 2_000,
      notifyOn: ["needs_attention"],
      notifyChannels: ["event", "async"],
    },
    startedAt: 100,
    endedAt: 250,
    steps: [{ index: 0, agent: "worker", outcome: { state: "completed" } }],
  });
}

/** Construct the minimal target shape expected by persistContinuationTelemetry. */
function makeAsyncTarget(
  asyncDir: string,
  state: "complete" | "failed" | "cancelled" | "paused",
  telemetry: SubagentRunTelemetry,
) {
  return {
    source: "async" as const,
    kind: "revive" as const,
    runId: "run-src",
    agent: "worker",
    index: 0,
    state,
    asyncDir,
    telemetry,
  };
}

describe("persistContinuationTelemetry", () => {
  it("records exactly one continuation lineage entry when reviving a completed source run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-resume-complete-"));
    try {
      const asyncDir = path.join(root, "run-src");
      const sourceTelemetry = makeTelemetry("run-src");

      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-src",
        mode: "single",
        state: "complete",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: root,
        sessionFile: path.join(root, "session.jsonl"),
        telemetry: sourceTelemetry,
      });

      const target = makeAsyncTarget(asyncDir, "complete", sourceTelemetry);
      persistContinuationTelemetry(target, "run-cont-1");

      const persisted = readStatus(asyncDir);
      const continuations = persisted?.telemetry?.lineage?.continuations ?? [];
      assert.equal(continuations.length, 1, "exactly one continuation entry");
      assert.equal(continuations[0]?.continuationRunId, "run-cont-1");

      // Calling again with the same continuationRunId must remain idempotent (no duplicates).
      persistContinuationTelemetry(target, "run-cont-1");
      const persistedAgain = readStatus(asyncDir);
      const continuationsAgain = persistedAgain?.telemetry?.lineage?.continuations ?? [];
      assert.equal(
        continuationsAgain.length,
        1,
        "idempotent: still exactly one entry after repeat",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records exactly one continuation lineage entry when reviving a failed source run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-resume-failed-"));
    try {
      const asyncDir = path.join(root, "run-src");
      const sourceTelemetry = makeTelemetry("run-src");

      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-src",
        mode: "single",
        state: "failed",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: root,
        sessionFile: path.join(root, "session.jsonl"),
        telemetry: sourceTelemetry,
      });

      persistContinuationTelemetry(
        makeAsyncTarget(asyncDir, "failed", sourceTelemetry),
        "run-cont-2",
      );

      const persisted = readStatus(asyncDir);
      const continuations = persisted?.telemetry?.lineage?.continuations ?? [];
      assert.equal(continuations.length, 1, "exactly one continuation entry for failed source");
      assert.equal(continuations[0]?.continuationRunId, "run-cont-2");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records exactly one continuation lineage entry when reviving a cancelled source run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-resume-cancelled-"));
    try {
      const asyncDir = path.join(root, "run-src");
      const sourceTelemetry = makeTelemetry("run-src");

      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-src",
        mode: "single",
        state: "cancelled",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: root,
        sessionFile: path.join(root, "session.jsonl"),
        telemetry: sourceTelemetry,
      });

      persistContinuationTelemetry(
        makeAsyncTarget(asyncDir, "cancelled", sourceTelemetry),
        "run-cont-3",
      );

      const persisted = readStatus(asyncDir);
      const continuations = persisted?.telemetry?.lineage?.continuations ?? [];
      assert.equal(continuations.length, 1, "exactly one continuation entry for cancelled source");
      assert.equal(continuations[0]?.continuationRunId, "run-cont-3");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not append continuation lineage for a paused source (continuation-launch transition handles it)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-resume-paused-"));
    try {
      const asyncDir = path.join(root, "run-src");
      const sourceTelemetry = makeTelemetry("run-src");

      // Simulate a paused source run where the continuation-launch transition has
      // already appended lineage (represented by an existing continuation entry).
      const telemetryWithLineage: SubagentRunTelemetry = {
        ...sourceTelemetry,
        lineage: {
          continuations: [{ continuationRunId: "run-cont-4", sourceStepIndex: 0 }],
        },
      };

      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run-src",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 150,
        cwd: root,
        sessionFile: path.join(root, "session.jsonl"),
        telemetry: telemetryWithLineage,
        lifecycle: {
          continuation: {
            phase: "completed",
            continuationRunId: "run-cont-4",
            claimedAt: 150,
            ownerPid: process.pid,
          },
        },
      });

      // persistContinuationTelemetry must not append a duplicate entry when source is paused.
      persistContinuationTelemetry(
        makeAsyncTarget(asyncDir, "paused", sourceTelemetry),
        "run-cont-4",
      );

      const persisted = readStatus(asyncDir);
      const continuations = persisted?.telemetry?.lineage?.continuations ?? [];
      assert.equal(
        continuations.length,
        1,
        "paused source: continuation-launch transition entry must not be duplicated",
      );
      assert.equal(continuations[0]?.continuationRunId, "run-cont-4");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
