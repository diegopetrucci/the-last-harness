import assert from "node:assert/strict";
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
  type SubagentParamsLike,
} from "../../src/runs/foreground/subagent-executor.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-agent-execution-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, ".tlh", "agents"), { recursive: true });
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
    filePath: path.join(projectRoot, ".tlh", "agents", "xyz.md"),
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

function makeContext(projectRoot: string): ExtensionContext {
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
    model: undefined,
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
    }),
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
    agentScope: "user",
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
  it("uses the exact active snapshot and confines a mixed async batch before spawning", async () => {
    const projectRoot = makeProject();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-agent-outside-"));
    tempRoots.push(outsideRoot);
    const profileDir = path.join(projectRoot, "profile");
    process.env.PI_CODING_AGENT_DIR = profileDir;
    fs.mkdirSync(path.join(profileDir, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "agents", "developer.md"),
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
        agentScope: "user",
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
        agentScope: "user",
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
        agentScope: "user",
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
        agentScope: "user",
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
