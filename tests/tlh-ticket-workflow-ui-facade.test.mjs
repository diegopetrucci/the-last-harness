import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerLazyTlhTicketWorkflowUi } = await jiti.import(
  "../extensions/the-last-harness/ticket-workflow-ui-facade.ts",
);

function resetTicketWorkflowFacadeTestState() {
  delete process.env.TICKETS_DIR;
}

test.beforeEach(resetTicketWorkflowFacadeTestState);
test.afterEach(resetTicketWorkflowFacadeTestState);

function createPiHarness() {
  const commands = new Map();
  const handlers = new Map();
  return {
    commands,
    handlers,
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
}

function createCtx(cwd, hasUI = true) {
  return {
    hasUI,
    cwd,
    ui: {
      notify() {},
    },
  };
}

async function fireAll(pi, event, payload, ctx) {
  for (const handler of pi.handlers.get(event) ?? []) {
    await handler(payload, ctx);
  }
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("lazy ticket workflow facade loads the runtime at UI session start and reuses it", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-facade-", {
    cwd: true,
    test: t,
  });

  const loadCalls = [];
  const runtimeCalls = [];
  const runtime = {
    applyCurrentSettings(ctx) {
      runtimeCalls.push(["applyCurrentSettings", ctx.cwd, process.env.TICKETS_DIR]);
    },
    handleSessionShutdown() {
      runtimeCalls.push(["handleSessionShutdown"]);
    },
    handleUserBash(event, ctx) {
      runtimeCalls.push(["handleUserBash", event.command, ctx.cwd]);
    },
    handleToolResult(event, ctx) {
      runtimeCalls.push(["handleToolResult", event.input.command, ctx.cwd]);
    },
  };

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined },
    async () => {
      const pi = createPiHarness();
      registerLazyTlhTicketWorkflowUi(pi, {
        loadModule: async () => {
          loadCalls.push("load");
          return {
            createTlhTicketWorkflowUiRuntime() {
              return runtime;
            },
          };
        },
      });
      const ctx = createCtx(fixture.cwd);

      await fireAll(pi, "session_start", { reason: "restore" }, ctx);
      await flushAsyncWork();
      assert.deepEqual(loadCalls, ["load"]);
      assert.deepEqual(runtimeCalls, [
        ["applyCurrentSettings", fixture.cwd, join(fixture.cwd, ".tickets")],
      ]);

      await fireAll(pi, "session_start", { reason: "restore" }, ctx);
      await flushAsyncWork();
      assert.deepEqual(loadCalls, ["load"]);
      assert.deepEqual(runtimeCalls.slice(-1), [
        ["applyCurrentSettings", fixture.cwd, join(fixture.cwd, ".tickets")],
      ]);

      await fireAll(pi, "user_bash", { command: "tk ready" }, ctx);
      await fireAll(pi, "tool_result", { toolName: "bash", input: { command: "tk ready" } }, ctx);
      await fireAll(pi, "session_shutdown", {}, ctx);
      assert.deepEqual(runtimeCalls.slice(2), [
        ["handleUserBash", "tk ready", fixture.cwd],
        ["handleToolResult", "tk ready", fixture.cwd],
        ["handleSessionShutdown"],
      ]);
    },
  );
});

test("lazy ticket workflow facade skips runtime import for non-UI sessions", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-facade-", {
    cwd: true,
    test: t,
  });
  const loadCalls = [];

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined },
    async () => {
      const pi = createPiHarness();
      registerLazyTlhTicketWorkflowUi(pi, {
        loadModule: async () => {
          loadCalls.push("load");
          return {
            createTlhTicketWorkflowUiRuntime() {
              throw new Error("should not load");
            },
          };
        },
      });

      await fireAll(pi, "session_start", { reason: "restore" }, createCtx(fixture.cwd, false));
      await flushAsyncWork();
      assert.deepEqual(loadCalls, []);
    },
  );
});

test("lazy ticket workflow facade retries runtime import after an initial session-start failure", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-facade-", {
    cwd: true,
    test: t,
  });
  let attempts = 0;
  const runtimeCalls = [];

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined },
    async () => {
      const pi = createPiHarness();
      registerLazyTlhTicketWorkflowUi(pi, {
        loadModule: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("boom");
          }
          return {
            createTlhTicketWorkflowUiRuntime() {
              return {
                applyCurrentSettings(ctx) {
                  runtimeCalls.push(["applyCurrentSettings", ctx.cwd]);
                },
                handleSessionShutdown() {},
                handleUserBash() {},
                handleToolResult() {},
              };
            },
          };
        },
      });
      const ctx = createCtx(fixture.cwd);

      await fireAll(pi, "session_start", { reason: "restore" }, ctx);
      await flushAsyncWork();
      assert.equal(attempts, 1);
      assert.deepEqual(runtimeCalls, []);

      await fireAll(pi, "session_start", { reason: "restore" }, ctx);
      await flushAsyncWork();
      assert.equal(attempts, 2);
      assert.deepEqual(runtimeCalls, [["applyCurrentSettings", fixture.cwd]]);
    },
  );
});

test("lazy ticket workflow facade rescopes each session before reapplying the loaded runtime", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-ticket-workflow-facade-", { test: t });
  const repoA = join(fixture.dir, "repo-a");
  const repoB = join(fixture.dir, "repo-b");
  mkdirSync(join(repoA, ".tickets"), { recursive: true });
  mkdirSync(join(repoB, ".tickets"), { recursive: true });
  const runtimeCalls = [];

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined },
    async () => {
      const pi = createPiHarness();
      registerLazyTlhTicketWorkflowUi(pi, {
        loadModule: async () => ({
          createTlhTicketWorkflowUiRuntime() {
            return {
              applyCurrentSettings(ctx) {
                runtimeCalls.push([ctx.cwd, process.env.TICKETS_DIR]);
              },
              handleSessionShutdown() {},
              handleUserBash() {},
              handleToolResult() {},
            };
          },
        }),
      });

      await fireAll(pi, "session_start", { reason: "restore" }, createCtx(repoA));
      await flushAsyncWork();
      await fireAll(pi, "session_start", { reason: "restore" }, createCtx(repoB));
      await flushAsyncWork();
    },
  );

  assert.deepEqual(runtimeCalls, [
    [repoA, join(repoA, ".tickets")],
    [repoB, join(repoB, ".tickets")],
  ]);
});
