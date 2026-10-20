import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createBackgroundRunStatusOwner } from "../../src/runs/background/run-status-owner.ts";
import {
  ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS as INTERVAL,
  createActiveRuntimeTracker,
  malformedActiveRuntimeAccountingField,
} from "../../src/runs/shared/active-runtime.ts";
import { readStatus } from "../../src/shared/utils.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeOwner() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-runtime-checkpoint-"));
  dirs.push(root);
  const asyncDir = path.join(root, "async");
  const startedAt = 1_000_000;
  const owner = createBackgroundRunStatusOwner({
    id: "checkpoint-unit",
    asyncDir,
    cwd: root,
    plan: {
      kind: "single",
      task: {
        agent: "worker",
        task: "t",
        model: "mock/test-model",
        contextWindows: { "mock/test-model": 1_000 },
        inheritProjectContext: false,
        inheritSkills: false,
      },
    },
    overallStartTime: startedAt,
    artifactConfig: {
      mode: "compact",
      enabled: false,
      includeInput: false,
      includeOutput: false,
      includeJsonl: false,
      includeTranscript: false,
      includeMetadata: false,
      includeChildEventProjections: false,
      cleanupDays: 7,
    },
    appendEvent() {},
  });
  owner.statusPayload.steps[0]!.status = "running";
  owner.activeRuntimeTrackers.set(
    0,
    createActiveRuntimeTracker({ priorActiveRuntimeMs: 500, segmentStartedAt: startedAt }),
  );
  owner.writeStatusPayload();
  return { owner, asyncDir, startedAt };
}

describe("durable active-runtime checkpoints", () => {
  it("persists a periodic checkpoint that includes prior consumption", () => {
    const { owner, asyncDir, startedAt } = makeOwner();
    assert.equal(owner.checkpointActiveRuntime(startedAt + INTERVAL), true);
    const persisted = readStatus(asyncDir, { cache: false });
    assert.equal(persisted?.steps?.[0]?.activeRuntimeMs, 500 + INTERVAL);
    assert.equal(persisted?.activeRuntimeMs, 500 + INTERVAL);
  });

  it("freeze publishes one final advance, then never charges again (pause/terminal)", () => {
    const { owner, asyncDir, startedAt } = makeOwner();
    assert.equal(owner.checkpointActiveRuntime(startedAt + 10, true), true);
    assert.equal(owner.checkpointActiveRuntime(startedAt + 10 * INTERVAL), false);
    assert.equal(readStatus(asyncDir, { cache: false })?.steps?.[0]?.activeRuntimeMs, 510);
  });

  it("a stale in-memory writer can never shrink the persisted ledger", () => {
    const { owner, asyncDir, startedAt } = makeOwner();
    owner.checkpointActiveRuntime(startedAt + INTERVAL);
    owner.statusPayload.steps[0]!.activeRuntimeMs = 1;
    owner.statusPayload.activeRuntimeMs = 1;
    owner.writeStatusPayload();
    const persisted = readStatus(asyncDir, { cache: false });
    assert.equal(persisted?.steps?.[0]?.activeRuntimeMs, 500 + INTERVAL);
    assert.equal(persisted?.activeRuntimeMs, 500 + INTERVAL);
  });

  it("distinguishes absent legacy metadata from malformed present metadata", () => {
    assert.equal(malformedActiveRuntimeAccountingField({}), undefined);
    assert.equal(
      malformedActiveRuntimeAccountingField({
        activeRuntimeMs: 0,
        activeRuntimeCheckpointAt: 1,
        timeoutOwner: "run",
      }),
      undefined,
    );
    for (const bad of [
      { activeRuntimeMs: -1 },
      { activeRuntimeMs: Number.NaN },
      { activeRuntimeMs: null },
      { activeRuntimeCheckpointAt: "1" },
      { timeoutOwner: "ROLE" },
    ])
      assert.ok(malformedActiveRuntimeAccountingField(bad), JSON.stringify(bad));
  });
});
