import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { recoverStoppedLifecycleOwnership } from "../../src/runs/shared/lifecycle-state.ts";
import {
  admitSessionForResume,
  isResumableSessionCheckpoint,
} from "../../src/runs/shared/session-admission.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";
import { seedSessionRecord, seedUnreleasedLease } from "../support/session-record-fixture.ts";

const deadKill = (): boolean => {
  throw Object.assign(new Error("dead"), { code: "ESRCH" });
};

const recoverOptions = {
  kill: deadKill,
  isResumableSession: (file: string) => isResumableSessionCheckpoint(file, { kill: deadKill }),
};

describe("dead-owner pausing repair and session admission", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-resume-checkpoint-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const pausing = (sessionFile: string): AsyncStatus =>
    ({
      runId: "pausing-run",
      mode: "single",
      state: "pausing",
      pid: 424242,
      pause: { kind: "awaiting_supervisor", requestedAt: 1 },
      sessionFile,
      steps: [{ agent: "worker", status: "pausing", sessionFile }],
      startedAt: 1,
      lastUpdate: 1,
    }) as AsyncStatus;

  it("advertises a pause only for a written session with a clean-final record", () => {
    const sessionFile = path.join(root, "clean.jsonl");
    fs.writeFileSync(sessionFile, "");
    seedSessionRecord(sessionFile);
    const result = recoverStoppedLifecycleOwnership(pausing(sessionFile), recoverOptions);
    assert.equal(result.repaired, true);
    assert.equal(result.status.state, "paused");
  });

  it("never treats a nonexistent session file as a checkpoint", () => {
    const result = recoverStoppedLifecycleOwnership(
      pausing(path.join(root, "never-written.jsonl")),
      recoverOptions,
    );
    assert.equal(result.repaired, false);
    assert.equal(result.status.state, "pausing");
  });

  it("does not advertise resume for an abandoned session", () => {
    const sessionFile = path.join(root, "abandoned.jsonl");
    fs.writeFileSync(sessionFile, "");
    seedUnreleasedLease(sessionFile, 2_000_000_000);
    const result = recoverStoppedLifecycleOwnership(pausing(sessionFile), recoverOptions);
    assert.equal(result.repaired, false);
    const admission = admitSessionForResume(sessionFile, recoverOptions);
    assert.deepEqual(admission.ok ? undefined : admission.refusal, { kind: "abandoned" });
  });

  it("does not advertise resume for a session without a record", () => {
    const sessionFile = path.join(root, "legacy.jsonl");
    fs.writeFileSync(sessionFile, "");
    const result = recoverStoppedLifecycleOwnership(pausing(sessionFile), recoverOptions);
    assert.equal(result.repaired, false);
  });
});
