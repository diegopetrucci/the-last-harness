/**
 * Real Pi-session end-to-end test for the async subagent lifecycle.
 *
 * Exercises the notification-driven parent continuation introduced by the
 * background completion infrastructure (ack-after-delivery, eventId dedupe,
 * subagent-notify + [tlh] nudge).  No real API keys are required; the parent
 * and child sessions both use faux providers.
 *
 * Assertions:
 *   1. The first tool result is a launch receipt only: asyncId present, no
 *      child output (results array is empty).
 *   2. Exactly one `subagent-notify` message arrives and triggers exactly one
 *      notification-driven parent turn.
 *   3. The parent's reply in that turn echoes the child-produced marker,
 *      proving the notification content reached the model context.
 *   4. No duplicate completion notices (notifyCount === 1).
 *   5. The child subprocess has exited by the time the notification arrives
 *      (the result file is written only after the child exits).
 *
 * Ticket: tlhf-dfoe (ported from a1e8c3b8; assertions checked against current
 * tlhf-ygs0 behavior where each notification chunk carries its own content).
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { RealAsyncSessionRun } from "../support/real-session-runner.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

const CHILD_MARKER = "ASYNC_CHILD_SESSION_OK";

const BOGUS_EXTRA_DIRS = path.join(os.tmpdir(), "nonexistent-pi-subagents-async-e2e-extra-dirs");
const BOGUS_PI_BINARY = path.join(os.tmpdir(), "nonexistent-pi-binary-async-e2e");
const BOGUS_PI_PACKAGE_ROOT = path.join(
  os.tmpdir(),
  "nonexistent-pi-coding-agent-package-root-async-e2e",
);
const ISOLATED_ENV_KEYS = [
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_FANOUT_CHILD",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_MAX_DEPTH",
  "PI_SUBAGENT_EXTRA_AGENT_DIRS",
  "PI_SUBAGENT_PARENT_SESSION",
  "PI_SUBAGENT_PI_BINARY",
  "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
] as const;

const win32Skip =
  process.platform === "win32"
    ? "fork argv1 pi-spawn hardening (TLH pi-spawn.ts delta) is incompatible with the upstream Windows harness; TLH targets macOS/Linux"
    : undefined;

describe("real Pi-session async subagent E2E", { skip: win32Skip }, () => {
  let run: RealAsyncSessionRun | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("delivers a launch receipt, triggers a notification-driven parent turn, and relays the child marker", async () => {
    const {
      routeParentThroughAsyncSubagent,
      runRealAsyncSubagentSession,
      subagentToolResults,
      subagentToolResultDetails,
      subagentNotifyMessages,
    } = await import("../support/real-session-runner.ts");

    const previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_FANOUT_CHILD = "1";
    process.env.PI_SUBAGENT_DEPTH = "1";
    process.env.PI_SUBAGENT_MAX_DEPTH = "1";
    process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = BOGUS_EXTRA_DIRS;
    process.env.PI_SUBAGENT_PARENT_SESSION = "polluted-parent";
    process.env.PI_SUBAGENT_PI_BINARY = BOGUS_PI_BINARY;
    process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = BOGUS_PI_PACKAGE_ROOT;

    try {
      run = await runRealAsyncSubagentSession({
        prompt: "Delegate async to a helper and relay the completion report.",
        childText: CHILD_MARKER,
        setup({ home }) {
          const developerPath = path.join(home, "tlh", "agents", "subagents", "developer.md");
          fs.mkdirSync(path.dirname(developerPath), { recursive: true });
          fs.writeFileSync(
            developerPath,
            "---\nname: developer\ndescription: Canonical developer subagent\ntools: read\n---\n\nReturn the task result.\n",
            "utf-8",
          );
        },
        respond: routeParentThroughAsyncSubagent({
          childMarker: CHILD_MARKER,
          subagentArgs: {
            agent: "developer",
            task: "Return the marker from the faux child provider.",
            agentScope: "user",
          },
        }),
      });

      // --- Assertion 1: first tool result is a launch receipt only ---
      // asyncId is present; results array is empty (no child output yet).
      const toolResults = subagentToolResults(run.parentSession);
      assert.equal(toolResults.length, 1, "expected exactly one subagent tool result");
      const details = subagentToolResultDetails(run.parentSession)[0] as {
        asyncId?: string;
        results?: unknown[];
        telemetry?: { run?: { execution?: string } };
      };
      assert.ok(
        typeof details.asyncId === "string" && details.asyncId.length > 0,
        `expected asyncId to be a non-empty string, got: ${JSON.stringify(details.asyncId)}`,
      );
      assert.ok(
        Array.isArray(details.results) && details.results.length === 0,
        `expected results to be an empty array (launch receipt), got: ${JSON.stringify(details.results)}`,
      );
      assert.doesNotMatch(
        toolResults[0]!,
        new RegExp(CHILD_MARKER),
        "launch receipt must not contain child output",
      );

      // --- Assertion 2 & 4: exactly one subagent-notify, one notification-driven parent turn ---
      const notifyMsgs = subagentNotifyMessages(run.parentSession);
      assert.equal(
        notifyMsgs.length,
        1,
        `expected exactly 1 subagent-notify message, got ${notifyMsgs.length}`,
      );
      assert.equal(run.notifyCount, 1, `expected notifyCount === 1, got ${run.notifyCount}`);
      // Exactly one notification-driven parent turn (agent_settled events after the receipt turn).
      assert.equal(
        run.notifyTurnCount,
        1,
        `expected exactly 1 notification-driven parent turn, got ${run.notifyTurnCount}`,
      );
      // Grace window: wait briefly, then confirm no late duplicate notify or parent turn arrived.
      const msgCountBeforeGrace = run.parentSession.messages.length;
      const notifyCountBeforeGrace = subagentNotifyMessages(run.parentSession).length;
      await new Promise<void>((resolve) => setTimeout(resolve, scaleTestTimeout(500)));
      assert.equal(
        subagentNotifyMessages(run.parentSession).length,
        notifyCountBeforeGrace,
        "no late subagent-notify message arrived during grace window",
      );
      assert.equal(
        run.parentSession.messages.length,
        msgCountBeforeGrace,
        "no late parent turn messages arrived during grace window",
      );

      // --- Assertion 3: parent relays the child marker in the notify turn ---
      assert.match(
        run.notifyTurnText,
        new RegExp(CHILD_MARKER),
        `expected notifyTurnText to contain ${CHILD_MARKER}, got: ${JSON.stringify(run.notifyTurnText)}`,
      );
      assert.match(
        run.responseText,
        new RegExp(CHILD_MARKER),
        `expected final responseText to contain ${CHILD_MARKER}`,
      );

      // --- Assertion 5: child subprocess exited and asyncDir status.json is terminal ---
      // The notify only arrives after the result-watcher picks up the completion file,
      // which the child writes upon exit. Verify explicitly via asyncDir/status.json.
      const detailsWithAsync = details as {
        asyncId?: string;
        results?: unknown[];
        asyncDir?: string;
      };
      const asyncDir = detailsWithAsync.asyncDir;
      assert.ok(
        typeof asyncDir === "string" && asyncDir.length > 0,
        `expected asyncDir in tool result details, got: ${JSON.stringify(asyncDir)}`,
      );
      const statusPath = path.join(asyncDir, "status.json");
      const statusRaw = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as {
        state?: string;
        pid?: number;
      };
      const terminalStates = new Set(["complete", "failed", "paused", "cancelled", "continued"]);
      assert.ok(
        terminalStates.has(statusRaw.state ?? ""),
        `expected asyncDir/status.json to be in a terminal state, got: ${JSON.stringify(statusRaw.state)}`,
      );
      // The child process PID must be recorded in status.json.
      assert.equal(
        typeof statusRaw.pid,
        "number",
        `expected a numeric pid in asyncDir/status.json, got: ${JSON.stringify(statusRaw.pid)}`,
      );
      const childPid = statusRaw.pid as number;
      const deadline = Date.now() + scaleTestTimeout(5_000);
      let isGone = false;
      while (Date.now() < deadline) {
        try {
          process.kill(childPid, 0);
          // Process still alive — wait a tick and retry.
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ESRCH") {
            isGone = true;
          }
          // EPERM means the process exists but we lack permission; treat as alive.
          break;
        }
      }
      assert.ok(
        isGone,
        `child process (pid=${childPid}) is still running after notification-driven turn`,
      );

      // Sanity: at least 3 model calls (tool dispatch, receipt ack, notify turn).
      assert.ok(run.modelCalls >= 3, `expected at least 3 model calls, got ${run.modelCalls}`);

      // --- Assertions ported from real-session-subagent.test.ts (foreground E2E, now deleted) ---
      // The old foreground test checked telemetry fields in the inline tool result:
      //   - run.mode === "single"
      //   - provenance and schemaVersion present
      //   - telemetry does not contain child output
      // In async-only mode, these are verified via the notify message details.
      // (execution:"foreground" assertion is intentionally not ported: async runs use "background".)
      const notifyTelemetry = (
        notifyMsgs[0]?.details as {
          telemetry?: {
            run?: { mode?: string; execution?: string };
            provenance?: unknown;
            schemaVersion?: number;
          };
        }
      )?.telemetry;
      assert.ok(
        notifyTelemetry,
        "expected telemetry in notify message details (ported from foreground E2E)",
      );
      assert.equal(
        notifyTelemetry.run?.mode,
        "single",
        "expected single mode in telemetry (ported from foreground E2E)",
      );
      assert.ok(
        notifyTelemetry.provenance,
        "expected provenance in telemetry (ported from foreground E2E)",
      );
      assert.ok(
        typeof notifyTelemetry.schemaVersion === "number" && notifyTelemetry.schemaVersion > 0,
        `expected positive schemaVersion in telemetry, got: ${JSON.stringify(notifyTelemetry.schemaVersion)} (ported from foreground E2E)`,
      );
      assert.doesNotMatch(
        JSON.stringify(notifyTelemetry),
        new RegExp(CHILD_MARKER),
        "telemetry must not contain child output (ported from foreground E2E)",
      );
      // Gap: old foreground E2E asserted execution:"foreground"; async run must assert "async".
      // The telemetry schema uses "async" (not "background") for background/detached runs.
      assert.equal(
        notifyTelemetry.run?.execution,
        "async",
        'expected execution to be "async" (background) in telemetry (async-only gap fill)',
      );
      // Gap: old foreground E2E asserted final response excludes CHILD_MISSING sentinel.
      assert.doesNotMatch(
        run.responseText,
        /CHILD_MISSING/,
        "final response must not contain a CHILD_MISSING sentinel (async-only gap fill)",
      );
    } finally {
      await run?.dispose();
      run = undefined;
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it(
    "omitted async (default background) delivers a launch receipt and triggers a notification-driven parent turn",
    { timeout: scaleTestTimeout(120_000) },
    async () => {
      const {
        routeParentThroughAsyncSubagent,
        runRealAsyncSubagentSession,
        subagentToolResults,
        subagentToolResultDetails,
        subagentNotifyMessages,
      } = await import("../support/real-session-runner.ts");

      const previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
      process.env.PI_SUBAGENT_CHILD = "1";
      process.env.PI_SUBAGENT_FANOUT_CHILD = "1";
      process.env.PI_SUBAGENT_DEPTH = "1";
      process.env.PI_SUBAGENT_MAX_DEPTH = "1";
      process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = BOGUS_EXTRA_DIRS;
      process.env.PI_SUBAGENT_PARENT_SESSION = "polluted-parent";
      process.env.PI_SUBAGENT_PI_BINARY = BOGUS_PI_BINARY;
      process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = BOGUS_PI_PACKAGE_ROOT;

      try {
        run = await runRealAsyncSubagentSession({
          prompt: "Delegate to a helper (omit async) and relay the completion report.",
          childText: CHILD_MARKER,
          setup({ home }) {
            const developerPath = path.join(home, "tlh", "agents", "subagents", "developer.md");
            fs.mkdirSync(path.dirname(developerPath), { recursive: true });
            fs.writeFileSync(
              developerPath,
              "---\nname: developer\ndescription: Canonical developer subagent\ntools: read\n---\n\nReturn the task result.\n",
              "utf-8",
            );
          },
          respond: routeParentThroughAsyncSubagent({
            childMarker: CHILD_MARKER,
            subagentArgs: {
              agent: "developer",
              task: "Return the marker from the faux child provider.",
              agentScope: "user",
            },
            omitAsync: true, // exercises the default background path (no async:true)
          }),
        });

        // Launch receipt: asyncId present, no child output in results array
        const toolResults = subagentToolResults(run.parentSession);
        assert.equal(toolResults.length, 1, "expected exactly one subagent tool result");
        const details = subagentToolResultDetails(run.parentSession)[0] as {
          asyncId?: string;
          results?: unknown[];
        };
        assert.ok(
          typeof details.asyncId === "string" && details.asyncId.length > 0,
          `expected asyncId for omitted-async dispatch, got: ${JSON.stringify(details.asyncId)}`,
        );
        assert.ok(
          Array.isArray(details.results) && details.results.length === 0,
          `expected empty results array (launch receipt), got: ${JSON.stringify(details.results)}`,
        );
        assert.doesNotMatch(
          toolResults[0]!,
          new RegExp(CHILD_MARKER),
          "launch receipt must not contain child output",
        );

        // Exactly one notification-driven parent turn relaying the child marker
        const notifyMsgs = subagentNotifyMessages(run.parentSession);
        assert.equal(
          notifyMsgs.length,
          1,
          `expected exactly 1 subagent-notify message for omitted-async, got ${notifyMsgs.length}`,
        );
        assert.match(
          run.notifyTurnText,
          new RegExp(CHILD_MARKER),
          `expected notifyTurnText to contain ${CHILD_MARKER}`,
        );
        assert.ok(run.modelCalls >= 3, `expected at least 3 model calls, got ${run.modelCalls}`);
      } finally {
        await run?.dispose();
        run = undefined;
        for (const [key, value] of previousEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );

  it(
    "rejects subagent dispatch when the SDK session is in print mode (Pi default for SDK/embedded)",
    { timeout: scaleTestTimeout(30_000), skip: win32Skip },
    async () => {
      const { runRealSubagentSession, subagentToolResults, subagentCall } =
        await import("../support/real-session-runner.ts");

      // Pi SDK defaults to "print" mode when bindExtensions is called without a mode.
      // Subagent dispatch must be rejected before any side effect in this mode.
      // The faux model must stop calling the tool after the first rejection, otherwise
      // the model would keep re-calling subagent for all 8 response slots.
      const printRun = await runRealSubagentSession({
        prompt: "Dispatch to developer agent.",
        childText: "never-reaches-child",
        extensionMode: "print",
        respond: (context) => {
          const msgs = context.messages as Array<{ role?: string; toolName?: string }>;
          const alreadyRejected = msgs.some(
            (m) => m.role === "toolResult" && m.toolName === "subagent",
          );
          if (alreadyRejected) return "Print-mode rejection acknowledged.";
          return subagentCall({ agent: "developer", task: "Implement the feature." });
        },
      });
      run = printRun as RealAsyncSessionRun;

      const toolResults = subagentToolResults(printRun.parentSession);
      assert.equal(toolResults.length, 1, "expected exactly one subagent tool result");
      assert.match(
        toolResults[0]!,
        /not available in non-interactive mode/,
        "print-mode session must receive the non-interactive rejection",
      );
    },
  );
});
