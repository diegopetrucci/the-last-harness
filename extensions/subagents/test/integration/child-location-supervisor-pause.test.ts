/**
 * Integration test: background pause location persistence.
 *
 * Verifies that when a background runner is supervisor-paused for a child
 * whose cwd differs from the parent's cwd, the persisted status.json contains
 * a childLocation snapshot reflecting the child's cwd.
 *
 * Uses the same isolated mock-Pi runtime as the async supervisor tests;
 * every spawned runner is awaited and reaped before the test exits.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import {
  ASYNC_DIR,
  executeAsyncSingle,
  startedMockPiPids,
  waitForAsyncState,
  waitForPidsToExit,
} from "../support/async-execution-helpers.ts";

describe(
  "child-location persistence through supervisor pause",
  {
    skip:
      process.platform === "win32"
        ? "cross-process supervisor pause delivery unreliable on Windows CI"
        : undefined,
  },
  () => {
    let tempDir: string;
    let mockPi: MockPi;

    before(() => {
      mockPi = createMockPi();
      mockPi.install();
    });

    after(() => {
      mockPi.uninstall();
    });

    beforeEach(() => {
      tempDir = createTempDir("pi-subagent-childloc-pause-");
      mockPi.reset();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    it("persists childLocation in status.json when a supervisor-paused background run has a differing child cwd", async () => {
      // Create a child directory that differs from the parent (tempDir).
      const childDir = fs.mkdtempSync(path.join(tempDir, "child-"));

      const id = `childloc-pause-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);

      // Mock-Pi emits a supervisor tool call, then exits quickly so the
      // test doesn't have to wait long for runner cleanup.
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
        ],
        keepAliveAfterFinalMessageMs: 500,
      });

      executeAsyncSingle!(id, {
        agent: "worker",
        task: "Ask for a supervisor decision.",
        agentConfig: makeAgent("worker"),
        ctx: {
          pi: { events: { emit() {} } },
          cwd: tempDir, // parent cwd
          currentSessionId: "session-childloc-1",
        },
        cwd: childDir, // child cwd — differs from parent
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });

      // Wait for the run to pause (contact_supervisor is processed).
      await waitForAsyncState(asyncDir, "paused", scaleTestTimeout(15_000));

      // Read and verify the persisted status.
      const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as {
        state?: string;
        steps?: Array<{
          childLocation?: { childCwd?: string; displayPath?: string };
        }>;
      };

      assert.equal(status.state, "paused", "run must be in paused state");

      const step = status.steps?.[0];
      assert.ok(
        step?.childLocation !== undefined,
        "persisted status.json must contain childLocation when child cwd differs from parent cwd",
      );
      assert.equal(
        step?.childLocation?.childCwd,
        childDir,
        "persisted childLocation.childCwd must match the task's child cwd",
      );
      assert.ok(
        typeof step?.childLocation?.displayPath === "string" &&
          step.childLocation.displayPath.length > 0,
        "persisted childLocation.displayPath must be a non-empty string",
      );

      // Reap spawned runner and mock-Pi processes before cleanup.
      const pids = startedMockPiPids(mockPi);
      await waitForPidsToExit(pids, `childloc-pause run ${id}`, scaleTestTimeout(10_000));
    });
  },
);
