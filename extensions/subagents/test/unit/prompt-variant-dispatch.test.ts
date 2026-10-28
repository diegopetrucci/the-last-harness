import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/extension/subagent-executor.ts";
import type { ProjectAgentAccess } from "../../src/runs/shared/executor-types.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import {
  makeAgent,
  makeExtensionAPI,
  makeMinimalCtx,
  makeSubagentState,
} from "../support/helpers.ts";

const PROMPT_SOURCE = [
  "Common test-runner guidance.",
  "<!-- tlh:prompt-variant:normal:start -->",
  "Normal ticket protocol.",
  "<!-- tlh:prompt-variant:normal:end -->",
  "<!-- tlh:prompt-variant:ticket-free:start -->",
  "Ticket-free inline protocol.",
  "<!-- tlh:prompt-variant:ticket-free:end -->",
].join("\n");

type CapturedDispatch = {
  single?: Record<string, unknown>;
  parallel?: Record<string, unknown>;
};

type MalformedAccessFixture =
  | {
      architect: false;
      canManage: "broken";
      canInitiate: "broken";
      noDeveloper: true;
    }
  | {
      architect: false;
      canManage: true;
      canInitiate: true;
      noDeveloper: true;
      trustStore: { readonly getEntry?: never };
    };

type AccessFixture = ProjectAgentAccess | MalformedAccessFixture;

function makeHarness(root: string, accessProvider?: () => AccessFixture | undefined) {
  const profile = path.join(root, "profile");
  const canonicalPath = path.join(profile, "tlh", "agents", "subagents", "test-runner.md");
  const testRunner = makeAgent("test-runner", {
    filePath: canonicalPath,
    systemPrompt: PROMPT_SOURCE,
    source: "package",
  });
  const codeReviewer = makeAgent("code-reviewer", {
    filePath: path.join(profile, "tlh", "agents", "subagents", "code-reviewer.md"),
  });
  const captured: CapturedDispatch = {};
  const executor = createSubagentExecutor({
    pi: makeExtensionAPI(),
    state: makeSubagentState({ baseCwd: root, currentSessionId: "parent-session" }),
    config: { maxSubagentDepth: 2, control: {} },
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => path.join(root, "sessions"),
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [testRunner, codeReviewer] }),
    getProjectAgentAccess: accessProvider as any,
    executeAsyncSingle: ((runId: string, params: Record<string, unknown>) => {
      captured.single = params;
      return {
        content: [{ type: "text", text: "dispatched" }],
        details: { mode: "single", results: [], asyncId: runId },
      };
    }) as any,
    executeAsyncParallel: ((runId: string, params: Record<string, unknown>) => {
      captured.parallel = params;
      return {
        content: [{ type: "text", text: "dispatched" }],
        details: { mode: "parallel", results: [], asyncId: runId },
      };
    }) as any,
  });
  return { executor, captured, profile };
}

async function dispatch(
  executor: ReturnType<typeof createSubagentExecutor>,
  root: string,
  params: Record<string, unknown>,
) {
  return executor.execute(
    "prompt-variant-dispatch",
    params as any,
    new AbortController().signal,
    undefined,
    makeMinimalCtx(root),
  );
}

describe("captured prompt-variant dispatch selection", () => {
  it("selects ticket-free only for canonical test-runner children across launch modes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-prompt-variant-dispatch-"));
    const previousProfile = process.env.PI_CODING_AGENT_DIR;
    const retiredEnvNames = [
      "PI_SUBAGENT_CHILD",
      "PI_SUBAGENT_PARENT_EVENT_SINK",
      "PI_SUBAGENT_PARENT_CONTROL_INBOX",
      "PI_SUBAGENT_PARENT_ROOT_RUN_ID",
      "PI_SUBAGENT_PARENT_RUN_ID",
      "PI_SUBAGENT_PARENT_CHILD_INDEX",
      "PI_SUBAGENT_PARENT_DEPTH",
      "PI_SUBAGENT_PARENT_PATH",
      "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN",
    ];
    const previousRetiredEnv = new Map(
      retiredEnvNames.map((name) => [name, process.env[name]] as const),
    );
    for (const name of retiredEnvNames) delete process.env[name];
    process.env.PI_CODING_AGENT_DIR = path.join(root, "profile");
    try {
      const access: ProjectAgentAccess = {
        architect: true,
        canManage: true,
        canInitiate: true,
        noDeveloper: true,
      };
      let currentAccess = access;
      const { executor, captured } = makeHarness(root, () => currentAccess);

      await dispatch(executor, root, { agent: "test-runner", task: "check", async: false });
      assert.equal(captured.single?.promptVariant, "ticket-free");
      assert.equal(captured.single?.awaited, true);

      await dispatch(executor, root, { agent: "test-runner", task: "check", async: true });
      assert.equal(captured.single?.promptVariant, "ticket-free");
      assert.equal(captured.single?.awaited, false);

      await dispatch(executor, root, {
        tasks: [
          { agent: "test-runner", task: "check one" },
          { agent: "code-reviewer", task: "review" },
        ],
        async: true,
      });
      const parallelTasks = captured.parallel?.tasks as Array<Record<string, unknown>>;
      assert.deepEqual(
        parallelTasks.map((task) => task.promptVariant),
        ["ticket-free", undefined],
      );
      assert.equal(captured.parallel?.awaited, false);

      const runId = `tlh-prompt-variant-revival-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const asyncDir = path.join(ASYNC_DIR, runId);
      const sessionFile = path.join(root, "revived-session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf8");
      writeJson(path.join(asyncDir, "status.json"), {
        runId,
        mode: "single",
        state: "complete",
        sessionId: "session-123",
        cwd: root,
        startedAt: 100,
        lastUpdate: 100,
        sessionFile,
        steps: [
          {
            agent: "test-runner",
            status: "complete",
            sessionFile,
            promptVariant: "ticket-free",
          },
        ],
      });
      currentAccess = { ...access, architect: false };
      try {
        await dispatch(executor, root, {
          action: "resume",
          id: runId,
          message: "continue the captured validation",
        });
        assert.equal(captured.single?.promptVariant, "ticket-free");
      } finally {
        fs.rmSync(asyncDir, { recursive: true, force: true });
        fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
      }
    } finally {
      if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousProfile;
      for (const [name, value] of previousRetiredEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps disabled and non-Architect access on the normal canonical protocol", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-prompt-variant-role-"));
    const previousProfile = process.env.PI_CODING_AGENT_DIR;
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "profile");
    try {
      const policies: ProjectAgentAccess[] = [
        {
          architect: true,
          canManage: true,
          canInitiate: true,
          noDeveloper: false,
        },
        {
          architect: false,
          canManage: true,
          canInitiate: true,
          noDeveloper: true,
        },
      ];
      for (const access of policies) {
        const { executor, captured } = makeHarness(root, () => access);
        await dispatch(executor, root, { agent: "test-runner", task: "check" });
        assert.equal(captured.single?.promptVariant, "normal");

        await dispatch(executor, root, {
          tasks: [
            { agent: "test-runner", task: "check one" },
            { agent: "code-reviewer", task: "review" },
          ],
          async: true,
        });
        const parallelTasks = captured.parallel?.tasks as Array<Record<string, unknown>>;
        assert.deepEqual(
          parallelTasks.map((task) => task.promptVariant),
          ["normal", undefined],
        );
      }
    } finally {
      if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousProfile;
      if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previousChild;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults canonical and noncanonical children to normal without positive policy evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-prompt-variant-normal-"));
    const previousProfile = process.env.PI_CODING_AGENT_DIR;
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "profile");
    try {
      const policies: Array<(() => AccessFixture | undefined) | undefined> = [
        undefined,
        () => ({ architect: false, canManage: "broken", canInitiate: "broken", noDeveloper: true }),
        () => ({
          architect: false,
          canManage: true,
          canInitiate: true,
          noDeveloper: true,
          trustStore: {},
        }),
        () => {
          throw new Error("bridge unavailable");
        },
      ];
      for (const accessProvider of policies) {
        const { executor, captured } = makeHarness(root, accessProvider);
        await dispatch(executor, root, { agent: "test-runner", task: "check" });
        assert.equal(captured.single?.promptVariant, "normal");
      }

      const noncanonical = makeHarness(root, () => ({
        architect: true,
        canManage: true,
        canInitiate: true,
        noDeveloper: true,
      }));
      const customPath = path.join(root, "custom-test-runner.md");
      // The harness's canonical agent is intentionally replaced with an agent
      // carrying the same role name outside the installer-managed path.
      noncanonical.executor = createSubagentExecutor({
        pi: makeExtensionAPI(),
        state: makeSubagentState({ baseCwd: root, currentSessionId: "parent-session" }),
        config: { maxSubagentDepth: 2, control: {} },
        tempArtifactsDir: root,
        getSubagentSessionRoot: () => path.join(root, "sessions"),
        expandTilde: (value) => value,
        discoverAgents: () => ({
          agents: [makeAgent("test-runner", { filePath: customPath, systemPrompt: PROMPT_SOURCE })],
        }),
        getProjectAgentAccess: () => ({
          architect: true,
          canManage: true,
          canInitiate: true,
          noDeveloper: true,
        }),
        executeAsyncSingle: ((runId: string, params: Record<string, unknown>) => {
          noncanonical.captured.single = params;
          return {
            content: [{ type: "text", text: "dispatched" }],
            details: { mode: "single", results: [], asyncId: runId },
          };
        }) as any,
      });
      await dispatch(noncanonical.executor, root, { agent: "test-runner", task: "check" });
      assert.equal(noncanonical.captured.single?.promptVariant, undefined);
    } finally {
      if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousProfile;
      if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previousChild;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
