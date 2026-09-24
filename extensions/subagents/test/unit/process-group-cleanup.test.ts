import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanupOwnedProcessGroup,
  createOwnedProcessGroupOwner,
  formatOwnedProcessGroupCleanup,
  normalizeChildProcessCleanup,
  PROCESS_GROUP_CLEANUP_MAX_WAIT_MS,
  skipOwnedProcessGroupCleanup,
  supportsOwnedProcessGroupCleanup,
} from "../../src/runs/shared/process-group-cleanup.ts";

function missingProcess(): never {
  const error = new Error("gone") as NodeJS.ErrnoException;
  error.code = "ESRCH";
  throw error;
}

function permissionDenied(): never {
  const error = new Error("not permitted") as NodeJS.ErrnoException;
  error.code = "EPERM";
  throw error;
}

function unknownProbeFailure(): never {
  const error = new Error("probe unavailable") as NodeJS.ErrnoException;
  error.code = "EIO";
  throw error;
}

function liveChild(pid: number): { pid: number; exitCode: number | null; signalCode: null } {
  return { pid, exitCode: null, signalCode: null };
}

describe("cleanupOwnedProcessGroup", () => {
  it("exports the sum of its bounded escalation waits", () => {
    assert.equal(PROCESS_GROUP_CLEANUP_MAX_WAIT_MS, 4_000);
  });

  it("deterministically performs bounded SIGINT -> SIGTERM -> SIGKILL escalation", async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    let now = 0;
    let gone = false;
    const child = liveChild(4321);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    const result = await cleanupOwnedProcessGroup(4321, {
      owner,
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

  it("can continue at SIGTERM after the caller already sent SIGTERM", async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    let now = 0;
    let gone = false;
    const child = liveChild(2467);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    const result = await cleanupOwnedProcessGroup(2467, {
      owner,
      firstSignal: "SIGTERM",
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
    assert.deepEqual(result.signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(
      calls.filter((entry) => entry.signal !== 0).map((entry) => entry.signal),
      ["SIGTERM", "SIGKILL"],
    );
  });

  it("keeps the default awaited cleanup timer referenced until escalation settles", async () => {
    const child = liveChild(2468);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    const result = await cleanupOwnedProcessGroup(2468, {
      owner,
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
    const child = liveChild(9876);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    const result = await cleanupOwnedProcessGroup(9876, {
      owner,
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

  it("treats EPERM as an owned live group only with the live spawn proof", async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const child = liveChild(1357);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    let groupGone = false;
    const result = await cleanupOwnedProcessGroup(1357, {
      owner,
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        if (signal === 0) {
          if (groupGone) return missingProcess();
          return permissionDenied();
        }
        if (signal === "SIGTERM") groupGone = true;
        return true;
      },
      sleep: async () => {},
      intWaitMs: 1,
      termWaitMs: 1,
      killWaitMs: 1,
    });

    assert.equal(result.terminated, true);
    assert.deepEqual(result.signals, ["SIGINT", "SIGTERM"]);
    assert.deepEqual(
      calls.filter((entry) => entry.signal !== 0).map((entry) => entry.signal),
      ["SIGINT", "SIGTERM"],
    );
  });

  it("uses a direct-child fallback for macOS group EPERM and keeps the group probe authoritative", async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const child = liveChild(24610);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    let groupGone = false;
    const result = await cleanupOwnedProcessGroup(24610, {
      platform: "darwin",
      owner,
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        if (pid === -24610) {
          if (signal === 0) return groupGone ? missingProcess() : permissionDenied();
          return permissionDenied();
        }
        assert.equal(pid, 24610);
        assert.notEqual(signal, 0);
        groupGone = true;
        return true;
      },
      sleep: async () => {},
      intWaitMs: 1,
      termWaitMs: 1,
      killWaitMs: 1,
    });

    assert.equal(result.terminated, true);
    assert.deepEqual(result.signals, ["SIGINT"]);
    assert.deepEqual(calls, [
      { pid: -24610, signal: 0 },
      { pid: -24610, signal: "SIGINT" },
      { pid: 24610, signal: "SIGINT" },
      { pid: -24610, signal: 0 },
    ]);
    assert.match(result.warnings?.join(" ") ?? "", /directly to the live owned child/);
  });

  it("never signals persisted, reused, missing, or mismatched process-group ownership", async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const persisted = await cleanupOwnedProcessGroup(24601, {
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        return permissionDenied();
      },
    });
    assert.equal(persisted.terminated, false);
    assert.equal(persisted.attempted, false);
    assert.deepEqual(calls, []);

    const mismatchedChild = liveChild(24602);
    const mismatchedOwner = createOwnedProcessGroupOwner(mismatchedChild);
    assert.ok(mismatchedOwner);
    const mismatched = await cleanupOwnedProcessGroup(24603, {
      owner: mismatchedOwner,
      kill: () => permissionDenied(),
    });
    assert.equal(mismatched.terminated, false);
    assert.equal(mismatched.attempted, false);
    assert.deepEqual(calls, []);

    mismatchedChild.exitCode = 0;
    const reused = await cleanupOwnedProcessGroup(24602, {
      owner: mismatchedOwner,
      kill: () => permissionDenied(),
    });
    assert.equal(reused.terminated, false);
    assert.equal(reused.attempted, false);
    assert.deepEqual(calls, []);
  });

  it("fails closed on an unknown process-group probe without signaling", async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const owner = createOwnedProcessGroupOwner(liveChild(24603));
    assert.ok(owner);
    const result = await cleanupOwnedProcessGroup(24603, {
      owner,
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        if (signal === 0) return unknownProbeFailure();
        return true;
      },
    });

    assert.equal(result.terminated, false);
    assert.equal(result.attempted, false);
    assert.deepEqual(
      calls.filter((entry) => entry.signal !== 0),
      [],
    );
  });

  it("bounds escalation and reports failure when owned group and direct-child signals keep returning EPERM", async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const owner = createOwnedProcessGroupOwner(liveChild(24604));
    assert.ok(owner);
    let now = 0;
    const result = await cleanupOwnedProcessGroup(24604, {
      platform: "darwin",
      owner,
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        return permissionDenied();
      },
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
    assert.equal(result.attempted, true);
    assert.equal(result.escalatedToSigkill, true);
    assert.deepEqual(
      calls.filter((entry) => entry.signal !== 0),
      [
        { pid: -24604, signal: "SIGINT" },
        { pid: 24604, signal: "SIGINT" },
        { pid: -24604, signal: "SIGTERM" },
        { pid: 24604, signal: "SIGTERM" },
        { pid: -24604, signal: "SIGKILL" },
        { pid: 24604, signal: "SIGKILL" },
      ],
    );
    assert.match(result.warnings?.join(" ") ?? "", /Failed to send SIG(?:INT|TERM)/);
  });

  it("continues signaling surviving descendants after the leader exits", async () => {
    const child = liveChild(24605);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    let groupGone = false;
    const result = await cleanupOwnedProcessGroup(24605, {
      owner,
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        if (signal === 0) {
          child.exitCode = 0;
          return groupGone ? missingProcess() : true;
        }
        if (signal === "SIGTERM") groupGone = true;
        return true;
      },
      sleep: async () => {},
      intWaitMs: 1,
      termWaitMs: 1,
      killWaitMs: 1,
    });
    assert.equal(result.terminated, true);
    assert.deepEqual(
      calls.filter((call) => call.signal !== 0).map((call) => call.signal),
      ["SIGINT", "SIGTERM"],
    );
    assert.match(result.warnings?.join(" ") ?? "", /escalating cleanup/);
  });

  it("confirms a clean observed exit with no descendants without warning", async () => {
    const child = liveChild(24607);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    child.exitCode = 0;
    assert.equal(owner.observeExit(child.pid), true);
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const result = await cleanupOwnedProcessGroup(24607, {
      owner,
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        return missingProcess();
      },
    });
    assert.equal(result.terminated, true);
    assert.equal(result.liveProcessesDetected, false);
    assert.equal(result.warnings, undefined);
    assert.deepEqual(calls, [{ pid: -24607, signal: 0 }]);
  });

  it("consumes the current owner once and rejects reuse or reconstruction", async () => {
    const child = liveChild(24608);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const first = await cleanupOwnedProcessGroup(24608, {
      owner,
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        return missingProcess();
      },
    });
    assert.equal(first.terminated, true);
    const second = await cleanupOwnedProcessGroup(24608, {
      owner,
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        return true;
      },
    });
    assert.equal(second.attempted, false);
    const reconstructed = { ...owner };
    const external = await cleanupOwnedProcessGroup(24608, {
      owner: reconstructed,
      kill: () => {
        throw new Error("must not signal");
      },
    });
    assert.equal(external.attempted, false);
    assert.equal(calls.length, 1);
  });

  it("does not signal or infer cleanup on Windows", async () => {
    const calls: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    const result = await cleanupOwnedProcessGroup(24606, {
      platform: "win32",
      owner: createOwnedProcessGroupOwner(liveChild(24606)),
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        return true;
      },
    });
    assert.equal(result.supported, false);
    assert.equal(result.attempted, false);
    assert.equal(result.terminated, false);
    assert.equal(result.skippedReason, "unsupported_platform");
    assert.equal(calls.length, 0);
    const invalid = await cleanupOwnedProcessGroup(0, {
      platform: "win32",
      kill: (pid, signal) => {
        calls.push({ pid, signal });
        return true;
      },
    });
    assert.equal(invalid.skippedReason, "unsupported_platform");
    assert.deepEqual(calls, []);
    assert.equal(supportsOwnedProcessGroupCleanup("win32"), false);
  });

  it("skips unknown platforms instead of using POSIX group signals", async () => {
    const child = liveChild(24609);
    const owner = createOwnedProcessGroupOwner(child);
    assert.ok(owner);
    const result = await cleanupOwnedProcessGroup(24609, {
      platform: "unknown" as NodeJS.Platform,
      owner,
    });
    assert.equal(result.supported, false);
    assert.equal(result.attempted, false);
    assert.equal(result.skippedReason, "unsupported_platform");
  });

  it("bounds persisted cleanup warnings by UTF-8 bytes", () => {
    const result = normalizeChildProcessCleanup({
      supported: true,
      attempted: false,
      terminated: false,
      warnings: ["💣".repeat(1000)],
    });
    assert.ok(result);
    assert.ok(Buffer.byteLength(result.warnings?.[0] ?? "", "utf8") <= 512);
  });

  it("retains legacy unsupported cleanup records as unconfirmed", () => {
    const result = skipOwnedProcessGroupCleanup("unsupported_platform", undefined, false);
    assert.equal(result.supported, false);
    assert.equal(result.attempted, false);
    assert.equal(result.terminated, false);
    assert.doesNotMatch(formatOwnedProcessGroupCleanup(result), /no child process is running/i);
  });
});
