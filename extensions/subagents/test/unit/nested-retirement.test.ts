import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import {
  clearForegroundMessageInbox,
  registerForegroundMessageInbox,
} from "../../src/runs/foreground/foreground-control.ts";
import { NESTED_EVENTS_DIR } from "../../src/runs/shared/nested-events.ts";
import {
  RETIRED_NESTED_ROUTE_ENV_VARS,
  SUBAGENT_CHILD_ENV,
} from "../../src/runs/shared/pi-args.ts";
import {
  type ExtensionConfig,
  type ForegroundRunControl,
  type SubagentState,
} from "../../src/shared/types.ts";
import { makeAgent, makeExtensionAPI, makeMinimalCtx } from "../support/helpers.ts";

function createState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

class CapturingForegroundControls extends Map<string, ForegroundRunControl> {
  readonly capturedRunIds: string[] = [];
  readonly capturedControls: ForegroundRunControl[] = [];

  override set(runId: string, control: ForegroundRunControl): this {
    this.capturedRunIds.push(runId);
    this.capturedControls.push(control);
    return super.set(runId, control);
  }
}

function createExecutor(state: SubagentState, sessionRoot?: string) {
  const config: ExtensionConfig = { maxSubagentDepth: 2, control: {} };
  return createSubagentExecutor({
    pi: makeExtensionAPI({ getSessionName: () => "parent" }),
    state,
    config,
    tempArtifactsDir: os.tmpdir(),
    getSubagentSessionRoot: (parentSessionFile) =>
      sessionRoot ??
      (parentSessionFile
        ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"))
        : fs.mkdtempSync(path.join(os.tmpdir(), "tlh-retirement-session-"))),
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [makeAgent("worker")] }),
  });
}

describe("nested orchestration retirement", () => {
  it("isolates foreground message inboxes across direct control lifecycles", () => {
    const first: ForegroundRunControl = {
      runId: "same-run",
      mode: "single",
      startedAt: 1,
      updatedAt: 1,
    };
    const firstInbox = registerForegroundMessageInbox(first, first.runId, 0);
    fs.writeFileSync(path.join(firstInbox, "stale.json"), "{}", "utf-8");
    const firstRoot = first.messageInboxRoot!;

    const second: ForegroundRunControl = {
      runId: "same-run",
      mode: "single",
      startedAt: 2,
      updatedAt: 2,
    };
    const secondInbox = registerForegroundMessageInbox(second, second.runId, 0);
    try {
      assert.notEqual(second.messageInboxRoot, firstRoot);
      assert.equal(fs.existsSync(path.join(secondInbox, "stale.json")), false);
    } finally {
      clearForegroundMessageInbox(first, 0);
      clearForegroundMessageInbox(second, 0);
    }
    assert.equal(fs.existsSync(firstRoot), false);
    assert.equal(fs.existsSync(path.dirname(secondInbox)), false);
  });

  it("does not create a retired nested route for an ordinary direct foreground run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-root-no-nested-route-"));
    const state = createState();
    const controls = new CapturingForegroundControls();
    state.foregroundControls = controls;
    try {
      const throwingContext = makeMinimalCtx(root);
      throwingContext.modelRegistry.getAvailable = () => {
        throw new Error("ordinary root model lookup failed");
      };
      const result = await createExecutor(state, root).execute(
        "run",
        { agent: "worker", task: "go" },
        new AbortController().signal,
        undefined,
        throwingContext,
      );

      assert.equal(result.isError, true);
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";
      assert.match(text, /ordinary root model lookup failed/);
      assert.equal(controls.capturedRunIds.length, 1);
      const runId = controls.capturedRunIds[0];
      assert.ok(runId);
      assert.equal("nestedRoute" in controls.capturedControls[0]!, false);

      let routesForRun: string[] = [];
      try {
        routesForRun = fs
          .readdirSync(NESTED_EVENTS_DIR)
          .filter((entry) => entry.startsWith(`${runId}-`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      assert.deepEqual(routesForRun, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects retired route environments before spawn or artifact creation", async () => {
    const routeEnvVars = [SUBAGENT_CHILD_ENV, ...RETIRED_NESTED_ROUTE_ENV_VARS];
    const previous = new Map(routeEnvVars.map((name) => [name, process.env[name]]));
    try {
      for (const activeRouteEnv of routeEnvVars) {
        for (const name of routeEnvVars) delete process.env[name];
        process.env[activeRouteEnv] = activeRouteEnv === SUBAGENT_CHILD_ENV ? "1" : "legacy-route";
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-root-retired-route-"));
        const state = createState();
        const controls = new CapturingForegroundControls();
        state.foregroundControls = controls;
        try {
          const result = await createExecutor(state, root).execute(
            "run",
            { agent: "worker", task: "go" },
            new AbortController().signal,
            undefined,
            makeMinimalCtx(root),
          );

          assert.equal(result.isError, true, `${activeRouteEnv} should reject`);
          const content = result.content[0];
          const text = content?.type === "text" ? content.text : "";
          assert.match(text, /Nested subagent orchestration is retired/);
          assert.equal(controls.capturedRunIds.length, 0);
          assert.deepEqual(fs.readdirSync(root), []);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    } finally {
      for (const name of routeEnvVars) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
