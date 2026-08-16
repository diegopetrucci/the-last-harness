import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanupOwnedProcessGroup,
  formatOwnedProcessGroupCleanup,
  skipOwnedProcessGroupCleanup,
} from "../../src/runs/shared/process-group-cleanup.ts";

function missingProcess(): never {
  const error = new Error("gone") as NodeJS.ErrnoException;
  error.code = "ESRCH";
  throw error;
}

describe("cleanupOwnedProcessGroup", () => {
  it("deterministically performs bounded SIGINT -> SIGTERM -> SIGKILL escalation", async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    let now = 0;
    let gone = false;
    const result = await cleanupOwnedProcessGroup(4321, {
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        if (signal === 0) return gone ? missingProcess() : true;
        if (signal === "SIGKILL") gone = true;
        return true;
      },
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      intWaitMs: 3,
      termWaitMs: 3,
      killWaitMs: 3,
      pollMs: 1,
    });

    assert.equal(result.terminated, true);
    assert.equal(result.escalatedToSigkill, true);
    assert.deepEqual(result.signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
    assert.deepEqual(
      calls.filter((entry) => entry.signal !== 0).map((entry) => entry.signal),
      ["SIGINT", "SIGTERM", "SIGKILL"],
    );
    assert.equal(
      calls.every((entry) => entry.pid === -4321),
      true,
    );
    assert.match(formatOwnedProcessGroupCleanup(result), /SIGKILL/);
  });

  it("keeps the default awaited cleanup timer referenced until escalation settles", async () => {
    const result = await cleanupOwnedProcessGroup(2468, {
      kill: () => true,
      intWaitMs: 1,
      termWaitMs: 1,
      killWaitMs: 1,
      pollMs: 1,
    });

    assert.equal(result.terminated, false);
    assert.equal(result.escalatedToSigkill, true);
  });

  it("fails closed when SIGKILL cleanup cannot be confirmed", async () => {
    let now = 0;
    const result = await cleanupOwnedProcessGroup(9876, {
      kill: () => true,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      intWaitMs: 2,
      termWaitMs: 2,
      killWaitMs: 2,
      pollMs: 1,
    });

    assert.equal(result.terminated, false);
    assert.equal(result.escalatedToSigkill, true);
    assert.deepEqual(result.signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
    assert.match(formatOwnedProcessGroupCleanup(result), /could not be confirmed/);
  });

  it("marks unsupported cleanup as unconfirmed rather than terminated", () => {
    const result = skipOwnedProcessGroupCleanup("unsupported_platform", undefined, false);
    assert.equal(result.supported, false);
    assert.equal(result.attempted, false);
    assert.equal(result.terminated, false);
    assert.doesNotMatch(formatOwnedProcessGroupCleanup(result), /no child process is running/i);
  });
});
