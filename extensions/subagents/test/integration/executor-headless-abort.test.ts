/** C5/C6: headless fail-closed gate, pre-launch abort rejection, and the Esc launch hint. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createEventBus,
  createTempDir,
  makeAgent,
  makeExtensionAPI,
  makeMinimalCtx,
  makeSubagentState,
  removeTempDir,
} from "../support/helpers.ts";
import { createSubagentExecutor } from "../../src/extension/subagent-executor.ts";
import {
  acquireWorkspaceReservations,
  releaseWorkspaceReservationsForRun,
} from "../../src/runs/shared/workspace-reservation.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

type Mode = "tui" | "rpc" | "json" | "print";
const GATE = /Detached subagent runs are unavailable in print\/json mode/;

describe("headless gate and pre-launch abort", () => {
  let tempDir: string;
  let sessionsRoot: string;
  let launches: string[];

  beforeEach(() => {
    tempDir = createTempDir("pi-subagent-headless-");
    sessionsRoot = path.join(tempDir, "sessions");
    launches = [];
  });
  afterEach(() => {
    for (const id of launches) releaseWorkspaceReservationsForRun(id);
    removeTempDir(tempDir);
  });

  function makeExecutor() {
    const stub = (id: string) => {
      launches.push(id);
      return {
        content: [
          {
            type: "text" as const,
            text: "Async: developer [stub]\nEsc does not stop detached children.",
          },
        ],
        details: { mode: "single" as const, results: [], asyncId: id },
      };
    };
    return createSubagentExecutor({
      pi: makeExtensionAPI({ events: createEventBus() }),
      state: makeSubagentState({ baseCwd: tempDir }),
      config: {},
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => sessionsRoot,
      expandTilde: (value: string) => value,
      discoverAgents: () => ({
        agents: [makeAgent("developer"), makeAgent("oracle")],
        projectAgentsDir: null,
      }),
      executeAsyncSingle: stub,
      executeAsyncParallel: stub,
    } as never);
  }

  const ctxFor = (mode: Mode) => ({ ...makeMinimalCtx(tempDir), mode });
  const runsOnDisk = () => (fs.existsSync(ASYNC_DIR) ? fs.readdirSync(ASYNC_DIR).sort() : []);
  const writerFree = () => {
    const probe = acquireWorkspaceReservations("probe-run", "probe-session", [
      { agent: "developer", childIndex: 0, cwd: tempDir },
    ]);
    if (probe.ok) probe.release();
    return probe.ok;
  };

  for (const mode of ["print", "json"] as const) {
    it(`rejects single and parallel async launches in ${mode} mode before any side effect`, async () => {
      const executor = makeExecutor();
      const diskBefore = runsOnDisk();
      for (const params of [
        { agent: "developer", task: "work", async: true },
        { tasks: [{ agent: "developer", task: "work" }], async: true },
      ]) {
        const result = await executor.execute(
          "id",
          params as never,
          new AbortController().signal,
          undefined,
          ctxFor(mode) as never,
        );
        assert.equal(result.isError, true);
        assert.match(textOf(result) ?? "", GATE);
        assert.match(textOf(result) ?? "", /interactive \(tui\) or RPC/);
      }
      assert.deepEqual(launches, []);
      assert.equal(fs.existsSync(sessionsRoot), false, "no session dir created");
      assert.deepEqual(runsOnDisk(), diskBefore, "no status dir created");
      assert.equal(writerFree(), true, "no reservation leaked");
    });

    it(`blocks resume but keeps list/get/status/result/interrupt/steer/doctor in ${mode} mode`, async () => {
      const executor = makeExecutor();
      const call = (params: Record<string, unknown>) =>
        executor.execute(
          "id",
          params as never,
          new AbortController().signal,
          undefined,
          ctxFor(mode) as never,
        );
      const resume = await call({ action: "resume", id: "nope", message: "go" });
      assert.equal(resume.isError, true);
      assert.match(textOf(resume) ?? "", GATE);
      for (const params of [
        { action: "list" },
        { action: "get", agent: "oracle" },
        { action: "status" },
        { action: "result", id: "nope" },
        { action: "interrupt", id: "nope" },
        { action: "steer", id: "nope", message: "hi" },
        { action: "doctor" },
      ]) {
        const result = await call(params);
        assert.doesNotMatch(textOf(result) ?? "", GATE, JSON.stringify(params));
      }
      const status = await call({ action: "status" });
      assert.notEqual(status.isError, true);
    });
  }

  it("rejects an already-aborted resume before any reservation, claim change, or spawn", async () => {
    const executor = makeExecutor();
    const controller = new AbortController();
    controller.abort();
    const diskBefore = runsOnDisk();
    const result = await executor.execute(
      "id",
      { action: "resume", id: "any-run", message: "continue" } as never,
      controller.signal,
      undefined,
      ctxFor("tui") as never,
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /already aborted before any run was started/);
    assert.deepEqual(launches, []);
    assert.deepEqual(runsOnDisk(), diskBefore, "no status write");
    assert.equal(writerFree(), true, "no reservation leaked");
  });

  for (const mode of ["tui", "rpc"] as const) {
    it(`launches normally in ${mode} mode and reports how to stop detached children`, async () => {
      const executor = makeExecutor();
      const single = await executor.execute(
        "id",
        { agent: "developer", task: "work", async: true } as never,
        new AbortController().signal,
        undefined,
        ctxFor(mode) as never,
      );
      assert.equal(single.isError, undefined, textOf(single));
      assert.equal(launches.length, 1);
      // Resume is not gated: it reaches target resolution and fails on the unknown id instead.
      const resume = await executor.execute(
        "id",
        { action: "resume", id: "nope", message: "go" } as never,
        new AbortController().signal,
        undefined,
        ctxFor(mode) as never,
      );
      assert.doesNotMatch(textOf(resume) ?? "", GATE);
    });
  }

  it("rejects an already-aborted signal before reservation, session dir, status dir, or spawn", async () => {
    const executor = makeExecutor();
    const diskBefore = runsOnDisk();
    const controller = new AbortController();
    controller.abort();
    for (const params of [
      { agent: "developer", task: "work", async: true },
      { tasks: [{ agent: "developer", task: "work" }], async: true },
    ]) {
      const result = await executor.execute(
        "id",
        params as never,
        controller.signal,
        undefined,
        ctxFor("tui") as never,
      );
      assert.equal(result.isError, true);
      assert.match(textOf(result) ?? "", /already aborted before any run was started/);
    }
    assert.deepEqual(launches, []);
    assert.equal(fs.existsSync(sessionsRoot), false);
    assert.deepEqual(runsOnDisk(), diskBefore);
    assert.equal(writerFree(), true);
  });

  it("still allows management actions with an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await makeExecutor().execute(
      "id",
      { action: "status" } as never,
      controller.signal,
      undefined,
      ctxFor("tui") as never,
    );
    assert.notEqual(result.isError, true);
  });
});
