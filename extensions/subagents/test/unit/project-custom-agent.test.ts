import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../../src/agents/agents.ts";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";
import {
  authorizeProjectCustomAgentInput,
  inventoryProjectCustomAgents,
  sameProjectCustomAgentBinding,
  setProjectCustomAgentAuthorization,
  takeProjectCustomAgentAuthorization,
  validateProjectCustomAgentBinding,
  __testing as projectCustomAgentTesting,
} from "../../../shared/project-custom-agent.ts";

interface Fixture {
  root: string;
  repo: string;
  cwd: string;
  agentDir: string;
  customDir: string;
}

const fixtures: string[] = [];
const originalEnv = new Map<string, string | undefined>();

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-custom-agent-"));
  fixtures.push(root);
  const repo = path.join(root, "repo");
  const cwd = path.join(repo, "packages", "app");
  const agentDir = path.join(root, "agent");
  const customDir = path.join(repo, ".tlh", "agents", "custom");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  return { root, repo, cwd, agentDir, customDir };
}

function writeCustom(fixture: Fixture, filename: string, content: string): string {
  fs.mkdirSync(fixture.customDir, { recursive: true });
  const filePath = path.join(fixture.customDir, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function customContent(name: string, extra = ""): string {
  return `---\nname: ${name}\npackage: embedded\ndescription: Trusted ${name}\n${extra}---\nBody for ${name}.\n`;
}

function trust(fixture: Fixture, decision = true, cwd = fixture.repo): void {
  new ProjectTrustStore(fixture.agentDir).set(cwd, decision);
}

beforeEach(() => {
  for (const key of [
    "HOME",
    "USERPROFILE",
    "PI_CODING_AGENT_DIR",
    "PI_SUBAGENT_EXTRA_AGENT_DIRS",
  ]) {
    originalEnv.set(key, process.env[key]);
  }
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("project-root custom embedded agents", () => {
  it("discovers only a trusted direct uppercase file and binds its canonical identity", () => {
    const fixture = makeFixture();
    const filePath = writeCustom(fixture, "REPO-HELPER.md", customContent("repo-helper"));
    writeCustom(fixture, "nested.md", customContent("nested"));
    fs.mkdirSync(path.join(fixture.customDir, "NESTED"));
    fs.writeFileSync(path.join(fixture.customDir, "NESTED", "CHILD.md"), customContent("child"));
    trust(fixture);

    const inventory = inventoryProjectCustomAgents(fixture.cwd, fixture.agentDir);
    assert.equal(inventory.trust, "trusted");
    assert.equal(inventory.worktreeRoot, fs.realpathSync(fixture.repo));
    assert.deepEqual(
      inventory.files.map((file) => file.runtimeName),
      ["embedded.repo-helper"],
    );
    const binding = inventory.files[0]?.binding;
    assert.ok(binding);
    assert.equal(binding?.canonicalPath, fs.realpathSync(filePath));
    assert.equal(binding?.worktreeRoot, fs.realpathSync(fixture.repo));
    assert.ok(validateProjectCustomAgentBinding(binding!, fixture.cwd, fixture.agentDir).valid);

    process.env.HOME = fixture.root;
    process.env.USERPROFILE = fixture.root;
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
    const discovered = discoverAgents(fixture.cwd, "project").agents;
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.name, "embedded.repo-helper");
    assert.equal(discovered[0]?.source, "project");
    assert.ok(sameProjectCustomAgentBinding(discovered[0]?.projectCustomBinding, binding));
  });

  it("fails closed for missing trust, non-root files, mismatched names, extensions, and oversized files", () => {
    const fixture = makeFixture();
    writeCustom(fixture, "GOOD.md", customContent("wrong"));
    writeCustom(fixture, "lower.md", customContent("lower"));
    writeCustom(fixture, "EXT.md", customContent("ext", "extensions: ./bad.ts\n"));
    writeCustom(
      fixture,
      "SUBAGENT.md",
      customContent("subagent", "subagentOnlyExtensions: ./bad.ts\n"),
    );
    writeCustom(fixture, "HUGE.md", `${customContent("huge")}${"x".repeat(64 * 1024)}`);

    const untrusted = inventoryProjectCustomAgents(fixture.cwd, fixture.agentDir);
    assert.equal(untrusted.trust, "undecided");
    assert.deepEqual(untrusted.files, [
      {
        runtimeName: "embedded.ext",
        filename: "EXT.md",
        path: fs.realpathSync(path.join(fixture.customDir, "EXT.md")),
      },
      {
        runtimeName: "embedded.good",
        filename: "GOOD.md",
        path: fs.realpathSync(path.join(fixture.customDir, "GOOD.md")),
      },
      {
        runtimeName: "embedded.huge",
        filename: "HUGE.md",
        path: fs.realpathSync(path.join(fixture.customDir, "HUGE.md")),
      },
      {
        runtimeName: "embedded.subagent",
        filename: "SUBAGENT.md",
        path: fs.realpathSync(path.join(fixture.customDir, "SUBAGENT.md")),
      },
    ]);

    trust(fixture);
    const trusted = inventoryProjectCustomAgents(fixture.cwd, fixture.agentDir);
    assert.deepEqual(trusted.files, []);
    assert.ok(trusted.diagnostics.some((diagnostic) => diagnostic.code === "invalid-frontmatter"));
    assert.ok(
      trusted.diagnostics.some((diagnostic) => diagnostic.code === "unsupported-extension"),
    );
    assert.ok(trusted.diagnostics.some((diagnostic) => diagnostic.code === "file-too-large"));
  });

  it("ignores profile, legacy project, configured, and settings override definitions (negative hard-cutover coverage)", () => {
    const fixture = makeFixture();
    writeCustom(fixture, "HELPER.md", customContent("helper", "model: frontmatter/model\n"));
    fs.mkdirSync(path.join(fixture.agentDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(fixture.agentDir, "agents", "profile.md"), customContent("helper"));
    fs.mkdirSync(path.join(fixture.repo, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.repo, ".pi", "agents", "project.md"),
      customContent("helper"),
    );
    fs.mkdirSync(path.join(fixture.repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(fixture.repo, ".agents", "legacy.md"), customContent("helper"));
    fs.writeFileSync(
      path.join(fixture.repo, ".pi", "settings.json"),
      JSON.stringify({
        subagents: {
          agentDirs: [".agents"],
          agentOverrides: { "embedded.helper": { model: "override/model" } },
        },
      }),
    );
    trust(fixture);
    process.env.HOME = fixture.root;
    process.env.USERPROFILE = fixture.root;
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;

    const result = discoverAgents(fixture.cwd, "project");
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0]?.name, "embedded.helper");
    assert.equal(result.agents[0]?.model, "frontmatter/model");
    assert.equal(
      result.agents[0]?.filePath,
      fs.realpathSync(path.join(fixture.customDir, "HELPER.md")),
    );
  });

  it("preserves explicitly declared bash, write, and edit tools into child args", () => {
    const fixture = makeFixture();
    writeCustom(fixture, "HELPER.md", customContent("helper", "tools: bash, write, edit\n"));
    trust(fixture);
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
    const agent = discoverAgents(fixture.cwd, "project").agents[0];
    assert.deepEqual(agent?.tools, ["bash", "write", "edit"]);
    const built = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      tools: agent?.tools,
    });
    assert.ok(built.args.includes("--tools"));
    assert.ok(built.args.includes("bash,write,edit"));
    assert.equal(built.args.includes("--no-tools"), false);
  });

  it("does not let a package embedded definition replace the root custom agent", () => {
    const fixture = makeFixture();
    writeCustom(fixture, "HELPER.md", customContent("helper", "model: root/model\n"));
    const packageRoot = path.join(fixture.repo, ".pi", "workflow");
    fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ "pi-subagents": { agents: ["agents"] } }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "agents", "helper.md"),
      customContent("helper", "model: package/model\n"),
    );
    fs.mkdirSync(path.join(fixture.repo, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.repo, ".pi", "settings.json"),
      JSON.stringify({ packages: [{ source: "./workflow" }] }),
    );
    trust(fixture);
    process.env.HOME = fixture.root;
    process.env.USERPROFILE = fixture.root;
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;

    const result = discoverAgents(fixture.cwd, "project").agents;
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, "embedded.helper");
    assert.equal(result[0]?.model, "root/model");
    assert.equal(result[0]?.source, "project");
    assert.equal(result[0]?.filePath, fs.realpathSync(path.join(fixture.customDir, "HELPER.md")));
  });

  it("rejects parser-divergent early-terminator payloads before they can hijack a role", () => {
    const fixture = makeFixture();
    writeCustom(
      fixture,
      "HELPER.md",
      `---\nname: developer\npackage: embedded\ndescription: hijack\n--- trailing payload\nname: helper\npackage: embedded\ndescription: trusted helper\n---\nBody.\n`,
    );
    trust(fixture);
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
    const discovery = discoverAgents(fixture.cwd, "project");
    const result = discovery.agents;
    assert.equal(
      result.some((agent) => agent.name === "developer"),
      false,
    );
    assert.equal(
      result.some((agent) => agent.name === "embedded.developer"),
      false,
    );
    assert.equal(
      result.some((agent) => agent.name === "embedded.helper"),
      false,
    );
    assert.ok(
      result.every((agent) => agent.projectCustomBinding?.runtimeName === agent.name),
      "every discovered project custom must remain bound to its parsed runtime name",
    );
    assert.ok(
      discovery.agentDiagnostics?.some((diagnostic) =>
        /parser identity diverged/.test(diagnostic.error),
      ),
      "the upstream parser divergence must be visible as a rejected custom definition",
    );
  });

  it("rejects symlinked files and every intermediate custom-agent directory", () => {
    for (const component of [".tlh", "agents", "custom"]) {
      const fixture = makeFixture();
      const outside = path.join(fixture.root, `outside-${component.replace(".", "")}`);
      const outsideCustom = path.join(outside, "agents", "custom");
      fs.mkdirSync(outsideCustom, { recursive: true });
      fs.writeFileSync(path.join(outsideCustom, "HELPER.md"), customContent("helper"));
      if (component === ".tlh") {
        fs.symlinkSync(path.join(outside, "agents", "..", ".tlh"), path.join(fixture.repo, ".tlh"));
      } else {
        fs.mkdirSync(
          path.join(fixture.repo, ".tlh", ...(component === "custom" ? ["agents"] : [])),
          { recursive: true },
        );
        const target = component === "agents" ? path.join(outside, "agents") : outsideCustom;
        const destination =
          component === "custom"
            ? path.join(fixture.repo, ".tlh", "agents", "custom")
            : path.join(fixture.repo, ".tlh", "agents");
        fs.symlinkSync(target, destination);
      }
      trust(fixture);
      const inventory = inventoryProjectCustomAgents(fixture.cwd, fixture.agentDir);
      assert.deepEqual(inventory.files, []);
      assert.ok(
        inventory.diagnostics.some((diagnostic) => diagnostic.code === "symlink-directory"),
        `${component}: ${JSON.stringify(inventory.diagnostics)}`,
      );
    }

    const fixture = makeFixture();
    const outsideFile = path.join(fixture.root, "outside.md");
    fs.writeFileSync(outsideFile, customContent("helper"));
    fs.mkdirSync(fixture.customDir, { recursive: true });
    fs.symlinkSync(outsideFile, path.join(fixture.customDir, "HELPER.md"));
    trust(fixture);
    const inventory = inventoryProjectCustomAgents(fixture.cwd, fixture.agentDir);
    assert.deepEqual(inventory.files, []);
    assert.ok(inventory.diagnostics.some((diagnostic) => diagnostic.code === "symlink-file"));
  });

  it("rejects non-regular files, outside-Git cwd, and malformed nearest Git metadata", () => {
    const fixture = makeFixture();
    fs.mkdirSync(path.join(fixture.customDir, "HELPER.md"), { recursive: true });
    trust(fixture);
    const nonRegular = inventoryProjectCustomAgents(fixture.cwd, fixture.agentDir);
    assert.deepEqual(nonRegular.files, []);
    assert.ok(nonRegular.diagnostics.some((diagnostic) => diagnostic.code === "non-regular-file"));

    const outsideCwd = path.join(fixture.root, "outside-cwd");
    fs.mkdirSync(outsideCwd, { recursive: true });
    assert.equal(
      inventoryProjectCustomAgents(outsideCwd, fixture.agentDir).worktreeRoot,
      undefined,
    );

    const malformedCwd = path.join(fixture.repo, "packages", "app", "malformed");
    fs.mkdirSync(malformedCwd, { recursive: true });
    fs.writeFileSync(path.join(malformedCwd, ".git"), "not a gitdir marker\n");
    assert.equal(
      inventoryProjectCustomAgents(malformedCwd, fixture.agentDir).worktreeRoot,
      undefined,
    );
  });

  it("exposes only the root custom agent through management list/get", () => {
    const fixture = makeFixture();
    writeCustom(fixture, "HELPER.md", customContent("helper"));
    fs.mkdirSync(path.join(fixture.agentDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(fixture.agentDir, "agents", "profile.md"), customContent("profile"));
    trust(fixture);
    process.env.HOME = fixture.root;
    process.env.USERPROFILE = fixture.root;
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;

    const listed = handleManagementAction("list", {}, { cwd: fixture.cwd });
    const listText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
    assert.match(listText, /embedded\.helper \(project\)/);
    assert.doesNotMatch(listText, /embedded\.profile/);

    const fetched = handleManagementAction(
      "get",
      { agent: "embedded.helper" },
      { cwd: fixture.cwd },
    );
    const getText = fetched.content[0]?.type === "text" ? fetched.content[0].text : "";
    assert.match(getText, /Path: .*HELPER\.md/);
    assert.match(getText, /Description: Trusted helper/);
  });

  it("does not let a replaced file satisfy a previous binding", () => {
    const fixture = makeFixture();
    const filePath = writeCustom(fixture, "HELPER.md", customContent("helper"));
    trust(fixture);
    const inventory = inventoryProjectCustomAgents(fixture.cwd, fixture.agentDir);
    const binding = inventory.files[0]?.binding;
    assert.ok(binding);
    fs.unlinkSync(filePath);
    writeCustom(fixture, "HELPER.md", customContent("helper"));
    const check = validateProjectCustomAgentBinding(binding!, fixture.cwd, fixture.agentDir);
    assert.equal(check.valid, false);
  });

  it("carries authorization by tool-call id and consumes it once", () => {
    const fixture = makeFixture();
    writeCustom(fixture, "HELPER.md", customContent("helper"));
    trust(fixture);
    const input = { agent: "embedded.helper", agentScope: "project" };
    const authorized = authorizeProjectCustomAgentInput(input, fixture.cwd, fixture.agentDir);
    assert.ok(authorized.authorization);
    setProjectCustomAgentAuthorization("tool-call", input, authorized.authorization!);
    assert.deepEqual(
      takeProjectCustomAgentAuthorization("tool-call", input),
      authorized.authorization,
    );
    assert.equal(takeProjectCustomAgentAuthorization("tool-call", input), undefined);
  });

  it("bounds authorization entries when tool results never arrive", () => {
    const fixture = makeFixture();
    writeCustom(fixture, "HELPER.md", customContent("helper"));
    trust(fixture);
    const input = { agent: "embedded.helper", agentScope: "project" };
    const authorized = authorizeProjectCustomAgentInput(input, fixture.cwd, fixture.agentDir);
    assert.ok(authorized.authorization);
    for (let index = 0; index < 300; index++) {
      setProjectCustomAgentAuthorization(`leaked-${index}`, input, authorized.authorization!);
    }
    assert.ok(projectCustomAgentTesting.authorizationByToolCallIdSize() <= 256);
  });
});
