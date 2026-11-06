import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { NESTED_EVENTS_DIR } from "../../src/runs/shared/nested-events.ts";
import {
  RETIRED_NESTED_ROUTE_ENV_VARS,
  SUBAGENT_CHILD_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { type ExtensionConfig, type SubagentState } from "../../src/shared/types.ts";
import { makeAgent, makeExtensionAPI, makeMinimalCtx } from "../support/helpers.ts";

function createState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
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
  it("does not create a retired nested route for an ordinary direct background run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-root-no-nested-route-"));
    const state = createState();
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

      // Core regression: no retired nested route files created.
      let routeFiles: string[] = [];
      try {
        routeFiles = fs.readdirSync(NESTED_EVENTS_DIR);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      assert.deepEqual(routeFiles, []);
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
