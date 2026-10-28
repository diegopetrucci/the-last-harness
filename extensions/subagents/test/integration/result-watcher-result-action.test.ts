import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { makeSubagentState } from "../support/helpers.ts";
import { createSubagentExecutor } from "../../src/extension/subagent-executor.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";

const OWNER = "session-owner";
const created: string[] = [];

function ctx(sessionId: string) {
  return {
    cwd: os.tmpdir(),
    hasUI: false,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => null },
    modelRegistry: { getAvailable: () => [] },
  } as any;
}

async function fetchResult(runId: string, sessionId: string) {
  const executor = createSubagentExecutor({
    pi: { events: { emit() {}, on: () => () => {} }, getSessionName: () => "p" } as any,
    state: makeSubagentState({ baseCwd: "" }),
    config: { maxSubagentDepth: 2, control: {} } as any,
    tempArtifactsDir: os.tmpdir(),
    getSubagentSessionRoot: () => os.tmpdir(),
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [] }),
  });
  const result = await executor.execute(
    "result",
    { action: "result", id: runId } as any,
    new AbortController().signal,
    undefined,
    ctx(sessionId),
  );
  return {
    isError: result.isError === true,
    text: result.content[0]?.type === "text" ? result.content[0].text : "",
  };
}

afterEach(() => {
  for (const id of created.splice(0)) {
    fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
    fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
    fs.rmSync(path.join(RESULTS_DIR, `${id}.json.claim`), { force: true });
  }
});

describe("watcher -> result with an unreadable run status", () => {
  for (const variant of ["missing", "corrupt"] as const) {
    it(`keeps the results file and lets the owner fetch bounded output (${variant} status.json)`, async () => {
      const runId = `wr-${variant}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      created.push(runId);
      const asyncDir = path.join(ASYNC_DIR, runId);
      fs.mkdirSync(asyncDir, { recursive: true });
      if (variant === "corrupt") fs.writeFileSync(path.join(asyncDir, "status.json"), "{not json");
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const resultPath = path.join(RESULTS_DIR, `${runId}.json`);
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: runId,
          agent: "a",
          mode: "single",
          success: true,
          state: "complete",
          summary: "done",
          results: [{ agent: "a", success: true, output: "x".repeat(30_000) }],
          timestamp: 1,
          asyncDir,
          sessionId: OWNER,
        }),
      );

      const emitted: unknown[] = [];
      const pi = {
        events: { on: () => () => {}, emit: (_e: string, data: unknown) => emitted.push(data) },
      };
      const state = makeSubagentState({ baseCwd: "/repo", currentSessionId: OWNER });
      const fakeWatcher = Object.assign(new EventEmitter(), { close() {}, unref() {} });
      const watcher = createResultWatcher(pi, state, RESULTS_DIR, {
        fs: { ...fs, watch: (() => fakeWatcher) as never },
        timers: {
          setTimeout: (() => ({ unref() {} })) as never,
          clearTimeout: (() => {}) as typeof clearTimeout,
          setInterval: (() => ({ unref() {} })) as never,
          clearInterval: (() => {}) as never,
        },
      });
      const originalError = console.error;
      console.error = () => {};
      try {
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 150));
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 150));
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }
      const mine = emitted.filter((e) => (e as { runId?: string }).runId === runId);
      assert.equal(mine.length, 1, "delivered exactly once");
      assert.equal(fs.existsSync(resultPath), true, "results file retained");
      assert.equal(fs.existsSync(path.join(asyncDir, "terminal-record.json")), false);

      const owned = await fetchResult(runId, OWNER);
      assert.equal(owned.isError, false, owned.text);
      assert.match(owned.text, /xxxxxxxx/);
      assert.ok(owned.text.length < 9_000, "per-child output bounded");
      assert.match(owned.text, /truncated/i);

      const foreign = await fetchResult(runId, "session-foreign");
      assert.equal(foreign.isError, true);
      assert.doesNotMatch(foreign.text, /xxxxxxxx/);
    });
  }
});
