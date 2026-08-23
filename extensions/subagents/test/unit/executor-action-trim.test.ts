/**
 * Focused tests for ps-519q: fail-close executor to 8 actions.
 *
 * Verifies:
 *   (a) Removed actions (append-step, schedule, create) return Unknown-action error.
 *   (b) action='steer' async path is covered here and in async-interrupt-action.test.ts;
 *       nested steer routing is covered in nested-control.test.ts.
 *   (c) Extension startup no longer constructs the scheduled-run manager;
 *       structural source-text assertion confirms the wiring is absent.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import { consumeChildMessageRequests } from "../../src/runs/background/control-channel.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../src/shared/types.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const EXPECTED_VALID = "list, get, status, interrupt, resume, steer, doctor";

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

function makeExecutor(state: SubagentState) {
  return createSubagentExecutor({
    pi: {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      getSessionName() {
        return "parent";
      },
    } as any,
    state,
    config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
    tempArtifactsDir: os.tmpdir(),
    getSubagentSessionRoot: (parentSessionFile) =>
      parentSessionFile
        ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"))
        : os.tmpdir(),
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [] }),
    kill: () => true,
  });
}

function ctx() {
  return {
    cwd: os.tmpdir(),
    hasUI: false,
    sessionManager: {
      getSessionId() {
        return "session";
      },
      getSessionFile() {
        return null;
      },
    },
    modelRegistry: {
      getAvailable() {
        return [];
      },
    },
  } as any;
}

function text(result: Awaited<ReturnType<ReturnType<typeof makeExecutor>["execute"]>>): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Removed actions return Unknown-action error
// ─────────────────────────────────────────────────────────────────────────────

describe("executor: removed actions return Unknown-action error", () => {
  it("returns Unknown-action for append-step", async () => {
    const executor = makeExecutor(createState());
    const result = await executor.execute(
      "append-step",
      { action: "append-step" as any },
      new AbortController().signal,
      undefined,
      ctx(),
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown action: append-step/);
    assert.match(text(result), new RegExp(`Valid: ${EXPECTED_VALID}`));
  });

  it("returns Unknown-action for schedule", async () => {
    const executor = makeExecutor(createState());
    const result = await executor.execute(
      "schedule",
      { action: "schedule" as any },
      new AbortController().signal,
      undefined,
      ctx(),
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown action: schedule/);
    assert.match(text(result), new RegExp(`Valid: ${EXPECTED_VALID}`));
  });

  it("returns Unknown-action for create (mutating management action)", async () => {
    const executor = makeExecutor(createState());
    const result = await executor.execute(
      "create",
      { action: "create" as any },
      new AbortController().signal,
      undefined,
      ctx(),
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown action: create/);
    assert.match(text(result), new RegExp(`Valid: ${EXPECTED_VALID}`));
  });

  it("returns Unknown-action for schedule-list", async () => {
    const executor = makeExecutor(createState());
    const result = await executor.execute(
      "schedule-list",
      { action: "schedule-list" as any },
      new AbortController().signal,
      undefined,
      ctx(),
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown action: schedule-list/);
  });

  it("returns Unknown-action for schedule (handleScheduledRunAction dep removed, fail-closed by SUBAGENT_ACTIONS)", async () => {
    // The handleScheduledRunAction dep field was removed in phase-3 deletion (ps-lega).
    // Schedule actions are fail-closed independently by SUBAGENT_ACTIONS; this test
    // confirms that the Unknown-action guard fires without any handler dep present.
    const executor = makeExecutor(createState());
    const result = await executor.execute(
      "schedule",
      { action: "schedule" as any },
      new AbortController().signal,
      undefined,
      ctx(),
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown action: schedule/);
    assert.match(text(result), new RegExp(`Valid: ${EXPECTED_VALID}`));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) action='steer' still routes to async path
// ─────────────────────────────────────────────────────────────────────────────

describe("executor: direct saved-chain inputs fail closed", () => {
  it("rejects chain, chainName, chainDir, and clarify with field-specific omit guidance", async () => {
    const executor = makeExecutor(createState());
    // Deliberate TLH fork safety policy: fail closed on removed saved-chain inputs.
    for (const testCase of [
      {
        params: { chain: [{ agent: "worker", task: "Do work" }] },
        expected:
          "Saved chains are deliberately unsupported in The Last Harness; existing .chain.md/.chain.json files are left untouched. Omit 'chain'.",
      },
      {
        params: { action: "get", chainName: "legacy-chain" },
        expected:
          "Saved chains are deliberately unsupported in The Last Harness; existing .chain.md/.chain.json files are left untouched. Omit 'chainName'.",
      },
      {
        params: { chainDir: "/tmp/legacy-chain" },
        expected:
          "Saved chains are deliberately unsupported in The Last Harness; existing .chain.md/.chain.json files are left untouched. Omit 'chainDir'.",
      },
    ]) {
      const result = await executor.execute(
        "saved-chain-input",
        testCase.params as any,
        new AbortController().signal,
        undefined,
        ctx(),
      );
      assert.equal(result.isError, true);
      assert.equal(text(result), testCase.expected);
    }

    const clarify = await executor.execute(
      "clarify-input",
      { clarify: true, agent: "worker", task: "Do work" },
      new AbortController().signal,
      undefined,
      ctx(),
    );
    assert.equal(clarify.isError, true);
    assert.equal(
      text(clarify),
      "The Last Harness does not support the chain clarify UI; omit 'clarify'.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) action='steer' still routes to async path
// ─────────────────────────────────────────────────────────────────────────────

describe("executor: steer still routes correctly", () => {
  it("queues steering for a running async child by id", async () => {
    const state = createState();
    const runId = `steer-trim-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "running",
      pid: 12345,
      sessionId: "session",
      cwd: os.tmpdir(),
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [{ agent: "worker", status: "running", startedAt: 100 }],
    });
    try {
      const result = await makeExecutor(state).execute(
        "steer",
        { action: "steer", id: runId, message: "adjust focus" },
        new AbortController().signal,
        undefined,
        ctx(),
      );
      assert.equal(result.isError, undefined, `unexpected error: ${text(result)}`);
      assert.match(text(result), /Steering queued/);
      const requests = consumeChildMessageRequests(asyncDir);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.type, "steer");
      assert.equal(requests[0]?.message, "adjust focus");
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Extension startup no longer constructs the scheduled-run manager
// ─────────────────────────────────────────────────────────────────────────────

function parentToolEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUBAGENT_CHILD_ENV];
  return env;
}

describe("extension: no scheduled-run manager at startup", () => {
  it("src/extension/index.ts contains no scheduledRunManager references (structural)", () => {
    const source = fs.readFileSync(path.join(projectRoot, "src", "extension", "index.ts"), "utf-8");
    assert.doesNotMatch(
      source,
      /createScheduledRunManager/,
      "index.ts must not reference createScheduledRunManager",
    );
    assert.doesNotMatch(
      source,
      /scheduledRunManager/,
      "index.ts must not reference scheduledRunManager",
    );
  });

  it("action=schedule returns Unknown-action through the full extension stack", () => {
    const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				sessionManager: { getSessionId() { return "session-trim"; }, getSessionFile() { return null; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			const result = await registeredTool.execute("trim-check", { action: "schedule" }, new AbortController().signal, undefined, ctx);
			const txt = result.content?.[0]?.text ?? "";
			if (!txt.includes("Unknown action: schedule")) {
				throw new Error("expected Unknown-action for schedule, got: " + txt);
			}
		`;
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./test/support/register-loader.mjs",
        "--input-type=module",
        "--eval",
        script,
      ],
      { cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
    );
  });
});
