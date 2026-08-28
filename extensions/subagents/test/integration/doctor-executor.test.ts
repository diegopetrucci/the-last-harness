import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
  createEventBus,
  createTempDir,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
  tryImport,
} from "../support/helpers.ts";
import {
  inventoryProjectCustomAgents,
  type ProjectCustomAgentBinding,
} from "../../../shared/project-custom-agent.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const importHome = createTempDir("pi-doctor-executor-import-home-");
process.env.HOME = importHome;
process.env.USERPROFILE = importHome;
let executorMod: any;
try {
  executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  removeTempDir(importHome);
}
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function makeState(cwd: string) {
  return {
    baseCwd: cwd,
    currentSessionId: null,
    asyncJobs: new Map(),
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

describe(
  "doctor action executor routing",
  {
    skip: !createSubagentExecutor ? "executor not importable" : undefined,
  },
  () => {
    let tempDir = "";
    let tempHome = "";

    beforeEach(() => {
      tempDir = createTempDir("pi-doctor-executor-project-");
      tempHome = createTempDir("pi-doctor-executor-home-");
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
    });

    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
      removeTempDir(tempDir);
      removeTempDir(tempHome);
    });

    it("returns a doctor report for the tool action", async () => {
      const sessionFile = path.join(tempDir, "sessions", "parent.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, "");
      const executor = createSubagentExecutor({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state: makeState(tempDir),
        config: {},
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents: [] }),
      });
      const ctx = makeMinimalCtx(tempDir);
      ctx.sessionManager.getSessionFile = () => sessionFile;
      ctx.sessionManager.getSessionId = () => "session-doctor";

      const result = await executor.execute(
        "doctor-id",
        { action: "doctor" },
        new AbortController().signal,
        undefined,
        ctx,
      );

      assert.equal(result.isError, undefined);
      const text = result.content[0]?.text ?? "";
      assert.match(text, /^Subagents doctor report/);
      assert.match(text, /- configured session dir: not configured/);
      assert.match(
        text,
        /- supervisor channel: available \(native:pi-subagents-supervisor-channel\)/,
      );
    });

    it("rejects direct and nested custom targets when cwd roots differ without primary authorization", async () => {
      const repoA = path.join(tempDir, "repo-a");
      const repoB = path.join(tempDir, "repo-b");
      fs.mkdirSync(repoA, { recursive: true });
      fs.mkdirSync(repoB, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: repoA });
      execFileSync("git", ["init", "--quiet"], { cwd: repoB });
      const agentDir = path.join(tempHome, "agent");
      const filePath = path.join(repoA, ".tlh", "agents", "custom", "HELPER.md");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        "---\nname: helper\npackage: embedded\ndescription: Helper\n---\n\nHelper.\n",
        "utf-8",
      );
      fs.mkdirSync(agentDir, { recursive: true });
      process.env.PI_CODING_AGENT_DIR = agentDir;
      new ProjectTrustStore(agentDir).set(repoA, true);
      const binding = inventoryProjectCustomAgents(repoA, agentDir).files[0]?.binding;
      assert.ok(binding);
      const agent = makeAgent("embedded.helper", {
        source: "project",
        filePath,
        projectCustomBinding: binding as ProjectCustomAgentBinding,
      });
      const executor = createSubagentExecutor({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state: makeState(repoA),
        config: {},
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents: [agent] }),
      });
      const ctx = makeMinimalCtx(repoA);
      const direct = await executor.execute(
        "direct-mismatch",
        { agent: "embedded.helper", task: "inspect", cwd: repoB, agentScope: "project" },
        new AbortController().signal,
        undefined,
        ctx,
      );
      assert.equal(direct.isError, true);
      assert.match(direct.content[0]?.text ?? "", /outside the effective Git root|binding root/i);

      const nested = await executor.execute(
        "nested-mismatch",
        {
          tasks: [{ agent: "embedded.helper", task: "inspect", cwd: repoB }],
          cwd: repoA,
          agentScope: "project",
        },
        new AbortController().signal,
        undefined,
        ctx,
      );
      assert.equal(nested.isError, true);
      assert.match(nested.content[0]?.text ?? "", /outside the effective Git root|cwd overrides/i);
    });

    it("reports session manager failures without failing the doctor action", async () => {
      const executor = createSubagentExecutor({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state: makeState(tempDir),
        config: {},
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents: [] }),
      });
      const ctx = makeMinimalCtx(tempDir);
      ctx.sessionManager.getSessionFile = () => {
        throw new Error("session unavailable");
      };
      ctx.sessionManager.getSessionId = () => {
        throw new Error("session unavailable");
      };

      const result = await executor.execute(
        "doctor-id",
        { action: "doctor" },
        new AbortController().signal,
        undefined,
        ctx,
      );

      assert.equal(result.isError, undefined);
      const text = result.content[0]?.text ?? "";
      assert.match(text, /^Subagents doctor report/);
      assert.match(text, /- session manager: failed — Error: session unavailable/);
      assert.match(text, /- current session file: not available/);
    });
  },
);
