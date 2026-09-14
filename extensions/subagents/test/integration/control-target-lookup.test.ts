import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, before, describe, it } from "node:test";
import {
  makeExtensionAPI,
  makeMinimalCtx,
  makeSubagentState,
  type TestEventHandler,
} from "../support/helpers.ts";
import {
  clearTlhSubagentControlTargetAccessProvider,
  getTlhSubagentControlTargetAccess,
  setTlhSubagentControlTargetAccessProvider,
} from "../../../the-last-harness/subagent-control-access.mjs";
import { registerTlhPrimaryAgentRuntime } from "../../../the-last-harness/primary-agent-runtime.ts";
import { registerSubagentControlTargetLookup } from "../../src/runs/background/control-target-lookup.ts";
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";

type Fixture = {
  root: string;
  asyncDirRoot: string;
  resultsDir: string;
  state: SubagentState;
};

const fixtures: string[] = [];
const nestedRouteRoots: string[] = [];
let toolCall: TestEventHandler;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-control-target-lookup-"));
  fixtures.push(root);
  const asyncDirRoot = path.join(root, "async-runs");
  const resultsDir = path.join(root, "results");
  fs.mkdirSync(asyncDirRoot);
  fs.mkdirSync(resultsDir);
  return { root, asyncDirRoot, resultsDir, state: makeSubagentState() };
}

function writeStatus(
  fixture: Fixture,
  runId: string,
  steps: Array<{ agent: string; status: "pending" | "running" | "complete" }>,
  state: "running" | "complete" = "running",
): string {
  const asyncDir = path.join(fixture.asyncDirRoot, runId);
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(
    path.join(asyncDir, "status.json"),
    JSON.stringify({
      runId,
      mode: steps.length === 1 ? "single" : "parallel",
      state,
      startedAt: 1,
      steps,
    }),
    "utf8",
  );
  return asyncDir;
}

function registerFixture(fixture: Fixture): () => void {
  return registerSubagentControlTargetLookup(fixture.state, {
    asyncDirRoot: fixture.asyncDirRoot,
    resultsDir: fixture.resultsDir,
  });
}

function controlResult(fixture: Fixture, input: Record<string, unknown>): Promise<object | void> {
  const unregister = registerFixture(fixture);
  return Promise.resolve()
    .then(() => toolCall({ toolName: "subagent", input }))
    .finally(unregister);
}

before(() => {
  const handlers = new Map<string, TestEventHandler>();
  const pi = makeExtensionAPI({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: new Map(),
    subagentMetadata: [],
  });
  const handler = handlers.get("tool_call");
  assert.ok(handler, "primary runtime should register a tool_call handler");
  toolCall = handler;
  // Keep the test's context construction explicit: makeExtensionAPI adapts the
  // production two-argument hook to a payload-only handler with makeMinimalCtx.
  assert.ok(makeMinimalCtx(process.cwd()));
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  for (const routeRoot of nestedRouteRoots.splice(0)) {
    fs.rmSync(routeRoot, { recursive: true, force: true });
  }
});

describe("subagent control-target bridge", () => {
  it("resolves exact, prefix, and directory/index targets from persisted status", () => {
    const fixture = makeFixture();
    const exactDir = writeStatus(fixture, "run-staff-exact", [
      { agent: "staff-developer", status: "running" },
    ]);
    writeStatus(fixture, "run-staff-prefix", [{ agent: "staff-developer", status: "running" }]);

    const unregister = registerFixture(fixture);
    try {
      assert.deepEqual(
        getTlhSubagentControlTargetAccess({ action: "resume", id: "run-staff-exact" }),
        { status: "found", runId: "run-staff-exact", agents: ["staff-developer"] },
      );
      assert.deepEqual(
        getTlhSubagentControlTargetAccess({ action: "resume", id: "run-staff-pre" }),
        { status: "found", runId: "run-staff-prefix", agents: ["staff-developer"] },
      );
      assert.deepEqual(
        getTlhSubagentControlTargetAccess({
          action: "steer",
          dir: exactDir,
          index: 0,
        }),
        { status: "found", runId: "run-staff-exact", agents: ["staff-developer"] },
      );
    } finally {
      unregister();
    }
  });

  it("uses live async state and selects individual parallel steps", () => {
    const fixture = makeFixture();
    const asyncDir = path.join(fixture.asyncDirRoot, "live-run");
    const job: AsyncJobState = {
      asyncId: "live-run",
      asyncDir,
      status: "running",
      mode: "parallel",
      steps: [
        { agent: "developer", status: "running" },
        { agent: "staff-developer", status: "running" },
      ],
    };
    fixture.state.asyncJobs.set(job.asyncId, job);

    const unregister = registerFixture(fixture);
    try {
      assert.deepEqual(
        getTlhSubagentControlTargetAccess({ action: "steer", id: "live-run", index: 0 }),
        { status: "found", runId: "live-run", agents: ["developer"] },
      );
      assert.deepEqual(
        getTlhSubagentControlTargetAccess({ action: "steer", id: "live-run", index: 1 }),
        { status: "found", runId: "live-run", agents: ["staff-developer"] },
      );
    } finally {
      unregister();
    }
  });

  it("returns ambiguous, opaque, and missing without guessing at a role", () => {
    const fixture = makeFixture();
    writeStatus(fixture, "run-ambiguous-a", [{ agent: "staff-developer", status: "running" }]);
    writeStatus(fixture, "run-ambiguous-b", [{ agent: "staff-developer", status: "running" }]);
    const opaqueDir = path.join(fixture.asyncDirRoot, "run-opaque");
    fs.mkdirSync(opaqueDir);
    fs.writeFileSync(
      path.join(opaqueDir, "status.json"),
      JSON.stringify({ runId: "run-opaque", mode: "single", state: "running", startedAt: 1 }),
      "utf8",
    );

    const unregister = registerFixture(fixture);
    try {
      assert.deepEqual(
        getTlhSubagentControlTargetAccess({ action: "resume", id: "run-ambiguous" }),
        { status: "ambiguous" },
      );
      assert.deepEqual(getTlhSubagentControlTargetAccess({ action: "resume", id: "run-opaque" }), {
        status: "opaque",
      });
      assert.deepEqual(
        getTlhSubagentControlTargetAccess({ action: "resume", id: "does-not-exist" }),
        { status: "missing" },
      );
      assert.deepEqual(getTlhSubagentControlTargetAccess({ action: "resume" }), {
        status: "missing",
      });
      assert.deepEqual(getTlhSubagentControlTargetAccess({ action: "status", id: "run-opaque" }), {
        status: "opaque",
      });
    } finally {
      unregister();
    }
  });

  it("reads a staff role from a result-only fixture", () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.resultsDir, "result-only.json"),
      JSON.stringify({
        id: "result-only",
        agent: "staff-developer",
        results: [],
      }),
      "utf8",
    );

    const unregister = registerFixture(fixture);
    try {
      assert.deepEqual(getTlhSubagentControlTargetAccess({ action: "resume", id: "result-only" }), {
        status: "found",
        runId: "result-only",
        agents: ["staff-developer"],
      });
    } finally {
      unregister();
    }
  });

  it("finds foreground and nested child roles without exposing capabilities", async () => {
    const fixture = makeFixture();
    fixture.state.foregroundRuns?.set("foreground-staff", {
      runId: "foreground-staff",
      mode: "single",
      cwd: process.cwd(),
      updatedAt: 1,
      children: [
        {
          index: 0,
          agent: "staff-developer",
          status: "paused",
        },
      ],
    });

    const route = createNestedRoute("nested-root");
    const routeRoot = path.dirname(route.eventSink);
    nestedRouteRoots.push(routeRoot);
    fs.writeFileSync(
      path.join(routeRoot, "registry.json"),
      JSON.stringify({
        rootRunId: route.rootRunId,
        updatedAt: 1,
        processedEvents: [],
        children: [
          {
            id: "nested-staff",
            parentRunId: "nested-root",
            parentStepIndex: 0,
            depth: 1,
            path: [{ runId: "nested-root" }, { runId: "nested-staff" }],
            state: "running",
            agent: "staff-developer",
          },
        ],
      }),
      "utf8",
    );
    fixture.state.foregroundControls.set("foreground-root", {
      runId: "foreground-root",
      mode: "single",
      startedAt: 1,
      updatedAt: 1,
      nestedRoute: route,
    });

    const unregister = registerFixture(fixture);
    try {
      assert.deepEqual(
        getTlhSubagentControlTargetAccess({ action: "resume", id: "foreground-staff" }),
        { status: "found", runId: "foreground-staff", agents: ["staff-developer"] },
      );
      assert.deepEqual(getTlhSubagentControlTargetAccess({ action: "steer", id: "nested-staff" }), {
        status: "found",
        runId: "nested-staff",
        agents: ["staff-developer"],
      });

      const blocked = await controlResult(fixture, {
        action: "resume",
        id: "foreground-staff",
      });
      assert.deepEqual(blocked, {
        block: true,
        reason:
          "TLH resume blocked: staff-developer routing is disabled, so controls may not target staff-developer run 'foreground-staff'. Enable the experimental feature 'staff-developer-routing' before retrying.",
      });
    } finally {
      unregister();
    }
  });

  it("blocks only disabled staff resume/steer controls and leaves status/interrupt unrestricted", async () => {
    const fixture = makeFixture();
    writeStatus(fixture, "staff-control", [{ agent: "staff-developer", status: "running" }]);
    writeStatus(fixture, "developer-control", [{ agent: "developer", status: "running" }]);
    writeStatus(fixture, "parallel-control", [
      { agent: "developer", status: "running" },
      { agent: "staff-developer", status: "running" },
    ]);
    const opaqueDir = path.join(fixture.asyncDirRoot, "opaque-control");
    fs.mkdirSync(opaqueDir);
    fs.writeFileSync(
      path.join(opaqueDir, "status.json"),
      JSON.stringify({ runId: "opaque-control", mode: "single", state: "running", startedAt: 1 }),
      "utf8",
    );

    const unregister = registerFixture(fixture);
    try {
      assert.deepEqual(
        getTlhSubagentControlTargetAccess({ action: "resume", id: "parallel-control" }),
        {
          status: "found",
          runId: "parallel-control",
          agents: ["developer", "staff-developer"],
        },
      );
      assert.deepEqual(await controlResult(fixture, { action: "resume", id: "staff-control" }), {
        block: true,
        reason:
          "TLH resume blocked: staff-developer routing is disabled, so controls may not target staff-developer run 'staff-control'. Enable the experimental feature 'staff-developer-routing' before retrying.",
      });
      assert.deepEqual(await controlResult(fixture, { action: "steer", id: "staff-control" }), {
        block: true,
        reason:
          "TLH steer blocked: staff-developer routing is disabled, so controls may not target staff-developer run 'staff-control'. Enable the experimental feature 'staff-developer-routing' before retrying.",
      });
      assert.equal(
        await controlResult(fixture, { action: "resume", id: "developer-control" }),
        undefined,
      );
      assert.equal(
        await controlResult(fixture, { action: "status", id: "staff-control" }),
        undefined,
      );
      assert.equal(
        await controlResult(fixture, { action: "interrupt", id: "staff-control" }),
        undefined,
      );
      assert.deepEqual(await controlResult(fixture, { action: "resume", id: "parallel-control" }), {
        block: true,
        reason:
          "TLH resume blocked: staff-developer routing is disabled, so controls may not target staff-developer run 'parallel-control'. Enable the experimental feature 'staff-developer-routing' before retrying.",
      });
      assert.equal(
        await controlResult(fixture, { action: "resume", id: "opaque-control" }),
        undefined,
      );
      assert.equal(
        await controlResult(fixture, { action: "resume", id: "missing-control" }),
        undefined,
      );
    } finally {
      unregister();
    }
  });

  it("keeps control requests opaque when the bridge provider fails", async () => {
    const failingProvider = () => {
      throw new Error("fixture provider failure");
    };
    setTlhSubagentControlTargetAccessProvider(failingProvider);
    try {
      assert.equal(
        getTlhSubagentControlTargetAccess({ action: "resume", id: "staff-control" }),
        undefined,
      );

      const result = await toolCall({
        toolName: "subagent",
        input: { action: "resume", id: "staff-control" },
      });
      assert.equal(result, undefined);
    } finally {
      clearTlhSubagentControlTargetAccessProvider(failingProvider);
    }
  });
});
