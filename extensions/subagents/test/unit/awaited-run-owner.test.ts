import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createAwaitedRunOwner } from "../../src/runs/background/awaited-run-owner.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { createEventBus, makeRunnerStep } from "../support/helpers.ts";

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function ownerPaths(root: string, id: string): { asyncDir: string; resultPath: string } {
  return {
    asyncDir: path.join(root, "runs", id),
    resultPath: path.join(root, "results", `${id}.json`),
  };
}

describe("awaited owner prompt-variant projections", () => {
  it("retains a ticket-free variant through synthetic launch failure evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-awaited-owner-failure-"));
    const id = "awaited-ticket-free-failure";
    const owner = createAwaitedRunOwner({
      id,
      ...ownerPaths(root, id),
      mode: "single",
      plan: {
        kind: "single",
        task: makeRunnerStep("test-runner", "run the checks", { promptVariant: "ticket-free" }),
      },
      events: createEventBus(),
    });
    try {
      const result = await owner.fail("validation runner failed to launch");
      const child = result.details.results[0];
      assert.equal(result.isError, true);
      assert.equal(result.details.results.length, 1);
      assert.equal(child?.promptVariant, "ticket-free");
      assert.equal(child?.finalOutput, "validation runner failed to launch");
      assert.equal(child?.error, "validation runner failed to launch");
    } finally {
      owner.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the captured variant and cancellation details through synthetic abort", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-awaited-owner-cancel-"));
    const id = "awaited-ticket-free-cancel";
    const owner = createAwaitedRunOwner({
      id,
      ...ownerPaths(root, id),
      mode: "single",
      plan: {
        kind: "single",
        task: makeRunnerStep("test-runner", "cancel the checks", { promptVariant: "ticket-free" }),
      },
      events: createEventBus(),
      artifactGraceMs: 0,
      cleanupGraceMs: 0,
      pollIntervalMs: 1,
    });
    try {
      await owner.cancel();
      const result = await owner.promise;
      const child = result.details.results[0];
      assert.equal(result.isError, true);
      assert.equal(child?.promptVariant, "ticket-free");
      assert.equal(child?.terminationReason, "cancelled");
      assert.equal(child?.cancel?.summary, "Cancelled by parent abort.");
      assert.equal(child?.error, "Cancelled by parent abort.");
    } finally {
      owner.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a ticket-free variant and resume hints in synthetic paused projections", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-awaited-owner-pause-"));
    const id = "awaited-ticket-free-pause";
    const { asyncDir, resultPath } = ownerPaths(root, id);
    const pause = {
      kind: "awaiting_supervisor",
      requestedAt: 100,
      pausedAt: 101,
      summary: "Need a decision before continuing.",
    };
    writeJson(path.join(asyncDir, "status.json"), {
      runId: id,
      mode: "single",
      state: "paused",
      startedAt: 100,
      endedAt: 101,
      lifecycle: { generation: 0 },
      pause,
      steps: [
        {
          agent: "test-runner",
          status: "paused",
          promptVariant: "ticket-free",
          pause,
        },
      ],
    });
    const owner = createAwaitedRunOwner({
      id,
      asyncDir,
      resultPath,
      mode: "single",
      plan: {
        kind: "single",
        task: makeRunnerStep("test-runner", "pause the checks", { promptVariant: "ticket-free" }),
      },
      events: createEventBus(),
      expectedGeneration: 0,
      artifactGraceMs: 0,
      cleanupGraceMs: 0,
      pollIntervalMs: 1,
      pidLiveness: () => "dead",
    });
    try {
      owner.markSpawned(42);
      const result = await owner.promise;
      const child = result.details.results[0];
      assert.equal(result.isError, undefined);
      assert.equal(child?.promptVariant, "ticket-free");
      assert.equal(child?.terminationReason, "paused");
      assert.equal(child?.pause?.kind, "awaiting_supervisor");
      assert.match(result.content[0]?.text ?? "", /Resume unchanged:/);
      assert.match(result.content[0]?.text ?? "", /Resume with guidance:/);
    } finally {
      owner.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects captured variants into every synthetic parallel missing child", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-awaited-owner-missing-"));
    const id = "awaited-ticket-free-missing";
    const owner = createAwaitedRunOwner({
      id,
      ...ownerPaths(root, id),
      mode: "parallel",
      plan: {
        kind: "parallel",
        tasks: [
          makeRunnerStep("first", "first check", { promptVariant: "ticket-free" }),
          makeRunnerStep("second", "second check", { promptVariant: "ticket-free" }),
        ],
      },
      events: createEventBus(),
    });
    try {
      const result = await owner.fail("parallel runner failed to launch");
      assert.equal(result.details.results.length, 2);
      assert.deepEqual(
        result.details.results.map((child) => ({
          agent: child.agent,
          promptVariant: child.promptVariant,
          output: child.finalOutput,
          error: child.error,
        })),
        [
          {
            agent: "first",
            promptVariant: "ticket-free",
            output: "parallel runner failed to launch",
            error: "parallel runner failed to launch",
          },
          {
            agent: "second",
            promptVariant: "ticket-free",
            output: "parallel runner failed to launch",
            error: "parallel runner failed to launch",
          },
        ],
      );
    } finally {
      owner.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects captured variants into parallel fallback children with cancellation details", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-awaited-owner-fallback-"));
    const id = "awaited-ticket-free-fallback";
    const events = createEventBus();
    const owner = createAwaitedRunOwner({
      id,
      ...ownerPaths(root, id),
      mode: "parallel",
      plan: {
        kind: "parallel",
        tasks: [
          makeRunnerStep("first", "first check", { promptVariant: "ticket-free" }),
          makeRunnerStep("second", "second check", { promptVariant: "ticket-free" }),
        ],
      },
      events,
      expectedGeneration: 0,
    });
    try {
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id,
        runId: id,
        asyncDir: ownerPaths(root, id).asyncDir,
        generation: 0,
        state: "cancelled",
        success: false,
        summary: "Cancelled by parent abort.",
        error: "Cancelled by parent abort.",
        cancel: { summary: "Cancelled by parent abort.", cancelledAt: 100 },
      });
      const result = await owner.promise;
      assert.equal(result.details.results.length, 2);
      assert.ok(
        result.details.results.every(
          (child) =>
            child.promptVariant === "ticket-free" &&
            child.terminationReason === "cancelled" &&
            child.cancel?.summary === "Cancelled by parent abort.",
        ),
      );
      assert.equal(result.details.results[0]?.finalOutput, "Cancelled by parent abort.");
      assert.equal(result.details.results[0]?.error, "Cancelled by parent abort.");
    } finally {
      owner.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps all-missing legacy projections normal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-awaited-owner-legacy-"));
    const id = "awaited-legacy-normal";
    const owner = createAwaitedRunOwner({
      id,
      ...ownerPaths(root, id),
      mode: "single",
      plan: { kind: "single", task: makeRunnerStep("worker", "legacy check") },
      events: createEventBus(),
    });
    try {
      const result = await owner.fail("legacy launch failure");
      assert.equal(result.details.results.length, 1);
      assert.equal(result.details.results[0]?.promptVariant, "normal");
    } finally {
      owner.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed and conflicting genuine child evidence", async () => {
    for (const [suffix, promptVariant] of [
      ["malformed", { nested: true }],
      ["conflicting", "normal"],
    ] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `tlh-awaited-owner-${suffix}-`));
      const id = `awaited-ticket-free-${suffix}`;
      const events = createEventBus();
      const owner = createAwaitedRunOwner({
        id,
        ...ownerPaths(root, id),
        mode: "single",
        plan: {
          kind: "single",
          task: makeRunnerStep("test-runner", "check genuine evidence", {
            promptVariant: "ticket-free",
          }),
        },
        events,
        expectedGeneration: 0,
      });
      try {
        const artifact: unknown = {
          id,
          runId: id,
          asyncDir: ownerPaths(root, id).asyncDir,
          generation: 0,
          state: "failed",
          success: false,
          summary: "genuine child failure",
          error: "genuine child error",
          results: [
            {
              agent: "test-runner",
              promptVariant,
              state: "failed",
              success: false,
              output: "genuine child failure",
              error: "genuine child error",
            },
          ],
        };
        events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, artifact);
        const result = await owner.promise;
        assert.equal(result.isError, true);
        assert.deepEqual(result.details.results, []);
      } finally {
        owner.dispose();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
