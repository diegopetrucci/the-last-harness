import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { releaseProjectAgentRunReference } from "../../src/agents/project-agent-snapshot.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import {
  buildSkippedAcceptanceLedger,
  resolveEffectiveAcceptance,
} from "../../src/runs/shared/acceptance.ts";
import {
  createProjectAgentControlEnvironment,
  createProjectGeneration,
  createState,
  makeContext,
  makeExecutor,
  revokeIfRegistered,
  text,
} from "../support/project-agent-control-fixtures.ts";

const testEnvironment = createProjectAgentControlEnvironment();

describe("project-agent resume retention failure", () => {
  beforeEach(testEnvironment.setup);
  afterEach(testEnvironment.teardown);

  it("rolls back the reserved pause claim when retaining the project generation throws", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-resume-retention-rollback-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-retention-rollback",
      "embedded.worker",
      "Retention rollback",
      "retention-rollback-digest",
    );
    let pausedRunId = "";
    let releaseSourceAfterAuthorization = false;
    let spawned = false;
    const state = createState();
    const executor = makeExecutor(
      root,
      state,
      {
        capability: generation.capability,
      },
      {
        runSync: async (
          _cwd: string,
          _agents: any[],
          _agent: string,
          _task: string,
          options: any,
        ) => {
          pausedRunId = options.runId;
          fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true });
          fs.writeFileSync(options.sessionFile, "", "utf8");
          const result = {
            agent: "embedded.worker",
            task: "foreground pause",
            projectAgent: generation.capture,
            acceptance: buildSkippedAcceptanceLedger({
              acceptance: resolveEffectiveAcceptance({
                agentName: "embedded.worker",
                task: "foreground pause",
                mode: "single",
              }),
              ledgerStatus: "skipped",
              runtimeCheckStatus: "not-applicable",
              id: "paused",
              message: "Acceptance will run after resume.",
            }),
            exitCode: 0,
            interrupted: true,
            finalOutput: "Paused foreground child.",
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            sessionFile: options.sessionFile,
            pause: { kind: "awaiting_supervisor", summary: "Need supervisor input." },
          };
          options.onSupervisorPauseTransition?.({ stage: "pausing", result, ownerPid: 12345 });
          options.onSupervisorPauseTransition?.({ stage: "paused", result });
          return result;
        },
        executeAsyncSingle: (runId: string) => {
          spawned = true;
          return { content: [{ type: "text", text: "resumed" }], details: { asyncId: runId } };
        },
      },
    );
    try {
      const initial = await executor.execute(
        "foreground",
        { agent: "embedded.worker", task: "foreground pause", agentScope: "project" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(initial.isError, undefined, text(initial));
      const statusPath = path.join(ASYNC_DIR, pausedRunId, "status.json");
      const before = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      assert.equal(before.state, "paused");

      releaseSourceAfterAuthorization = true;
      // The model registry snapshot is read after authorization and before the
      // pause claim; dropping the source reference there makes the later
      // reference transfer throw.
      const ctx = makeContext(root);
      ctx.modelRegistry = {
        getAvailable: () => {
          if (releaseSourceAfterAuthorization) releaseProjectAgentRunReference(pausedRunId);
          return [];
        },
      };
      const resumed = await executor.execute(
        "foreground-resume",
        { action: "resume", id: pausedRunId, message: "Continue." },
        new AbortController().signal,
        undefined,
        ctx,
      );
      assert.equal(resumed.isError, true);
      assert.match(text(resumed), /could not retain the authorized generation/);
      assert.equal(spawned, false);

      const after = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      assert.equal(after.state, "paused");
      const reserved = JSON.stringify(after).includes('"phase":"reserved"');
      assert.equal(reserved, false, "reserved continuation claim must be rolled back");
    } finally {
      releaseProjectAgentRunReference(pausedRunId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(path.join(ASYNC_DIR, pausedRunId), { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
