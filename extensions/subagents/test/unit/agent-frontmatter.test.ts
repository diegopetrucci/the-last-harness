import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
  discoverAgents as upstreamDiscoverAgents,
  discoverAgentsAll as upstreamDiscoverAgentsAll,
} from "../../src/agents/agents.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";
import { THINKING_LEVELS } from "../../src/shared/model-info.ts";

const tempDirs: string[] = [];

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeAgent(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf-8");
}

function writeRootCustomAgent(
  dir: string,
  filename: string,
  name: string,
  body = "Custom prompt",
): string {
  const filePath = path.join(dir, ".tlh", "agents", "custom", filename);
  writeAgent(
    filePath,
    `---\nname: ${name}\npackage: embedded\ndescription: ${name} custom\n---\n\n${body}\n`,
  );
  return filePath;
}

function trustRoot(dir: string, agentDir = path.join(dir, ".agent-profile")): string {
  if (!fs.existsSync(path.join(dir, ".git")))
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  new ProjectTrustStore(agentDir).set(dir, true);
  return agentDir;
}

function ensureProjectAgentPackage(cwd: string): void {
  let packageRoot = path.resolve(cwd);
  while (
    !fs.existsSync(path.join(packageRoot, ".pi", "agents")) &&
    path.dirname(packageRoot) !== packageRoot
  ) {
    packageRoot = path.dirname(packageRoot);
  }
  if (!fs.existsSync(path.join(packageRoot, ".pi", "agents"))) return;
  const packagePath = path.join(packageRoot, "package.json");
  if (fs.existsSync(packagePath)) return;
  writeJson(packagePath, { "pi-subagents": { agents: [".pi/agents"] } });
}

function discoverProjectAgents(cwd: string, scope: "project" | "both" | "user" = "project") {
  ensureProjectAgentPackage(cwd);
  return upstreamDiscoverAgents(cwd, scope);
}

function discoverAllProjectAgents(cwd: string) {
  ensureProjectAgentPackage(cwd);
  const result = upstreamDiscoverAgentsAll(cwd);
  // The migrated fixtures intentionally model project-local definitions as a
  // project package so they stay on the supported discovery surface. Keep the
  // historical `project` assertions meaningful without hiding the source split.
  return { ...result, project: [...result.project, ...result.package] };
}

const discoverAgents = discoverProjectAgents;
const discoverAgentsAll = discoverAllProjectAgents;

function withTempHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-home-"));
  tempDirs.push(home);
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  const oldPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
  try {
    return fn(home);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    if (oldPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldPiCodingAgentDir;
    if (oldExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = oldExtraAgentDirs;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent permission frontmatter", () => {
  it("preserves nested permission YAML blocks through discovery", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-agent-permission-frontmatter-"),
    );
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      `---
name: worker
description: Worker
tools: bash,read,write
permission:
  "*": ask
  read: allow
  bash:
    "*": ask
    "git *": allow
---

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.equal(
      worker?.extraFields?.permission,
      `"*": ask
read: allow
bash:
  "*": ask
  "git *": allow`,
    );
  });
});

describe("agent frontmatter defaultContext", () => {
  it("parses defaultContext from discovered agent frontmatter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-default-context-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      `---
name: worker
description: Worker
defaultContext: fork
---

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.equal(worker?.defaultContext, "fork");
  });
});

describe("agent maxExecutionTimeMs frontmatter", () => {
  it("parses and validates maxExecutionTimeMs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-max-execution-time-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, ".pi", "agents", "explorer.md");
    writeAgent(
      filePath,
      `---
name: explorer
description: Explorer
maxExecutionTimeMs: ${Number.MAX_SAFE_INTEGER}
---

Explore the codebase
`,
    );

    const explorer = discoverAgents(dir, "project").agents.find(
      (agent) => agent.name === "explorer",
    );
    assert.equal(explorer?.maxExecutionTimeMs, Number.MAX_SAFE_INTEGER);
    assert.equal(explorer?.extraFields?.maxExecutionTimeMs, undefined);

    writeAgent(
      filePath,
      `---
name: explorer
description: Explorer
maxExecutionTimeMs: ${Number.MAX_SAFE_INTEGER + 1}
---

Explore the codebase
`,
    );
    const discovered = discoverAgentsAll(dir);
    assert.equal(
      discovered.project.some((agent) => agent.name === "explorer"),
      false,
      "malformed agent must be skipped",
    );
    const diagnostic = discovered.agentDiagnostics?.find((entry) => entry.filePath === filePath);
    assert.ok(diagnostic);
    assert.match(diagnostic.error, /maxExecutionTimeMs/);
  });
});

describe("agent acceptance-role frontmatter", () => {
  it("parses and validates acceptance roles", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-acceptance-role-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, ".pi", "agents", "explorer.md");
    writeAgent(
      filePath,
      `---
name: explorer
description: Explorer
acceptanceRole: read-only
---

Explore the codebase
`,
    );

    const explorer = discoverAgents(dir, "project").agents.find(
      (agent) => agent.name === "explorer",
    );
    assert.equal(explorer?.acceptanceRole, "read-only");
    assert.equal(explorer?.extraFields?.acceptanceRole, undefined);

    writeAgent(
      filePath,
      `---
name: explorer
description: Explorer
acceptanceRole: observer
---

Explore the codebase
`,
    );
    const discovered = discoverAgentsAll(dir);
    assert.equal(
      discovered.project.some((agent) => agent.name === "explorer"),
      false,
      "malformed agent must be skipped",
    );
    const diagnostic = discovered.agentDiagnostics?.find((entry) => entry.filePath === filePath);
    assert.ok(diagnostic);
    assert.match(diagnostic.error, /acceptanceRole/);
  });
});

describe("agent frontmatter malformed-file isolation", () => {
  it("skips malformed toolBudget while retaining valid peers and a diagnostic", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-tool-budget-invalid-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    writeAgent(
      path.join(agentsDir, "broken.md"),
      `---
name: broken
description: Broken
toolBudget: {not-json
---

Broken
`,
    );
    writeAgent(
      path.join(agentsDir, "valid.md"),
      `---
name: valid
description: Valid
---

Valid
`,
    );

    const result = discoverAgentsAll(dir);
    assert.ok(result.project.some((agent) => agent.name === "valid"));
    assert.equal(
      result.project.some((agent) => agent.name === "broken"),
      false,
    );
    const diagnostic = result.agentDiagnostics?.find((entry) =>
      entry.filePath.endsWith("broken.md"),
    );
    assert.ok(diagnostic);
    assert.match(diagnostic.error, /broken/);
    assert.match(diagnostic.error, /toolBudget/);
  });

  it("skips semantically invalid toolBudgets while retaining normalized valid peers", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-agent-tool-budget-semantic-invalid-"),
    );
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    const invalidBudgets: Array<{
      name: string;
      config: Record<string, unknown>;
      field: string;
    }> = [
      { name: "invalid-hard", config: { hard: 0 }, field: "hard" },
      { name: "invalid-soft", config: { soft: 5, hard: 4 }, field: "soft" },
      { name: "invalid-block", config: { hard: 4, block: [] }, field: "block" },
    ];
    for (const { name, config } of invalidBudgets) {
      writeAgent(
        path.join(agentsDir, `${name}.md`),
        `---
name: ${name}
description: Invalid ${name}
toolBudget: ${JSON.stringify(config)}
---

Invalid ${name}
`,
      );
    }
    writeAgent(
      path.join(agentsDir, "valid-normalized.md"),
      `---
name: valid-normalized
description: Valid normalized budget
toolBudget: ${JSON.stringify({ soft: 2, hard: 4, block: [" read ", "read", "write"] })}
---

Valid budget
`,
    );

    const result = discoverAgentsAll(dir);
    const valid = result.project.find((agent) => agent.name === "valid-normalized");
    assert.deepEqual(valid?.toolBudget, {
      soft: 2,
      hard: 4,
      block: ["read", "write"],
    });
    for (const { name, field } of invalidBudgets) {
      assert.equal(
        result.project.some((agent) => agent.name === name),
        false,
        `invalid ${name} agent must be skipped`,
      );
      const diagnostic = result.agentDiagnostics?.find((entry) =>
        entry.filePath.endsWith(`${name}.md`),
      );
      assert.ok(diagnostic);
      assert.match(diagnostic.error, new RegExp(`toolBudget\\.${field}`));
    }
  });

  it("silently skips README.md and empty frontmatter files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-no-frontmatter-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    writeAgent(
      path.join(agentsDir, "README.md"),
      "# Agent notes\n\nThis is not an agent definition.\n",
    );
    writeAgent(path.join(agentsDir, "empty.md"), "---\n---\n\nNotes only.\n");
    writeAgent(
      path.join(agentsDir, "valid.md"),
      "---\nname: valid\ndescription: Valid\n---\n\nValid\n",
    );

    const result = discoverAgentsAll(dir);
    assert.ok(result.project.some((agent) => agent.name === "valid"));
    assert.equal(
      result.agentDiagnostics?.some((entry) => entry.filePath.endsWith("README.md")),
      false,
    );
    assert.equal(
      result.agentDiagnostics?.some((entry) => entry.filePath.endsWith("empty.md")),
      false,
    );
  });

  it("aggregates missing required fields into one per-file diagnostic", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-missing-fields-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, ".pi", "agents", "candidate.md");
    writeAgent(
      filePath,
      "---\nmodel: mock/candidate\n---\n\nThis looks like an agent but is incomplete.\n",
    );

    const result = discoverAgentsAll(dir);
    assert.equal(
      result.project.some((agent) => agent.filePath === filePath),
      false,
    );
    const diagnostics =
      result.agentDiagnostics?.filter((entry) => entry.filePath === filePath) ?? [];
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]?.error ?? "", /name/);
    assert.match(diagnostics[0]?.error ?? "", /description/);
  });
});

describe("saved-chain non-discovery", () => {
  it("does not discover saved chain files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-chain-format-precedence-"));
    tempDirs.push(dir);
    const chainsDir = path.join(dir, ".pi", "chains");
    fs.mkdirSync(chainsDir, { recursive: true });
    fs.writeFileSync(
      path.join(chainsDir, "dynamic-review.chain.md"),
      `---
name: dynamic-review
description: Markdown fallback
---

## scout

Run the markdown chain
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(chainsDir, "dynamic-review.chain.json"),
      JSON.stringify({
        name: "dynamic-review",
        description: "JSON dynamic chain",
        chain: [
          {
            agent: "scout",
            task: "Return targets",
            as: "targets",
            outputSchema: { type: "object" },
          },
          {
            expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
            parallel: { agent: "reviewer", task: "Review {item.path}" },
            collect: { as: "reviews" },
          },
        ],
      }),
      "utf-8",
    );

    const result = discoverAgentsAll(dir);
    assert.deepEqual(result.chains, []);
    assert.deepEqual(result.chainDiagnostics, []);
  });
});

describe("configured agent directories", () => {
  it("ignores configured agent dirs and settings overrides after the hard cutover", () =>
    withTempHome(() => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "pi-subagents-project-configured-agent-dirs-"),
      );
      tempDirs.push(dir);
      const nested = path.join(dir, "src", "feature");
      fs.mkdirSync(nested, { recursive: true });
      writeJson(path.join(dir, ".pi", "settings.json"), {
        subagents: {
          agentDirs: ["vendor/subagents"],
          agentOverrides: { "embedded.configured-only": { model: "override/model" } },
        },
      });
      writeAgent(
        path.join(dir, "vendor", "subagents", "configured-only.md"),
        `---
name: configured-only
description: Configured only agent
package: embedded
---

Configured only.
`,
      );
      writeAgent(
        path.join(dir, ".pi", "agents", "shared.md"),
        `---
name: shared
description: Project shared agent
---

Project shared.
`,
      );
      const profile = trustRoot(dir);
      const customPath = writeRootCustomAgent(dir, "CONFIGURED-ONLY.md", "configured-only");
      const projectAgents = upstreamDiscoverAgents(nested, "project").agents;
      assert.equal(
        projectAgents.find((agent) => agent.name === "embedded.configured-only")?.filePath,
        fs.realpathSync(customPath),
      );
      assert.equal(
        projectAgents.find((agent) => agent.name === "shared"),
        undefined,
      );
      assert.equal(
        projectAgents.find((agent) => agent.name === "embedded.configured-only")?.model,
        undefined,
      );
      assert.equal(
        upstreamDiscoverAgentsAll(nested).project.find((agent) => agent.name === "shared"),
        undefined,
      );
      assert.equal(process.env.PI_CODING_AGENT_DIR, profile);
    }));
});

describe("package-provided agent discovery", () => {
  it("discovers package agents while ignoring package chain declarations", () =>
    withTempHome(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-discovery-"));
      tempDirs.push(dir);
      const workflowRoot = path.join(dir, ".pi", "npm", "node_modules", "my-pi-workflow");
      const chainsRoot = path.join(dir, ".pi", "npm", "node_modules", "@scope", "chain-workflow");
      writeJson(path.join(workflowRoot, "package.json"), {
        name: "my-pi-workflow",
        "pi-subagents": {
          agents: ["./agents"],
        },
      });
      writeAgent(
        path.join(workflowRoot, "agents", "reviewer.md"),
        `---
name: reviewer
package: my-workflow
description: Review changes for this workflow.
---

Review the workflow.
`,
      );
      writeJson(path.join(chainsRoot, "package.json"), {
        name: "@scope/chain-workflow",
        pi: {
          subagents: {
            chains: ["./chains"],
          },
        },
      });
      writeAgent(
        path.join(chainsRoot, "chains", "review.chain.md"),
        `---
name: review
package: my-workflow
description: Run workflow review.
---

## my-workflow.reviewer

Review the task.
`,
      );

      const all = discoverAgentsAll(dir);
      const packagedAgent = all.package.find((agent) => agent.name === "my-workflow.reviewer");
      assert.ok(packagedAgent);
      assert.equal(packagedAgent.source, "package");
      assert.equal(packagedAgent.filePath, path.join(workflowRoot, "agents", "reviewer.md"));
      assert.equal(
        discoverAgents(dir, "both").agents.find((agent) => agent.name === "my-workflow.reviewer")
          ?.source,
        "package",
      );

      assert.deepEqual(all.chains, []);
    }));

  it("loads packages referenced from Pi settings", () =>
    withTempHome(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-package-"));
      tempDirs.push(dir);
      const packageRoot = path.join(dir, ".pi", "vendor", "workflow");
      writeJson(path.join(dir, ".pi", "settings.json"), {
        packages: [{ source: "file:./vendor/workflow" }],
      });
      writeJson(path.join(packageRoot, "package.json"), {
        name: "settings-workflow",
        pi: {
          subagents: {
            agents: ["./agents"],
          },
        },
      });
      writeAgent(
        path.join(packageRoot, "agents", "planner.md"),
        `---
name: planner
package: settings-workflow
description: Plan from a settings-installed package.
---

Plan the work.
`,
      );

      const agent = discoverAgents(dir, "both").agents.find(
        (candidate) => candidate.name === "settings-workflow.planner",
      );
      assert.ok(agent);
      assert.equal(agent.source, "package");
    }));

  it("discovers project package agents when cwd is nested below the project root", () =>
    withTempHome(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-nested-package-discovery-"));
      tempDirs.push(dir);
      const nested = path.join(dir, "packages", "app", "src");
      const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "nested-workflow");
      fs.mkdirSync(nested, { recursive: true });
      writeJson(path.join(packageRoot, "package.json"), {
        name: "nested-workflow",
        "pi-subagents": {
          agents: ["./agents"],
        },
      });
      writeAgent(
        path.join(packageRoot, "agents", "reviewer.md"),
        `---
name: reviewer
package: nested-workflow
description: Review from a project package.
---

Review nested project work.
`,
      );

      const agent = discoverAgents(nested, "both").agents.find(
        (candidate) => candidate.name === "nested-workflow.reviewer",
      );
      assert.ok(agent);
      assert.equal(agent.source, "package");
      assert.equal(agent.filePath, path.join(packageRoot, "agents", "reviewer.md"));
    }));

  it("discovers package-provided agents from the nearest declaring package root without discovering saved chains", () =>
    withTempHome((home) => {
      const dir = path.join(home, "workspace");
      tempDirs.push(dir);
      const nested = path.join(dir, "src", "feature");
      fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
      fs.mkdirSync(nested, { recursive: true });
      writeJson(path.join(dir, "package.json"), {
        "pi-subagents": {
          agents: ["package-agents"],
        },
        pi: {
          subagents: {
            chains: ["package-chains"],
          },
        },
      });
      writeAgent(
        path.join(dir, "package-agents", "nested-package-agent.md"),
        `---
name: nested-package-agent
description: Nested package agent
---

Nested package prompt.
`,
      );
      writeAgent(
        path.join(dir, "package-chains", "nested-package-chain.chain.md"),
        `---
name: nested-package-chain
description: Nested package chain
---

## nested-package-agent

Review nested package.
`,
      );

      const all = discoverAgentsAll(nested);
      assert.equal(all.projectDir, null);
      assert.equal(all.projectSettingsPath, null);
      assert.equal(
        all.package.find((agent) => agent.name === "nested-package-agent")?.filePath,
        path.join(dir, "package-agents", "nested-package-agent.md"),
      );
      assert.deepEqual(all.chains, []);
      assert.equal(
        discoverAgents(nested, "both").agents.find((agent) => agent.name === "nested-package-agent")
          ?.source,
        "package",
      );
    }));

  it("ignores the default-profile ~/.agents marker so nested package manifests under HOME still drive package discovery", () =>
    withTempHome((home) => {
      const dir = path.join(home, "workspace");
      tempDirs.push(dir);
      const nested = path.join(dir, "src", "feature");
      fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
      fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
      fs.mkdirSync(nested, { recursive: true });
      writeJson(path.join(dir, "package.json"), {
        "pi-subagents": {
          agents: ["package-agents"],
        },
        pi: {
          subagents: {
            chains: ["package-chains"],
          },
        },
      });
      writeAgent(
        path.join(dir, "package-agents", "home-package-agent.md"),
        `---
name: home-package-agent
description: Home package agent
---

Home package prompt.
`,
      );
      writeAgent(
        path.join(dir, "package-chains", "home-package-chain.chain.md"),
        `---
name: home-package-chain
description: Home package chain
---

## home-package-agent

Review nested HOME package.
`,
      );

      const all = discoverAgentsAll(nested);
      assert.equal(all.projectDir, null);
      assert.equal(all.projectSettingsPath, null);
      assert.equal(
        all.package.find((agent) => agent.name === "home-package-agent")?.filePath,
        path.join(dir, "package-agents", "home-package-agent.md"),
      );
      assert.deepEqual(all.chains, []);
      assert.equal(
        discoverAgents(nested, "both").agents.find((agent) => agent.name === "home-package-agent")
          ?.source,
        "package",
      );
    }));

  it("ignores the default-profile ~/.pi marker when PI_CODING_AGENT_DIR points at a custom profile", () =>
    withTempHome((home) => {
      const dir = path.join(home, "workspace");
      tempDirs.push(dir);
      const nested = path.join(dir, "src", "feature");
      process.env.PI_CODING_AGENT_DIR = path.join(home, "profiles", "custom", "agent");
      fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
      fs.mkdirSync(nested, { recursive: true });
      writeJson(path.join(dir, "package.json"), {
        "pi-subagents": {
          agents: ["package-agents"],
        },
        pi: {
          subagents: {
            chains: ["package-chains"],
          },
        },
      });
      writeAgent(
        path.join(dir, "package-agents", "custom-profile-package-agent.md"),
        `---
name: custom-profile-package-agent
description: Custom profile package agent
---

Custom profile package prompt.
`,
      );
      writeAgent(
        path.join(dir, "package-chains", "custom-profile-package-chain.chain.md"),
        `---
name: custom-profile-package-chain
description: Custom profile package chain
---

## custom-profile-package-agent

Review custom profile package.
`,
      );

      const all = discoverAgentsAll(nested);
      assert.equal(all.projectDir, null);
      assert.equal(all.projectSettingsPath, null);
      assert.equal(
        all.package.find((agent) => agent.name === "custom-profile-package-agent")?.filePath,
        path.join(dir, "package-agents", "custom-profile-package-agent.md"),
      );
      assert.deepEqual(all.chains, []);
      assert.equal(
        discoverAgents(nested, "both").agents.find(
          (agent) => agent.name === "custom-profile-package-agent",
        )?.source,
        "package",
      );
    }));

  it("keeps .pi/.agents project markers ahead of nearer package manifests", () =>
    withTempHome(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-marker-precedence-"));
      tempDirs.push(dir);
      const nestedPackageRoot = path.join(dir, "packages", "app");
      const nested = path.join(nestedPackageRoot, "src", "feature");
      fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
      fs.mkdirSync(nested, { recursive: true });
      writeJson(path.join(dir, "package.json"), {
        "pi-subagents": {
          agents: ["root-package-agents"],
          chains: ["root-package-chains"],
        },
      });
      writeAgent(
        path.join(dir, "root-package-agents", "root-package-agent.md"),
        `---
name: root-package-agent
description: Root package agent
---

Root package prompt.
`,
      );
      writeAgent(
        path.join(dir, "root-package-chains", "root-package-chain.chain.md"),
        `---
name: root-package-chain
description: Root package chain
---

## root-package-agent

Review root package.
`,
      );
      writeJson(path.join(nestedPackageRoot, "package.json"), {
        pi: {
          subagents: {
            agents: ["nested-package-agents"],
            chains: ["nested-package-chains"],
          },
        },
      });
      writeAgent(
        path.join(nestedPackageRoot, "nested-package-agents", "nested-package-agent.md"),
        `---
name: nested-package-agent
description: Nested package agent
---

Nested package prompt.
`,
      );
      writeAgent(
        path.join(nestedPackageRoot, "nested-package-chains", "nested-package-chain.chain.md"),
        `---
name: nested-package-chain
description: Nested package chain
---

## nested-package-agent

Review nested package.
`,
      );

      const all = discoverAgentsAll(nested);
      assert.equal(all.projectDir, path.join(dir, ".pi", "agents"));
      assert.equal(
        all.package.find((agent) => agent.name === "root-package-agent")?.filePath,
        path.join(dir, "root-package-agents", "root-package-agent.md"),
      );
      assert.equal(
        all.package.some((agent) => agent.name === "nested-package-agent"),
        false,
      );
      assert.deepEqual(all.chains, []);
    }));

  it("does not register legacy skill files from broad package agent roots", () =>
    withTempHome(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-broad-package-skills-"));
      tempDirs.push(dir);
      const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "broad-workflow");
      writeJson(path.join(packageRoot, "package.json"), {
        name: "broad-workflow",
        "pi-subagents": {
          agents: ["."],
        },
      });
      writeAgent(
        path.join(packageRoot, "agent.md"),
        `---
name: package-agent
description: Package agent
---

Package prompt
`,
      );
      writeAgent(
        path.join(packageRoot, ".agents", "skills", "package-skill", "SKILL.md"),
        `---
name: package-skill
description: Package skill
---

Skill prompt
`,
      );
      writeAgent(
        path.join(packageRoot, "agents", "SKILL.md"),
        `---
name: skill-named-package-agent
description: Skill-named package agent
---

Agent prompt
`,
      );

      const packageAgents = discoverAgentsAll(dir).package;
      assert.ok(
        packageAgents.find(
          (agent) =>
            agent.name === "package-agent" && agent.filePath === path.join(packageRoot, "agent.md"),
        ),
      );
      assert.ok(
        packageAgents.find(
          (agent) =>
            agent.name === "skill-named-package-agent" &&
            agent.filePath === path.join(packageRoot, "agents", "SKILL.md"),
        ),
      );
      assert.equal(
        packageAgents.some((agent) =>
          agent.filePath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`),
        ),
        false,
      );
      assert.equal(
        packageAgents.some((agent) => agent.name === "package-skill"),
        false,
      );
    }));

  it("keeps package definitions while ignoring removed user and project overrides", () =>
    withTempHome((home) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-precedence-"));
      tempDirs.push(dir);
      const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "override-workflow");
      writeJson(path.join(packageRoot, "package.json"), {
        name: "override-workflow",
        "pi-subagents": {
          agents: ["./agents"],
          chains: ["./chains"],
        },
      });
      writeAgent(
        path.join(packageRoot, "agents", "scout.md"),
        `---
name: scout
description: Package scout
---

Package scout.
`,
      );
      writeAgent(
        path.join(packageRoot, "chains", "shared.chain.md"),
        `---
name: shared
description: Package chain
---

## scout

Package chain.
`,
      );
      writeAgent(
        path.join(home, ".pi", "agent", "agents", "scout.md"),
        `---
name: scout
description: User scout
---

User scout.
`,
      );
      writeAgent(
        path.join(dir, ".pi", "agents", "scout.md"),
        `---
name: scout
description: Project scout
---

Project scout.
`,
      );
      writeAgent(
        path.join(home, ".pi", "agent", "chains", "shared.chain.md"),
        `---
name: shared
description: User chain
---

## scout

User chain.
`,
      );
      writeAgent(
        path.join(dir, ".pi", "chains", "shared.chain.md"),
        `---
name: shared
description: Project chain
---

## scout

Project chain.
`,
      );

      const userScoped = upstreamDiscoverAgents(dir, "user").agents.find(
        (agent) => agent.name === "scout",
      );
      assert.equal(userScoped, undefined);
      const projectScoped = upstreamDiscoverAgents(dir, "project").agents.find(
        (agent) => agent.name === "scout",
      );
      assert.equal(projectScoped?.source, "package");
      assert.equal(projectScoped?.description, "Package scout");
      assert.deepEqual(discoverAgentsAll(dir).chains, []);
    }));
});

describe("agent frontmatter tools policy", () => {
  it("distinguishes omitted, explicit-empty, MCP-only, and named declarations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-tools-policy-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");

    writeAgent(
      path.join(agentsDir, "omitted.md"),
      `---
name: omitted
description: Omitted tools
---

No tools field.
`,
    );
    writeAgent(
      path.join(agentsDir, "empty.md"),
      `---
name: empty
description: Explicit empty tools
tools:
---

Empty tools field.
`,
    );
    writeAgent(
      path.join(agentsDir, "mcp-only.md"),
      `---
name: mcp-only
description: MCP-only tools
tools: mcp:server/lookup, mcp:other/search
---

MCP-only tools field.
`,
    );
    writeAgent(
      path.join(agentsDir, "named.md"),
      `---
name: named
description: Named tools
tools: read, bash, mcp:server/lookup
---

Named tools field.
`,
    );

    const agents = discoverAgents(dir, "project").agents;
    assert.equal(agents.find((agent) => agent.name === "omitted")?.tools, undefined);
    assert.equal(agents.find((agent) => agent.name === "empty")?.tools, null);
    assert.equal(agents.find((agent) => agent.name === "mcp-only")?.tools, null);
    assert.deepEqual(agents.find((agent) => agent.name === "named")?.tools, ["read", "bash"]);
  });
});

describe("agent frontmatter completionGuard", () => {
  it("parses completionGuard from discovered agent frontmatter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-completion-guard-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "test-runner.md"),
      `---
name: test-runner
description: Test runner
completionGuard: false
---

Validate changes
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const runner = result.agents.find((agent) => agent.name === "test-runner");
    assert.equal(runner?.completionGuard, false);
    assert.equal(runner?.extraFields?.completionGuard, undefined);
  });
});

describe("agent frontmatter maxSubagentDepth", () => {
  it("parses maxSubagentDepth from discovered agent frontmatter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-frontmatter-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "scout.md"),
      `---
name: scout
description: Scout
maxSubagentDepth: 1
---

Inspect code
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const scout = result.agents.find((agent) => agent.name === "scout");
    assert.equal(scout?.maxSubagentDepth, 1);
  });
});

describe("agent frontmatter thinking", () => {
  it("coerces frontmatter false strings to disabled thinking", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-thinking-false-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    for (const [name, value] of [
      ["unquoted", "false"],
      ["quoted", '"false"'],
    ] as const) {
      fs.writeFileSync(
        path.join(agentsDir, `${name}.md`),
        `---
name: ${name}
description: ${name}
model: glm-5.2-short-fast
thinking: ${value}
---

Do work
`,
        "utf-8",
      );
    }

    const agents = discoverAgents(dir, "project").agents;
    for (const name of ["unquoted", "quoted"]) {
      const agent = agents.find((candidate) => candidate.name === name);
      assert.ok(agent);
      assert.equal(agent.thinking, false);

      const { args } = buildPiArgs({
        baseArgs: ["-p"],
        task: "hello",
        sessionEnabled: false,
        model: agent.model,
        thinking: agent.thinking,
        inheritProjectContext: agent.inheritProjectContext,
        inheritSkills: agent.inheritSkills,
      });

      assert.ok(args.includes("--model"));
      assert.ok(args.includes("glm-5.2-short-fast"));
      assert.ok(!args.some((arg) => arg.includes(":false")));
    }
  });

  it("preserves supported frontmatter thinking strings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-thinking-levels-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    for (const level of THINKING_LEVELS) {
      fs.writeFileSync(
        path.join(agentsDir, `${level}.md`),
        `---
name: thinker-${level}
description: Thinking ${level}
thinking: ${level}
---

Do work
`,
        "utf-8",
      );
    }

    const agents = discoverAgents(dir, "project").agents;
    for (const level of THINKING_LEVELS) {
      const agent = agents.find((candidate) => candidate.name === `thinker-${level}`);
      assert.ok(agent);
      assert.equal(agent.thinking, level);
    }
  });
});

describe("agent frontmatter fallbackModels", () => {
  it("parses fallbackModels from discovered agent frontmatter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-fallback-frontmatter-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      `---
name: worker
description: Worker
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
---

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.deepEqual(worker?.fallbackModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
  });
});

describe("agent frontmatter systemPromptMode", () => {
  it("parses systemPromptMode from discovered agent frontmatter", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-agent-prompt-mode-frontmatter-"),
    );
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      `---
name: worker
description: Worker
systemPromptMode: replace
---

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.equal(worker?.systemPromptMode, "replace");
  });
});

describe("agent frontmatter prompt inheritance flags", () => {
  it("parses inheritProjectContext and inheritSkills from discovered agent frontmatter", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-agent-prompt-inheritance-frontmatter-"),
    );
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      `---
name: worker
description: Worker
inheritProjectContext: true
inheritSkills: true
---

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.equal(worker?.inheritProjectContext, true);
    assert.equal(worker?.inheritSkills, true);
  });
});

describe("agent frontmatter subagentOnlyExtensions", () => {
  it("parses subagentOnlyExtensions from discovered agent frontmatter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-child-ext-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      `---
name: worker
description: Worker
subagentOnlyExtensions: ./tools/child-search.ts, /opt/pi/child-only.ts
---

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.deepEqual(worker?.subagentOnlyExtensions, [
      "./tools/child-search.ts",
      "/opt/pi/child-only.ts",
    ]);
  });
});

describe("agent frontmatter prompt assembly defaults", () => {
  it("defaults ordinary agents to replace mode with no inherited context or skills", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-agent-default-prompt-settings-"),
    );
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      `---
name: worker
description: Worker
---

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const worker = result.agents.find((agent) => agent.name === "worker");
    assert.equal(worker?.systemPromptMode, "replace");
    assert.equal(worker?.inheritProjectContext, false);
    assert.equal(worker?.inheritSkills, false);
  });

  it("defaults delegate to append mode with inherited project context", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-agent-delegate-default-prompt-settings-"),
    );
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "delegate.md"),
      `---
name: delegate
description: Delegate
---

Do work
`,
      "utf-8",
    );

    const result = discoverAgents(dir, "project");
    const delegate = result.agents.find((agent) => agent.name === "delegate");
    assert.equal(delegate?.systemPromptMode, "append");
    assert.equal(delegate?.inheritProjectContext, true);
    assert.equal(delegate?.inheritSkills, false);
  });
});

describe("packaged agent discovery", () => {
  it("recursively discovers nested project agents without discovering saved chain files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-recursive-agent-discovery-"));
    tempDirs.push(dir);
    const nestedDir = path.join(dir, ".pi", "agents", "code-analysis", "deep");
    const nestedChainDir = path.join(dir, ".pi", "chains", "code-analysis", "deep");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(nestedChainDir, { recursive: true });
    fs.writeFileSync(
      path.join(nestedDir, "scout.md"),
      `---
name: scout
description: Nested scout
---

Inspect code
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(nestedChainDir, "review.chain.md"),
      `---
name: review-flow
description: Review flow
---

## scout

Review
`,
      "utf-8",
    );

    const result = discoverAgentsAll(dir);
    assert.ok(
      result.project.find(
        (agent) => agent.name === "scout" && agent.filePath === path.join(nestedDir, "scout.md"),
      ),
    );
    assert.deepEqual(result.chains, []);
    assert.equal(
      result.project.some((agent) => agent.filePath.endsWith("review.chain.md")),
      false,
    );
  });

  it("registers packaged agents by runtime name and preserves local name plus package", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-agent-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "scout.md"),
      `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect code
`,
      "utf-8",
    );

    const scout = discoverAgents(dir, "project").agents.find(
      (agent) => agent.name === "code-analysis.scout",
    );
    assert.ok(scout);
    assert.equal(scout.localName, "scout");
    assert.equal(scout.packageName, "code-analysis");
  });

  it("keeps packaged and un-packaged runtime names distinct while preserving un-packaged precedence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-collisions-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".agents", "scout.md"),
      `---
name: scout
description: Legacy scout
---

Legacy
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "scout.md"),
      `---
name: scout
description: Project scout
---

Project
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "packaged.md"),
      `---
name: scout
package: code-analysis
description: Packaged scout
---

Packaged
`,
      "utf-8",
    );

    const agents = discoverAgents(dir, "project").agents;
    const unqualified = agents.find((agent) => agent.name === "scout");
    const packaged = agents.find((agent) => agent.name === "code-analysis.scout");
    assert.equal(unqualified?.description, "Project scout");
    assert.equal(unqualified?.filePath, path.join(dir, ".pi", "agents", "scout.md"));
    assert.equal(packaged?.description, "Packaged scout");
  });

  it("normalizes package frontmatter for discovered agents while ignoring saved chains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-normalize-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    const chainsDir = path.join(dir, ".pi", "chains");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(chainsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "scout.md"),
      `---
name: scout
package: Code Analysis!
description: Fast recon
---

Inspect
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(chainsDir, "review.chain.md"),
      `---
name: review-flow
package: Code Analysis!
description: Review flow
---

## code-analysis.scout

Review
`,
      "utf-8",
    );

    const result = discoverAgentsAll(dir);
    assert.ok(result.project.find((agent) => agent.name === "code-analysis.scout"));
    assert.deepEqual(result.chains, []);
  });

  it("skips invalid package frontmatter that cannot be normalized", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-invalid-package-"));
    tempDirs.push(dir);
    const agentsDir = path.join(dir, ".pi", "agents");
    const chainsDir = path.join(dir, ".pi", "chains");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(chainsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "scout.md"),
      `---
name: scout
package: !!!
description: Fast recon
---

Inspect
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(chainsDir, "review.chain.md"),
      `---
name: review-flow
package: !!!
description: Review flow
---

## scout

Review
`,
      "utf-8",
    );

    const result = discoverAgentsAll(dir);
    assert.equal(
      result.project.some((agent) => agent.filePath.endsWith("scout.md")),
      false,
    );
    assert.equal(
      result.chains.some((chain) => chain.filePath.endsWith("review.chain.md")),
      false,
    );
    const diagnostic = result.agentDiagnostics?.find((entry) =>
      entry.filePath.endsWith("scout.md"),
    );
    assert.ok(diagnostic);
    assert.match(diagnostic.error, /package/);
  });
});

describe("project agent directory discovery", () => {
  it("uses only the trusted Git-root custom directory and ignores generic project trees", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-dirs-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".agents", "legacy.md"),
      `---\nname: legacy\ndescription: Legacy\n---\n\nLegacy prompt\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "canonical.md"),
      `---\nname: canonical\ndescription: Canonical\n---\n\nCanonical prompt\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "SKILL.md"),
      `---\nname: skill-named-agent\ndescription: Skill-named agent\n---\n\nSkill-named agent prompt\n`,
      "utf-8",
    );
    const profile = trustRoot(dir);
    const customPath = writeRootCustomAgent(dir, "CANONICAL.md", "canonical");

    const result = upstreamDiscoverAgents(dir, "project");
    const custom = result.agents.find((agent) => agent.name === "embedded.canonical");
    assert.ok(custom);
    assert.equal(custom?.filePath, fs.realpathSync(customPath));
    assert.equal(custom?.source, "project");
    assert.equal(
      result.agents.some((agent) =>
        ["legacy", "canonical", "skill-named-agent"].includes(agent.name),
      ),
      false,
    );
    assert.equal(process.env.PI_CODING_AGENT_DIR, profile);
  });

  it("keeps generic project skill trees out of agent discovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-skills-not-agents-"));
    tempDirs.push(dir);
    writeAgent(
      path.join(dir, ".agents", "legacy.md"),
      `---\nname: legacy\ndescription: Legacy\n---\n\nLegacy prompt\n`,
    );
    writeAgent(
      path.join(dir, ".agents", "skills", "directory-skill", "SKILL.md"),
      `---\nname: directory-skill\ndescription: Directory skill\n---\n\nSkill prompt\n`,
    );
    writeAgent(
      path.join(dir, ".agents", "skills", "file-skill.md"),
      `---\nname: file-skill\ndescription: Skill prompt\n---\n\nSkill prompt\n`,
    );
    trustRoot(dir);
    const customPath = writeRootCustomAgent(dir, "LEGACY.md", "legacy");

    const agents = upstreamDiscoverAgents(dir, "project").agents;
    assert.equal(
      agents.find((agent) => agent.name === "embedded.legacy")?.filePath,
      fs.realpathSync(customPath),
    );
    assert.equal(
      agents.some((agent) =>
        agent.filePath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`),
      ),
      false,
    );
    assert.equal(
      agents.some((agent) => agent.name === "legacy"),
      false,
    );
    assert.equal(
      agents.some((agent) => agent.name === "directory-skill"),
      false,
    );
    assert.equal(
      agents.some((agent) => agent.name === "file-skill"),
      false,
    );
  });

  it("does not register generic user SKILL.md files as agents", () =>
    withTempHome((home) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-user-skills-not-agents-"));
      tempDirs.push(dir);
      writeAgent(
        path.join(home, ".agents", "user-agent.md"),
        `---\nname: user-agent\ndescription: User agent\n---\n\nUser prompt\n`,
      );
      writeAgent(
        path.join(home, ".agents", "skills", "user-skill", "SKILL.md"),
        `---\nname: user-skill\ndescription: User skill\n---\n\nSkill prompt\n`,
      );
      const canonical = path.join(
        home,
        ".pi",
        "agent",
        "tlh",
        "agents",
        "subagents",
        "developer.md",
      );
      writeAgent(
        canonical,
        `---\nname: developer\ndescription: TLH developer\n---\n\nDeveloper prompt\n`,
      );
      process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");

      const agents = discoverAgents(dir, "user").agents;
      assert.equal(agents.find((agent) => agent.name === "developer")?.filePath, canonical);
      assert.equal(
        agents.some((agent) => agent.name === "user-agent"),
        false,
      );
      assert.equal(
        agents.some((agent) =>
          agent.filePath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`),
        ),
        false,
      );
      assert.equal(
        agents.some((agent) => agent.name === "user-skill"),
        false,
      );
    }));

  it("uses the exact root custom file when generic project trees collide", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-collision-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".agents", "shared.md"),
      `---\nname: shared\ndescription: Legacy shared\n---\n\nLegacy prompt\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "shared.md"),
      `---\nname: shared\ndescription: Generic shared\n---\n\nGeneric prompt\n`,
      "utf-8",
    );
    trustRoot(dir);
    const customPath = writeRootCustomAgent(dir, "SHARED.md", "shared", "Canonical prompt");

    const shared = upstreamDiscoverAgents(dir, "project").agents.find(
      (agent) => agent.name === "embedded.shared",
    );
    assert.ok(shared);
    assert.equal(shared.filePath, fs.realpathSync(customPath));
    assert.equal(shared.description, "shared custom");
    assert.equal(shared.systemPrompt.trim(), "Canonical prompt");
  });

  it("uses the project root for the canonical project agent dir even when only .agents exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-root-"));
    tempDirs.push(dir);
    const nested = path.join(dir, "packages", "app");
    fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    const result = discoverAgentsAll(nested);
    assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
  });

  it("does not discover project chains from .pi/chains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-dirs-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".pi", "chains", "flows"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "agents", "ignored.chain.md"),
      `---
name: ignored-chain
description: Ignored chain
---

## scout

Ignore
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, ".pi", "chains", "flows", "canonical.chain.md"),
      `---
name: canonical-chain
description: Canonical chain
---

## worker

Inspect canonical
`,
      "utf-8",
    );

    const result = discoverAgentsAll(dir);
    assert.deepEqual(result.chains, []);
    assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
    assert.equal(result.projectChainDir, path.join(dir, ".pi", "chains"));
  });

  it("does not discover user or project chains on name collisions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-collision-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-user-chain-home-"));
    tempDirs.push(dir, home);
    const oldHome = process.env.HOME;
    const oldUserProfile = process.env.USERPROFILE;
    const oldPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    const oldExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    try {
      const userChainsDir = path.join(home, ".pi", "agent", "chains");
      fs.mkdirSync(userChainsDir, { recursive: true });
      fs.mkdirSync(path.join(dir, ".pi", "chains"), { recursive: true });
      fs.writeFileSync(
        path.join(userChainsDir, "shared.chain.md"),
        `---
name: shared-chain
description: User chain
---

## scout

Inspect user
`,
        "utf-8",
      );
      fs.writeFileSync(
        path.join(dir, ".pi", "chains", "shared.chain.md"),
        `---
name: shared-chain
description: Project chain
---

## worker

Inspect project
`,
        "utf-8",
      );

      assert.deepEqual(discoverAgentsAll(dir).chains, []);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldPiCodingAgentDir;
      if (oldExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
      else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = oldExtraAgentDirs;
    }
  });
});
