import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  acceptChildMessageRequest,
  childMessageAckPath,
  consumeChildMessageAcceptance,
  consumeChildMessageRequests,
  consumeInterruptRequest,
  deliverInterruptRequest,
  enqueueStepChildMessage,
  interruptRequestPath,
  requestAsyncInterrupt,
  requestAsyncResume,
  requestAsyncSteer,
  steerRequestsDir,
  stepSteerInboxDir,
  waitForChildMessageAcceptance,
  watchAsyncControlInbox,
  writeChildMessageAcceptance,
  writeChildMessageAcceptanceForRequest,
} from "../../src/runs/background/control-channel.ts";

function tmpAsyncDir(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  return path.join(root, "run");
}

function cleanup(asyncDir: string): void {
  fs.rmSync(path.dirname(asyncDir), { recursive: true, force: true });
}

describe("control channel: request file", () => {
  it("writes a parseable interrupt request, creating the inbox dir", () => {
    const asyncDir = tmpAsyncDir("pi-control-write-");
    try {
      const requestPath = requestAsyncInterrupt(asyncDir, { source: "test" }, { now: () => 999 });
      assert.equal(requestPath, interruptRequestPath(asyncDir));
      const data = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
      assert.equal(data.type, "interrupt");
      assert.equal(data.ts, 999);
      assert.equal(data.source, "test");
    } finally {
      cleanup(asyncDir);
    }
  });

  it("keeps the request type authoritative even for untyped callers", () => {
    const asyncDir = tmpAsyncDir("pi-control-write-type-");
    try {
      const requestPath = requestAsyncInterrupt(
        asyncDir,
        { type: "not-interrupt", source: "test" } as any,
        {
          now: () => 999,
        },
      );
      const data = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
      assert.equal(data.type, "interrupt");
      assert.equal(data.source, "test");
    } finally {
      cleanup(asyncDir);
    }
  });

  it("consumes a pending request exactly once and removes the file", () => {
    const asyncDir = tmpAsyncDir("pi-control-consume-");
    try {
      requestAsyncInterrupt(asyncDir);
      assert.equal(consumeInterruptRequest(asyncDir), true);
      assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
      assert.equal(consumeInterruptRequest(asyncDir), false);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("removes a malformed request directory instead of firing forever", () => {
    const asyncDir = tmpAsyncDir("pi-control-consume-dir-");
    try {
      fs.mkdirSync(interruptRequestPath(asyncDir), { recursive: true });
      assert.equal(consumeInterruptRequest(asyncDir), true);
      assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
      assert.equal(consumeInterruptRequest(asyncDir), false);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("writes and consumes ordered steer requests", () => {
    const asyncDir = tmpAsyncDir("pi-control-steer-");
    try {
      requestAsyncSteer(asyncDir, {
        message: "  later guidance  ",
        targetIndex: 1,
        id: "b",
        ts: 200,
        source: "test",
      });
      requestAsyncSteer(asyncDir, { message: "first guidance", id: "a", ts: 100 });
      assert.equal(fs.readdirSync(steerRequestsDir(asyncDir)).length, 2);

      assert.deepEqual(consumeChildMessageRequests(asyncDir), [
        { type: "steer", id: "a", ts: 100, message: "first guidance" },
        {
          type: "steer",
          id: "b",
          ts: 200,
          message: "later guidance",
          targetIndex: 1,
          source: "test",
        },
      ]);
      assert.deepEqual(consumeChildMessageRequests(asyncDir), []);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("keeps steer request ids out of filesystem paths", () => {
    const asyncDir = tmpAsyncDir("pi-control-steer-safe-name-");
    try {
      const requestPath = requestAsyncSteer(asyncDir, {
        message: "safe",
        id: "../outside\\bad:thing",
        ts: 1,
      });
      assert.equal(path.dirname(requestPath), steerRequestsDir(asyncDir));
      assert.equal(
        path.basename(requestPath),
        `0000000000001-${Buffer.from("../outside\\bad:thing").toString("base64url")}.json`,
      );
      assert.deepEqual(consumeChildMessageRequests(asyncDir), [
        { type: "steer", id: "../outside\\bad:thing", ts: 1, message: "safe" },
      ]);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("does not deliver a steer request if another consumer removed it first", () => {
    const asyncDir = tmpAsyncDir("pi-control-steer-concurrent-");
    try {
      requestAsyncSteer(asyncDir, { message: "already taken", id: "s", ts: 1 });
      const fsImpl = {
        existsSync: fs.existsSync,
        readdirSync: fs.readdirSync,
        readFileSync: fs.readFileSync,
        rmSync: (target: fs.PathLike, options?: fs.RmOptions) => {
          fs.rmSync(target, options);
          const error = new Error("already removed") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      };
      assert.deepEqual(consumeChildMessageRequests(asyncDir, fsImpl), []);
      assert.deepEqual(consumeChildMessageRequests(asyncDir), []);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("enqueues a steer request for a specific child inbox", () => {
    const asyncDir = tmpAsyncDir("pi-control-step-steer-");
    try {
      enqueueStepChildMessage(asyncDir, 2, {
        type: "steer",
        id: "s1",
        ts: 300,
        message: "focus",
        targetIndex: 0,
      });
      const request = JSON.parse(
        fs.readFileSync(
          path.join(
            stepSteerInboxDir(asyncDir, 2),
            fs.readdirSync(stepSteerInboxDir(asyncDir, 2))[0]!,
          ),
          "utf-8",
        ),
      );
      assert.equal(request.targetIndex, 2);
      assert.equal(request.message, "focus");
    } finally {
      cleanup(asyncDir);
    }
  });

  it("rejects empty steer messages and invalid target indexes", () => {
    const asyncDir = tmpAsyncDir("pi-control-steer-invalid-");
    try {
      assert.throws(
        () => requestAsyncSteer(asyncDir, { message: "   " }),
        /steer message must not be empty/,
      );
      assert.throws(
        () => requestAsyncSteer(asyncDir, { message: "ok", targetIndex: -1 }),
        /targetIndex/,
      );
    } finally {
      cleanup(asyncDir);
    }
  });

  it("consumes mixed child messages in timestamp order", () => {
    const asyncDir = tmpAsyncDir("pi-control-mixed-requests-");
    try {
      requestAsyncResume(asyncDir, {
        message: "resume guidance",
        targetIndex: 1,
        id: "resume",
        ts: 1,
      });
      requestAsyncSteer(asyncDir, {
        message: "steer guidance",
        targetIndex: 0,
        id: "steer",
        ts: 2,
      });

      assert.deepEqual(consumeChildMessageRequests(asyncDir), [
        {
          type: "resume",
          id: "resume",
          ts: 1,
          message: "resume guidance",
          targetIndex: 1,
        },
        { type: "steer", id: "steer", ts: 2, message: "steer guidance", targetIndex: 0 },
      ]);
      assert.deepEqual(consumeChildMessageRequests(asyncDir), []);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("writes resume requests through the shared child-message inbox", () => {
    const asyncDir = tmpAsyncDir("pi-control-resume-");
    try {
      const requestPath = requestAsyncResume(asyncDir, {
        message: "Continue with the latest findings.",
        targetIndex: 2,
        deliveryDeadlineAt: 75,
        id: "resume-1",
        ts: 50,
        source: "async-resume",
      });
      const request = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
      assert.deepEqual(request, {
        type: "resume",
        id: "resume-1",
        ts: 50,
        message: "Continue with the latest findings.",
        targetIndex: 2,
        deliveryDeadlineAt: 75,
        source: "async-resume",
      });
    } finally {
      cleanup(asyncDir);
    }
  });
});

describe("control channel: native child-message acceptance", () => {
  it("atomically writes and consumes an acknowledgement keyed by request id", () => {
    const asyncDir = tmpAsyncDir("pi-control-ack-");
    try {
      writeChildMessageAcceptance(asyncDir, {
        requestId: "resume/1",
        type: "resume",
        status: "accepted",
        ts: 10,
        acceptedIndexes: [1],
      });
      assert.equal(fs.existsSync(childMessageAckPath(asyncDir, "resume/1")), true);
      assert.deepEqual(consumeChildMessageAcceptance(asyncDir, "resume/1")?.acceptedIndexes, [1]);
      assert.equal(fs.existsSync(childMessageAckPath(asyncDir, "resume/1")), false);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("does not leave acknowledgements for steer delivery while resume delivery does", () => {
    const asyncDir = tmpAsyncDir("pi-control-ack-required-");
    try {
      const common = { status: "accepted" as const, ts: 10, acceptedIndexes: [0] };
      const steer = {
        type: "steer" as const,
        id: "steer-1",
        ts: 1,
        message: "focus",
        targetIndex: 0,
      };
      const resume = {
        type: "resume" as const,
        id: "resume-1",
        ts: 2,
        message: "continue",
        targetIndex: 0,
      };
      assert.equal(writeChildMessageAcceptanceForRequest(asyncDir, steer, common), undefined);
      assert.equal(fs.existsSync(childMessageAckPath(asyncDir, steer.id)), false);
      assert.equal(
        writeChildMessageAcceptanceForRequest(asyncDir, resume, common),
        childMessageAckPath(asyncDir, resume.id),
      );
      assert.equal(fs.existsSync(childMessageAckPath(asyncDir, resume.id)), true);
      assert.equal(consumeChildMessageAcceptance(asyncDir, resume.id)?.status, "accepted");
    } finally {
      cleanup(asyncDir);
    }
  });

  it("waits for acceptance and cleans up the acknowledgement artifact", async () => {
    const asyncDir = tmpAsyncDir("pi-control-ack-wait-");
    let now = 0;
    try {
      const result = await waitForChildMessageAcceptance({
        asyncDir,
        requestId: "r1",
        timeoutMs: 100,
        pollIntervalMs: 10,
        now: () => now,
        delay: async (ms) => {
          now += ms;
          if (now === 20)
            writeChildMessageAcceptance(asyncDir, {
              requestId: "r1",
              type: "resume",
              status: "accepted",
              ts: now,
              acceptedIndexes: [0],
            });
        },
      });
      assert.equal(result.outcome, "acknowledged");
      assert.equal(fs.existsSync(childMessageAckPath(asyncDir, "r1")), false);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("rejects an expired nested resume before enqueueing into a leaf inbox", () => {
    let enqueueCount = 0;
    const result = acceptChildMessageRequest({
      request: {
        type: "resume",
        id: "expired",
        ts: 1,
        message: "too late",
        targetIndex: 0,
        deliveryDeadlineAt: 99,
      },
      steps: [{ status: "running" }],
      enqueue: () => enqueueCount++,
      now: () => 100,
    });
    assert.equal(enqueueCount, 0);
    assert.deepEqual(result, {
      acceptedIndexes: [],
      rejected: [{ index: 0, reason: "delivery deadline expired" }],
    });
  });

  it("preserves top-level child messages without delivery deadlines", () => {
    let enqueueCount = 0;
    const result = acceptChildMessageRequest({
      request: { type: "resume", id: "top-level", ts: 1, message: "continue", targetIndex: 0 },
      steps: [{ status: "running" }],
      enqueue: () => enqueueCount++,
      now: () => Number.MAX_SAFE_INTEGER,
    });
    assert.equal(enqueueCount, 1);
    assert.deepEqual(result, { acceptedIndexes: [0], rejected: [] });
  });

  it("rejects runner races before leaf enqueue and reports enqueue failures", () => {
    const request = {
      type: "resume" as const,
      id: "r1",
      ts: 1,
      message: "continue",
      targetIndex: 1,
    };
    let enqueueCount = 0;
    const finished = acceptChildMessageRequest({
      request,
      steps: [{ status: "running" }, { status: "complete" }],
      enqueue: () => enqueueCount++,
    });
    assert.deepEqual(finished, {
      acceptedIndexes: [],
      rejected: [{ index: 1, reason: "child is complete" }],
    });
    assert.equal(enqueueCount, 0);
    const failed = acceptChildMessageRequest({
      request: { ...request, targetIndex: 0 },
      steps: [{ status: "running" }],
      enqueue: () => {
        throw new Error("disk full");
      },
    });
    assert.deepEqual(failed, {
      acceptedIndexes: [],
      rejected: [{ index: 0, reason: "leaf inbox enqueue failed: disk full" }],
    });
  });
});

describe("control channel: deliverInterruptRequest", () => {
  it("writes the portable request and signals best-effort when kill succeeds", () => {
    const asyncDir = tmpAsyncDir("pi-control-deliver-ok-");
    try {
      const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
      deliverInterruptRequest({
        asyncDir,
        pid: 4242,
        signal: "SIGUSR2",
        kill: (pid, signal) => {
          kills.push({ pid, signal });
          return true;
        },
      });
      assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
      assert.deepEqual(kills, [{ pid: 4242, signal: "SIGUSR2" }]);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("still writes the request when the OS signal throws ENOSYS (Windows)", () => {
    const asyncDir = tmpAsyncDir("pi-control-deliver-enosys-");
    try {
      assert.doesNotThrow(() =>
        deliverInterruptRequest({
          asyncDir,
          pid: 4242,
          kill: () => {
            const error = new Error("kill ENOSYS") as NodeJS.ErrnoException;
            error.code = "ENOSYS";
            throw error;
          },
        }),
      );
      assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("surfaces non-portability signal failures and removes the stale request", () => {
    const asyncDir = tmpAsyncDir("pi-control-deliver-esrch-");
    try {
      assert.throws(
        () =>
          deliverInterruptRequest({
            asyncDir,
            pid: 4242,
            kill: () => {
              const error = new Error("missing process") as NodeJS.ErrnoException;
              error.code = "ESRCH";
              throw error;
            },
          }),
        /missing process/,
      );
      assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("skips signalling when no live pid is provided", () => {
    const asyncDir = tmpAsyncDir("pi-control-deliver-nopid-");
    try {
      let killed = false;
      deliverInterruptRequest({
        asyncDir,
        kill: () => {
          killed = true;
          return true;
        },
      });
      assert.equal(killed, false);
      assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
    } finally {
      cleanup(asyncDir);
    }
  });
});

describe("control channel: watchAsyncControlInbox", () => {
  type WatchHarness = {
    fsImpl: import("../../src/runs/background/control-channel.ts").ControlChannelFs;
    timers: import("../../src/runs/background/control-channel.ts").ControlChannelTimers;
    trigger: () => void;
    closed: () => boolean;
  };

  function harness(): WatchHarness {
    let listener: (() => void) | undefined;
    let closed = false;

    function watch(
      filename: fs.PathLike,
      options?: fs.WatchOptionsWithStringEncoding | BufferEncoding | null,
      callback?: fs.WatchListener<string>,
    ): fs.FSWatcher;
    function watch(
      filename: fs.PathLike,
      options: fs.WatchOptionsWithBufferEncoding | "buffer",
      callback: fs.WatchListener<NonSharedBuffer>,
    ): fs.FSWatcher;
    function watch(
      filename: fs.PathLike,
      options: fs.WatchOptions | BufferEncoding | "buffer" | null,
      callback: fs.WatchListener<string | NonSharedBuffer>,
    ): fs.FSWatcher;
    function watch(filename: fs.PathLike, callback: fs.WatchListener<string>): fs.FSWatcher;
    function watch(filename: fs.PathLike, ...args: unknown[]): fs.FSWatcher {
      const callback = args.find((arg) => typeof arg === "function");
      listener = () => {
        if (typeof callback === "function") callback();
      };
      const watcher = fs.watch(filename);
      const close = watcher.close.bind(watcher);
      watcher.close = () => {
        closed = true;
        close();
      };
      return watcher;
    }

    const fsImpl = {
      mkdirSync: fs.mkdirSync,
      existsSync: fs.existsSync,
      rmSync: fs.rmSync,
      readdirSync: fs.readdirSync,
      readFileSync: fs.readFileSync,
      watch,
    } satisfies WatchHarness["fsImpl"];
    const timers: WatchHarness["timers"] = { setInterval, clearInterval };
    return { fsImpl, timers, trigger: () => listener?.(), closed: () => closed };
  }

  it("fires on a request that arrived before the watcher started", () => {
    const asyncDir = tmpAsyncDir("pi-control-watch-early-");
    try {
      requestAsyncInterrupt(asyncDir);
      let fired = 0;
      const h = harness();
      const dispose = watchAsyncControlInbox(asyncDir, {
        onInterrupt: () => fired++,
        fs: h.fsImpl,
        timers: h.timers,
      });
      assert.equal(fired, 1);
      assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
      dispose();
    } finally {
      cleanup(asyncDir);
    }
  });

  it("fires once per request via the watch event and stops after dispose", () => {
    const asyncDir = tmpAsyncDir("pi-control-watch-event-");
    try {
      let fired = 0;
      const h = harness();
      const dispose = watchAsyncControlInbox(asyncDir, {
        onInterrupt: () => fired++,
        fs: h.fsImpl,
        timers: h.timers,
      });
      assert.equal(fired, 0);

      requestAsyncInterrupt(asyncDir);
      h.trigger();
      assert.equal(fired, 1);
      assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);

      // No pending request → spurious event is a no-op.
      h.trigger();
      assert.equal(fired, 1);

      dispose();
      assert.equal(h.closed(), true);

      // After dispose, even a fresh request is ignored.
      requestAsyncInterrupt(asyncDir);
      h.trigger();
      assert.equal(fired, 1);
    } finally {
      cleanup(asyncDir);
    }
  });

  it("delivers steer requests without firing interrupt", () => {
    const asyncDir = tmpAsyncDir("pi-control-watch-steer-");
    try {
      let interrupted = 0;
      const steers: Array<{ message: string; targetIndex?: number }> = [];
      const h = harness();
      const dispose = watchAsyncControlInbox(asyncDir, {
        onInterrupt: () => interrupted++,
        onSteer: (request) =>
          steers.push({ message: request.message, targetIndex: request.targetIndex }),
        fs: h.fsImpl,
        timers: h.timers,
      });

      requestAsyncSteer(asyncDir, { message: "go narrower", targetIndex: 0, id: "s", ts: 1 });
      h.trigger();

      assert.equal(interrupted, 0);
      assert.deepEqual(steers, [{ message: "go narrower", targetIndex: 0 }]);
      dispose();
    } finally {
      cleanup(asyncDir);
    }
  });

  it("delivers resume requests through the dedicated callback without firing interrupt", () => {
    const asyncDir = tmpAsyncDir("pi-control-watch-resume-");
    try {
      let interrupted = 0;
      const resumes: Array<{ message: string; targetIndex?: number }> = [];
      const h = harness();
      const dispose = watchAsyncControlInbox(asyncDir, {
        onInterrupt: () => interrupted++,
        onResume: (request) =>
          resumes.push({ message: request.message, targetIndex: request.targetIndex }),
        fs: h.fsImpl,
        timers: h.timers,
      });

      requestAsyncResume(asyncDir, {
        message: "Continue with the narrowed scope.",
        targetIndex: 1,
        id: "resume",
        ts: 2,
      });
      h.trigger();

      assert.equal(interrupted, 0);
      assert.deepEqual(resumes, [{ message: "Continue with the narrowed scope.", targetIndex: 1 }]);
      dispose();
    } finally {
      cleanup(asyncDir);
    }
  });
});
