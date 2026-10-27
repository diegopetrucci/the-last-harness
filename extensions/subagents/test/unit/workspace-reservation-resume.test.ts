import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/extension/subagent-executor.ts";
import { releaseWorkspaceReservationsForRun } from "../../src/runs/shared/workspace-reservation.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import { makeAgent, makeMinimalCtx, makeSubagentState } from "../support/helpers.ts";

const PARENT_FILE = "/sessions/parent-res.jsonl";
let root: string;
let launches: Array<Record<string, any>>;
const runIds: string[] = [];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tlh-res-resume-")));
  launches = [];
});
afterEach(() => {
  for (const launch of launches) releaseWorkspaceReservationsForRun(launch.runId);
  for (const id of runIds.splice(0))
    fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

function writeRun(label: string, agent: string): string {
  const runId = `wsres-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  runIds.push(runId);
  const asyncDir = path.join(ASYNC_DIR, runId);
  const sessionFile = path.join(asyncDir, "child.jsonl");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(sessionFile, "", "utf-8");
  writeJson(path.join(asyncDir, "status.json"), {
    runId,
    mode: "single",
    state: "complete",
    sessionId: PARENT_FILE,
    cwd: root,
    startedAt: 100,
    lastUpdate: 200,
    sessionFile,
    steps: [{ agent, status: "complete", startedAt: 100, sessionFile, cwd: root }],
  } as any);
  return runId;
}

function executor(launchError = false) {
  return createSubagentExecutor({
    pi: { events: { emit() {}, on: () => () => {} }, getSessionName: () => "parent" } as any,
    state: makeSubagentState({ baseCwd: root }),
    config: { maxSubagentDepth: 2, control: {} } as any,
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => path.join(root, "sessions"),
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [makeAgent("developer")] }),
    kill: () => true,
    executeAsyncSingle: ((runId: string, options: Record<string, any>) => {
      launches.push({ runId, ...options });
      return {
        content: [{ type: "text", text: launchError ? "boom" : "dispatched" }],
        details: { mode: "single", results: [], asyncId: runId },
        ...(launchError ? { isError: true } : {}),
      };
    }) as any,
  });
}

function resume(ex: ReturnType<typeof executor>, id: string) {
  const ctx = makeMinimalCtx(root);
  (ctx.sessionManager as any).getSessionId = () => "uuid";
  (ctx.sessionManager as any).getSessionFile = () => PARENT_FILE;
  return ex.execute(
    "resume",
    { action: "resume", id, message: "continue" } as any,
    new AbortController().signal,
    undefined,
    ctx,
  );
}

describe("workspace reservation on resume", () => {
  it("re-acquires on revival and conflicts a second writer revival naming the holder", async () => {
    const ex = executor();
    const first = await resume(ex, writeRun("a", "developer"));
    assert.equal(first.isError, undefined, JSON.stringify(first.content));
    const second = await resume(ex, writeRun("b", "developer"));
    assert.equal(second.isError, true);
    assert.match(JSON.stringify(second.content), new RegExp(launches[0]!.runId));
    assert.equal(launches.length, 1);
  });

  it("releases the reservation when the revival launch fails", async () => {
    const failed = await resume(executor(true), writeRun("c", "developer"));
    assert.equal(failed.isError, true);
    const retry = await resume(executor(), writeRun("d", "developer"));
    assert.equal(retry.isError, undefined, JSON.stringify(retry.content));
  });
});
