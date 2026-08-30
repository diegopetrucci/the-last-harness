import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getProjectAgentSnapshotProvenance,
  registerProjectAgentSnapshot,
  type ProjectAgentSnapshotCapability,
} from "../../src/agents/project-agent-snapshot.ts";
import {
  createSubagentExecutor,
  projectAgentEntryIdentityError,
  type SubagentParamsLike,
} from "../../src/runs/foreground/subagent-executor.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeProject(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-agent-execution-")),
  );
  tempRoots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  fs.mkdirSync(path.join(root, ".tlh", "agents", "custom"), { recursive: true });
  fs.mkdirSync(path.join(root, "inside"), { recursive: true });
  return root;
}

function makeAgent(projectRoot: string, name = "embedded.xyz"): AgentConfig {
  return {
    name,
    localName: name.slice("embedded.".length),
    packageName: "embedded",
    description: "Project test agent",
    tools: ["read"],
    systemPrompt: "Project test prompt.",
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    source: "project",
    filePath: path.join(projectRoot, ".tlh", "agents", "custom", "XYZ.md"),
  };
}

function makeState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: "session-execution-test",
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function asFixture<T>(value: Partial<T>): T {
  // SAFETY: These tests provide only the runtime members consumed by the exercised gate path.
  return value as T;
}

function makeContext(
  projectRoot: string,
  model?: { provider: string; id: string },
): ExtensionContext {
  const context = {
    cwd: projectRoot,
    hasUI: false,
    ui: asFixture<ExtensionContext["ui"]>({
      notify() {},
      confirm: async () => false,
    }),
    sessionManager: asFixture<ExtensionContext["sessionManager"]>({
      getSessionId: () => "session-execution-test",
      getSessionFile: () => undefined,
      getBranch: () => [],
    }),
    modelRegistry: asFixture<ExtensionContext["modelRegistry"]>({ getAvailable: () => [] }),
    model: model as ExtensionContext["model"],
    isProjectTrusted: () => false,
    mode: "json" as const,
    scopedModels: [],
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  };
  return context;
}

function makeExecutor(
  projectRoot: string,
  capability: ProjectAgentSnapshotCapability,
  expected: ReturnType<typeof getProjectAgentSnapshotProvenance>,
  discoverCalls: { count: number },
  architect = true,
  options: {
    canInitiate?: boolean;
    runSync?: (
      runtimeCwd: string,
      agents: AgentConfig[],
      agentName: string,
      task: string,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  } = {},
) {
  const pi = asFixture<ExtensionAPI>({
    // The executor only consumes the event bus and session-name methods in these gate tests.
    // Keep the fixture narrow rather than manufacturing unrelated ExtensionAPI behavior.
    events: { on: () => () => {}, emit() {} },
    getSessionName: () => undefined,
  });
  return createSubagentExecutor({
    pi,
    state: makeState(),
    config: { maxSubagentDepth: 2 },
    tempArtifactsDir: path.join(projectRoot, "artifacts"),
    getSubagentSessionRoot: () => path.join(projectRoot, "sessions"),
    expandTilde: (value) => value,
    discoverAgents: () => {
      discoverCalls.count += 1;
      return { agents: [] };
    },
    getProjectAgentAccess: () => ({
      capability,
      expected,
      architect,
      ...(options.canInitiate !== undefined ? { canInitiate: options.canInitiate } : {}),
    }),
    runSync: options.runSync as never,
  });
}

function registerSnapshot(projectRoot: string, agent = makeAgent(projectRoot)) {
  const capability = registerProjectAgentSnapshot({
    projectRoot,
    sessionId: "session-execution-test",
    generationId: "generation-execution-test",
    entries: [{ agent, digest: "digest-execution-test", frontmatterFields: ["tools"] }],
  });
  return { capability, expected: getProjectAgentSnapshotProvenance(capability) };
}

function identityEntry(projectRoot: string, overrides: Record<string, unknown> = {}) {
  return {
    agent: { ...makeAgent(projectRoot), ...overrides },
    digest: "digest-execution-test",
    frontmatterFields: ["tools"],
  } as never;
}

function addNestedLinkedWorktree(projectRoot: string): string {
  fs.writeFileSync(path.join(projectRoot, "tracked.txt"), "tracked\n", "utf8");
  execFileSync("git", ["-C", projectRoot, "add", "tracked.txt"]);
  execFileSync("git", [
    "-C",
    projectRoot,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=TLH Test",
    "commit",
    "--quiet",
    "-m",
    "initial test commit",
  ]);
  const linkedRoot = path.join(projectRoot, "nested-linked-worktree");
  execFileSync("git", ["-C", projectRoot, "worktree", "add", "--quiet", linkedRoot]);
  return fs.realpathSync(linkedRoot);
}

function asyncParallelTooLargeParams(projectRoot: string): SubagentParamsLike {
  return {
    tasks: [
      { agent: "embedded.xyz", task: "inspect project snapshot", cwd: "inside" },
      ...Array.from({ length: 8 }, () => ({
        agent: "developer",
        task: "inspect profile",
        cwd: "inside",
      })),
    ],
    agentScope: "project",
    context: "fresh",
    cwd: projectRoot,
    async: true,
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
});

describe("project-agent executor authorization", () => {
  it("rejects every malformed project-agent identity at the identity gate", () => {
    const projectRoot = makeProject();
    const canonicalRoot = fs.realpathSync(projectRoot);
    const cases: Array<{
      name: string;
      overrides: Record<string, unknown>;
      expected: RegExp;
    }> = [
      {
        name: "runtime name",
        overrides: { name: "project.xyz" },
        expected: /runtime name .*valid embedded project-agent identity/,
      },
      {
        name: "local name",
        overrides: { localName: "different" },
        expected: /does not match its embedded package\/local identity/,
      },
      {
        name: "package name",
        overrides: { packageName: "other" },
        expected: /does not match its embedded package\/local identity/,
      },
      {
        name: "source",
        overrides: { source: "profile" },
        expected: /is not sourced from the project snapshot/,
      },
      {
        name: "missing tools",
        overrides: { tools: undefined },
        expected: /does not carry an explicit usable tools list/,
      },
      {
        name: "empty tools",
        overrides: { tools: [] },
        expected: /does not carry an explicit usable tools list/,
      },
      {
        name: "extensions",
        overrides: { extensions: ["project-extension"] },
        expected: /carries a prohibited extension surface/,
      },
      {
        name: "subagent-only extensions",
        overrides: { subagentOnlyExtensions: ["project-extension"] },
        expected: /carries a prohibited extension surface/,
      },
      {
        name: "absolute definition path",
        overrides: { filePath: path.join("relative", "XYZ.md") },
        expected: /does not carry an absolute definition path/,
      },
      {
        name: "canonical definition directory",
        overrides: {
          filePath: path.join(canonicalRoot, ".tlh", "agents", "other", "XYZ.md"),
        },
        expected: /definition path is not the canonical .*XYZ\.md path/,
      },
      {
        name: "canonical definition filename",
        overrides: {
          filePath: path.join(canonicalRoot, ".tlh", "agents", "custom", "OTHER.md"),
        },
        expected: /definition path is not the canonical .*XYZ\.md path/,
      },
    ];

    for (const { name, overrides, expected } of cases) {
      const error = projectAgentEntryIdentityError(
        canonicalRoot,
        identityEntry(projectRoot, overrides),
      );
      assert.match(error ?? "", expected, name);
    }
  });

  it("rejects malformed registered snapshots before foreground or parallel spawn", async () => {
    const projectRoot = makeProject();
    const malformedAgent = { ...makeAgent(projectRoot), tools: [] } as AgentConfig;
    const snapshot = registerSnapshot(projectRoot, malformedAgent);
    const discoverCalls = { count: 0 };
    let spawnCalls = 0;
    const executor = makeExecutor(
      projectRoot,
      snapshot.capability,
      snapshot.expected,
      discoverCalls,
      true,
      {
        runSync: async () => {
          spawnCalls += 1;
          return {};
        },
      },
    );
    const cases: Array<{ id: string; params: SubagentParamsLike }> = [
      {
        id: "malformed-registered-single",
        params: {
          agent: "embedded.xyz",
          task: "must reject malformed registered identity",
          agentScope: "project",
          context: "fresh",
          cwd: projectRoot,
        },
      },
      {
        id: "malformed-registered-parallel",
        params: {
          tasks: [
            {
              agent: "embedded.xyz",
              task: "must reject malformed registered identity",
              cwd: projectRoot,
            },
          ],
          agentScope: "project",
          context: "fresh",
          cwd: projectRoot,
        },
      },
    ];

    for (const item of cases) {
      const result = await executor.execute(
        item.id,
        item.params,
        new AbortController().signal,
        undefined,
        makeContext(projectRoot),
      );
      assert.equal(result.isError, true, item.id);
      assert.match(resultText(result), /does not carry an explicit usable tools list/);
    }
    assert.equal(discoverCalls.count, 0);
    assert.equal(spawnCalls, 0);
    assert.equal(fs.existsSync(path.join(projectRoot, "sessions")), false);
  });

  it("rejects nested linked-worktree cwd roots before spawning for single and parallel execution", async () => {
    const projectRoot = makeProject();
    const linkedRoot = addNestedLinkedWorktree(projectRoot);
    const snapshot = registerSnapshot(projectRoot);
    const discoverCalls = { count: 0 };
    let spawned = false;
    const executor = makeExecutor(
      projectRoot,
      snapshot.capability,
      snapshot.expected,
      discoverCalls,
      true,
      {
        runSync: async () => {
          spawned = true;
          return {};
        },
      },
    );

    const singleResult = await executor.execute(
      "nested-linked-single",
      {
        agent: "embedded.xyz",
        task: "must stay in the containing worktree",
        agentScope: "project",
        context: "fresh",
        cwd: linkedRoot,
      } as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );
    assert.equal(singleResult.isError, true);
    assert.match(resultText(singleResult), /trusted snapshot worktree/i);
    assert.equal(discoverCalls.count, 0);
    assert.equal(spawned, false);

    const parallelResult = await executor.execute(
      "nested-linked-parallel",
      {
        tasks: [
          {
            agent: "embedded.xyz",
            task: "must stay in the containing worktree",
            cwd: linkedRoot,
          },
        ],
        agentScope: "project",
        context: "fresh",
        cwd: projectRoot,
      } as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );
    assert.equal(parallelResult.isError, true);
    assert.match(resultText(parallelResult), /one trusted snapshot worktree/i);
    assert.equal(discoverCalls.count, 0);
    assert.equal(spawned, false);
  });

  it("uses the exact active snapshot and confines a mixed async batch before spawning", async () => {
    const projectRoot = makeProject();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-agent-outside-"));
    tempRoots.push(outsideRoot);
    const profileDir = path.join(projectRoot, "profile");
    process.env.PI_CODING_AGENT_DIR = profileDir;
    fs.mkdirSync(path.join(profileDir, "tlh", "agents", "subagents"), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "tlh", "agents", "subagents", "developer.md"),
      `---
name: developer
description: Profile developer
tools: read
---
Profile developer prompt.
`,
      "utf8",
    );
    const snapshot = registerSnapshot(projectRoot);
    const discoverCalls = { count: 0 };
    const executor = makeExecutor(
      projectRoot,
      snapshot.capability,
      snapshot.expected,
      discoverCalls,
    );

    const result = await executor.execute(
      "project-execution",
      asyncParallelTooLargeParams(projectRoot) as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );

    assert.equal(result.isError, true);
    assert.match(resultText(result), /Max 8 tasks/);
    assert.equal(discoverCalls.count, 0);

    const outsideResult = await executor.execute(
      "project-outside",
      {
        agent: "embedded.xyz",
        task: "must not run",
        agentScope: "project",
        context: "fresh",
        cwd: outsideRoot,
      } as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );
    assert.equal(outsideResult.isError, true);
    assert.match(resultText(outsideResult), /outside|blocked/i);
    assert.equal(discoverCalls.count, 0);

    const mixedOutside = asyncParallelTooLargeParams(projectRoot);
    const mixedTask = mixedOutside.tasks?.[1];
    if (mixedTask) mixedTask.cwd = outsideRoot;
    const mixedResult = await executor.execute(
      "project-mixed-outside",
      mixedOutside as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );
    assert.equal(mixedResult.isError, true);
    assert.match(resultText(mixedResult), /outside|blocked/i);
    assert.equal(discoverCalls.count, 0);

    const whitespaceSingleResult = await executor.execute(
      "project-whitespace-single",
      {
        agent: " embedded.xyz ",
        task: "must not bypass project identity",
        agentScope: "project",
        context: "fresh",
        cwd: projectRoot,
      } as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );
    assert.equal(whitespaceSingleResult.isError, true);
    assert.match(resultText(whitespaceSingleResult), /surrounding whitespace|embedded\.xyz/i);
    assert.equal(discoverCalls.count, 0);

    const whitespaceTaskResult = await executor.execute(
      "project-whitespace-task",
      {
        tasks: [{ agent: "\tembedded.xyz\t", task: "must not bypass project identity" }],
        agentScope: "project",
        context: "fresh",
        cwd: projectRoot,
        async: true,
      } as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );
    assert.equal(whitespaceTaskResult.isError, true);
    assert.match(resultText(whitespaceTaskResult), /surrounding whitespace|embedded\.xyz/i);
    assert.equal(discoverCalls.count, 0);
  });

  it("rejects forged capability, non-architect identity, and non-fresh/user execution", async () => {
    const projectRoot = makeProject();
    const profileDir = path.join(projectRoot, "profile");
    process.env.PI_CODING_AGENT_DIR = profileDir;
    fs.mkdirSync(profileDir, { recursive: true });
    const snapshot = registerSnapshot(projectRoot);
    const discoverCalls = { count: 0 };
    const validExecutor = makeExecutor(
      projectRoot,
      snapshot.capability,
      snapshot.expected,
      discoverCalls,
    );

    for (const params of [
      { ...asyncParallelTooLargeParams(projectRoot), context: "fork" },
      { ...asyncParallelTooLargeParams(projectRoot), agentScope: "both" },
    ]) {
      const result = await validExecutor.execute(
        "unsafe-project-execution",
        params as never,
        new AbortController().signal,
        undefined,
        makeContext(projectRoot),
      );
      assert.equal(result.isError, true);
      assert.match(resultText(result), /requires|user-style|fresh/i);
    }

    const nonArchitectExecutor = makeExecutor(
      projectRoot,
      snapshot.capability,
      snapshot.expected,
      discoverCalls,
      false,
    );
    const nonArchitectResult = await nonArchitectExecutor.execute(
      "non-architect-project",
      asyncParallelTooLargeParams(projectRoot) as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );
    assert.equal(nonArchitectResult.isError, true);
    assert.match(resultText(nonArchitectResult), /architect/i);

    const forgedExecutor = makeExecutor(
      projectRoot,
      Object.freeze({}) as ProjectAgentSnapshotCapability,
      snapshot.expected,
      discoverCalls,
    );
    const forgedResult = await forgedExecutor.execute(
      "forged-project",
      asyncParallelTooLargeParams(projectRoot) as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );
    assert.equal(forgedResult.isError, true);
    assert.match(resultText(forgedResult), /capability|invalid/i);
    assert.equal(discoverCalls.count, 0);
  });

  it("routes foreground project execution through the exact capture and provider model policy", async () => {
    const projectRoot = makeProject();
    const agent = makeAgent(projectRoot);
    agent.model = "anthropic/file-model";
    const snapshot = registerSnapshot(projectRoot, agent);
    const discoverCalls = { count: 0 };
    const calls: Array<{
      agents: AgentConfig[];
      agentName: string;
      options: Record<string, unknown>;
    }> = [];
    const runSync = async (
      _runtimeCwd: string,
      agents: AgentConfig[],
      agentName: string,
      _task: string,
      options: Record<string, unknown>,
    ) => {
      calls.push({ agents, agentName, options });
      return {
        agent: agentName,
        task: "project task",
        exitCode: 0,
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        finalOutput: "project result",
      };
    };
    const executor = makeExecutor(
      projectRoot,
      snapshot.capability,
      snapshot.expected,
      discoverCalls,
      true,
      { runSync },
    );
    const baseParams = {
      agent: "embedded.xyz",
      task: "run the exact project agent",
      agentScope: "project" as const,
      context: "fresh" as const,
      cwd: projectRoot,
    };

    const fileModelResult = await executor.execute(
      "project-file-model",
      baseParams as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot, { provider: "anthropic", id: "live-model" }),
    );
    assert.equal(fileModelResult.isError, undefined);
    assert.equal(calls[0]?.agentName, "embedded.xyz");
    assert.equal(calls[0]?.options.modelOverride, "anthropic/file-model");
    assert.deepEqual(calls[0]?.agents.find((entry) => entry.name === "embedded.xyz")?.tools, [
      "read",
    ]);
    assert.equal(
      (calls[0]?.options.projectAgent as { provenance?: { digest?: string } } | undefined)
        ?.provenance?.digest,
      "digest-execution-test",
    );

    const openRouterResult = await executor.execute(
      "project-openrouter-model",
      baseParams as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot, { provider: "openrouter", id: "openai/live-model" }),
    );
    assert.equal(openRouterResult.isError, undefined);
    assert.equal(calls[1]?.options.modelOverride, "openrouter/openai/live-model");

    const explicitResult = await executor.execute(
      "project-explicit-model",
      { ...baseParams, model: "openai/explicit-model" } as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot, { provider: "openrouter", id: "openai/live-model" }),
    );
    assert.equal(explicitResult.isError, undefined);
    assert.equal(calls[2]?.options.modelOverride, "openai/explicit-model");
  });

  it("allows disabled mode to initiate a project run only with explicit capability access", async () => {
    const projectRoot = makeProject();
    const snapshot = registerSnapshot(projectRoot);
    const discoverCalls = { count: 0 };
    let spawned = false;
    const executor = makeExecutor(
      projectRoot,
      snapshot.capability,
      snapshot.expected,
      discoverCalls,
      false,
      {
        canInitiate: true,
        runSync: async (_runtimeCwd, _agents, agentName, task) => {
          spawned = true;
          return {
            agent: agentName,
            task,
            exitCode: 0,
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            finalOutput: "disabled result",
          };
        },
      },
    );
    const result = await executor.execute(
      "disabled-project",
      {
        agent: "embedded.xyz",
        task: "run while primary persona is disabled",
        agentScope: "project",
        context: "fresh",
        cwd: projectRoot,
      } as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );
    assert.equal(result.isError, undefined);
    assert.equal(spawned, true);
    assert.equal(discoverCalls.count, 0);
  });

  it("lets active tombstones block same-name profile fallback", async () => {
    const projectRoot = makeProject();
    const profileDir = path.join(projectRoot, "profile");
    process.env.PI_CODING_AGENT_DIR = profileDir;
    const profileAgent = path.join(profileDir, "agents", "xyz.md");
    fs.mkdirSync(path.dirname(profileAgent), { recursive: true });
    fs.writeFileSync(
      profileAgent,
      "---\nname: xyz\npackage: embedded\ndescription: Profile fallback\n---\nProfile.\n",
      "utf8",
    );
    const capability = registerProjectAgentSnapshot({
      projectRoot,
      sessionId: "session-execution-test",
      generationId: "generation-tombstone-test",
      entries: [],
      tombstones: ["embedded.xyz"],
    });
    const expected = getProjectAgentSnapshotProvenance(capability);
    const discoverCalls = { count: 0 };
    const executor = makeExecutor(projectRoot, capability, expected, discoverCalls);
    const result = await executor.execute(
      "tombstoned-project",
      {
        agent: "embedded.xyz",
        task: "must not use profile fallback",
        agentScope: "project",
        context: "fresh",
        cwd: projectRoot,
        async: true,
      } as never,
      new AbortController().signal,
      undefined,
      makeContext(projectRoot),
    );

    assert.equal(result.isError, true);
    assert.match(resultText(result), /tombstone|profile fallback/i);
    assert.equal(discoverCalls.count, 0);
  });
});
