import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import {
  createPiHarness,
  createPrimaryPrompt,
  createToolCallContext,
  registerTlhPrimaryAgentRuntime,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

function customDefinition(name, extra = "") {
  return `---\nname: ${name}\npackage: embedded\ndescription: Trusted ${name}\n${extra}---\nBody.\n`;
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "tlh-primary-custom-agent-"));
  const repo = join(root, "repo");
  const cwd = join(repo, "src");
  const agent = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agent, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  return { root, repo, cwd, agent, customDir: join(repo, ".tlh", "agents", "custom") };
}

function registerHarness() {
  const pi = createPiHarness();
  registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: new Map([["architect", createPrimaryPrompt("architect")]]),
    subagentMetadata: [],
  });
  const toolCall = pi.events.find((event) => event.name === "tool_call")?.handler;
  assert.equal(typeof toolCall, "function");
  return toolCall;
}

test("primary embedded authorization binds the trusted Git-root uppercase definition", async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(fixture.customDir, { recursive: true });
    writeFileSync(join(fixture.customDir, "HELPER.md"), customDefinition("helper"));
    mkdirSync(join(fixture.agent, "agents"), { recursive: true });
    writeFileSync(join(fixture.agent, "agents", "helper.md"), customDefinition("helper"));
    new ProjectTrustStore(fixture.agent).set(fixture.repo, true);

    const previous = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    process.env.HOME = fixture.root;
    process.env.USERPROFILE = fixture.root;
    process.env.PI_CODING_AGENT_DIR = fixture.agent;
    try {
      const toolCall = registerHarness();
      const input = { agent: "embedded.helper", task: "inspect the repository" };
      const ctx = createToolCallContext(
        [
          {
            type: "custom",
            customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
            data: { selected: "architect" },
          },
        ],
        undefined,
        { cwd: fixture.cwd },
      );
      assert.equal(
        await toolCall({ toolName: "subagent", toolCallId: "root-custom", input }, ctx),
        undefined,
      );
      assert.equal(input.agentScope, "project");
      assert.equal(input.context, "fresh");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("primary embedded authorization fails closed without persisted project trust", async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(fixture.customDir, { recursive: true });
    writeFileSync(join(fixture.customDir, "HELPER.md"), customDefinition("helper"));
    const previous = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    process.env.HOME = fixture.root;
    process.env.USERPROFILE = fixture.root;
    process.env.PI_CODING_AGENT_DIR = fixture.agent;
    try {
      const toolCall = registerHarness();
      const input = { agent: "embedded.helper", task: "inspect the repository" };
      const ctx = createToolCallContext(
        [
          {
            type: "custom",
            customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
            data: { selected: "architect" },
          },
        ],
        undefined,
        { cwd: fixture.cwd },
      );
      const result = await toolCall(
        { toolName: "subagent", toolCallId: "untrusted-custom", input },
        ctx,
      );
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /persisted project trust|valid trusted file/i);
      assert.match(result?.reason ?? "", /\.tlh\/agents\/custom/);
      assert.match(result?.reason ?? "", /\/trust/);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
