import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgentsWithProjectSnapshot } from "../../src/agents/agents.ts";
import {
  getProjectAgentSnapshotProvenance,
  ProjectAgentSnapshotCapabilityError,
  resolveProjectAgentSnapshot,
} from "../../src/agents/project-agent-snapshot.ts";
import {
  loadProjectAgentSnapshot,
  MAX_PROJECT_AGENT_DEPTH,
  PROJECT_AGENT_TRUST_UI_TIMEOUT_MS,
  parseProjectAgentDefinition,
  resolveCanonicalGitWorktreeRoot,
  resolveProjectAgentTrust,
  scanProjectAgentDefinitions,
  type ProjectAgentLoaderFileSystem,
  type ProjectAgentSnapshotLoadOptions,
} from "../../src/agents/project-agent-loader.ts";

const tempDirs: string[] = [];

function tempProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-agent-loader-"));
  tempDirs.push(project);
  return project;
}

function writeDefinition(
  projectRoot: string,
  relativePath: string,
  options: {
    name?: string;
    packageName?: string;
    description?: string;
    tools?: string;
    extraFrontmatter?: string;
    body?: string;
  } = {},
): string {
  const filePath = path.join(projectRoot, ".tlh", "agents", relativePath);
  const name = options.name ?? path.basename(relativePath, ".md");
  const content = [
    "---",
    `name: ${name}`,
    `package: ${options.packageName ?? "embedded"}`,
    `description: ${options.description ?? "Project agent"}`,
    `tools: ${options.tools ?? "read"}`,
    options.extraFrontmatter,
    "---",
    "",
    options.body ?? "Project prompt.",
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function trustedLoadOptions(
  projectRoot: string,
  overrides: Partial<ProjectAgentSnapshotLoadOptions> = {},
): ProjectAgentSnapshotLoadOptions {
  const canonicalRoot = fs.realpathSync(projectRoot);
  return {
    cwd: projectRoot,
    sessionId: "session-loader-test",
    generationId: "generation-loader-test",
    git: { showToplevel: () => projectRoot },
    trust: {
      trustStore: { getEntry: () => ({ path: canonicalRoot, decision: true }) },
      hasTrustRequiringProjectResources: () => false,
    },
    ...overrides,
  };
}

function fileSystemWithReadHook(
  hook: (filePath: string, value: Buffer) => Buffer,
): ProjectAgentLoaderFileSystem {
  return {
    lstatSync: (filePath) => fs.lstatSync(filePath),
    readdirSync: (filePath, options) => fs.readdirSync(filePath, options) as fs.Dirent[],
    realpathSync: (filePath) => fs.realpathSync(filePath),
    readFileSync: (filePath) => hook(filePath, fs.readFileSync(filePath)),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("trusted project-agent loader", () => {
  it("resolves the canonical Git worktree root and rejects an unverified path", () => {
    const project = tempProject();
    assert.equal(
      resolveCanonicalGitWorktreeRoot(path.join(project, "src"), {
        git: { showToplevel: () => project },
      }),
      fs.realpathSync(project),
    );
    assert.equal(
      resolveCanonicalGitWorktreeRoot(project, {
        git: { showToplevel: () => undefined },
      }),
      undefined,
    );
  });

  it("derives frontmatter fields and the digest from the exact definition bytes", () => {
    const project = tempProject();
    const filePath = writeDefinition(project, "nested/reviewer.md", {
      extraFrontmatter: "model: openai/reviewer\ncustomField: retained",
      body: "Review the repository.",
    });
    const bytes = fs.readFileSync(filePath);
    const entry = parseProjectAgentDefinition(filePath, bytes);

    assert.equal(entry.agent.name, "embedded.reviewer");
    assert.equal(entry.agent.localName, "reviewer");
    assert.equal(entry.agent.packageName, "embedded");
    assert.equal(entry.agent.source, "project");
    assert.deepEqual(entry.agent.tools, ["read"]);
    assert.equal(entry.agent.model, "openai/reviewer");
    assert.equal(entry.agent.extraFields?.customField, "retained");
    assert.deepEqual(entry.frontmatterFields, [
      "name",
      "package",
      "description",
      "tools",
      "model",
      "customField",
    ]);
    assert.equal(entry.digest, createHash("sha256").update(bytes).digest("hex"));
  });

  it("requires strict package, name, tools, and extension metadata", () => {
    const project = tempProject();
    const cases = [
      ["wrong-package.md", { packageName: "other" }, /package must exactly be 'embedded'/],
      ["wrong-name.md", { name: "different" }, /frontmatter name must exactly equal/],
      ["missing-tools.md", { tools: "" }, /tools must declare at least one usable tool/],
      [
        "extensions.md",
        { extraFrontmatter: "extensions: ./project-extension" },
        /extensions and subagentOnlyExtensions are prohibited/,
      ],
      [
        "only-mcp.md",
        { tools: "mcp:unsafe-project-tool" },
        /tools must declare at least one usable tool/,
      ],
      ["invalid-tool-name.md", { tools: "read,grep[]" }, /valid runtime tool name/],
      ["invalid-tool-prefix.md", { tools: "-read" }, /valid runtime tool name/],
      ["yaml-tool-block.md", { tools: "|\n  - read" }, /valid runtime tool name/],
      [
        "tool-budget-missing-hard.md",
        { extraFrontmatter: 'toolBudget: {"soft": 1}' },
        /toolBudget\.hard must be an integer >= 1/,
      ],
      [
        "tool-budget-invalid-soft.md",
        { extraFrontmatter: 'toolBudget: {"hard": 2, "soft": 0}' },
        /toolBudget\.soft must be an integer >= 1/,
      ],
      [
        "tool-budget-invalid-block.md",
        { extraFrontmatter: 'toolBudget: {"hard": 2, "block": ["read", 1]}' },
        /toolBudget\.block must contain non-empty tool names/,
      ],
      [
        "tool-budget-array.md",
        { extraFrontmatter: 'toolBudget: ["read"]' },
        /toolBudget must be an object/,
      ],
    ] as const;

    for (const [relativePath, options, expected] of cases) {
      const filePath = writeDefinition(project, relativePath, options);
      assert.throws(
        () => parseProjectAgentDefinition(filePath, fs.readFileSync(filePath)),
        expected,
      );
    }

    const malformedDelimiter = writeDefinition(project, "malformed-delimiter.md");
    fs.writeFileSync(
      malformedDelimiter,
      fs.readFileSync(malformedDelimiter, "utf8").replace("\n---\n", "\n----\n"),
      "utf8",
    );
    assert.throws(
      () => parseProjectAgentDefinition(malformedDelimiter, fs.readFileSync(malformedDelimiter)),
      /frontmatter closing delimiter is invalid/,
    );

    const validBudget = writeDefinition(project, "valid-tool-budget.md", {
      extraFrontmatter: 'toolBudget: {"hard": 2, "soft": 1, "block": ["read"]}',
      tools: "read,mcp:ignored",
    });
    const parsedBudget = parseProjectAgentDefinition(validBudget, fs.readFileSync(validBudget));
    assert.deepEqual(parsedBudget.agent.tools, ["read"]);
    assert.deepEqual(parsedBudget.agent.toolBudget, {
      hard: 2,
      soft: 1,
      block: ["read"],
    });
  });

  it("does not read definition contents before trust and fails closed without UI", async () => {
    const project = tempProject();
    writeDefinition(project, "secret.md", { body: "must not be read" });
    let reads = 0;
    const fileSystem = fileSystemWithReadHook((_filePath, value) => {
      reads += 1;
      return value;
    });
    const result = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      fileSystem,
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        isProjectTrusted: () => true,
        hasUI: false,
      },
    });

    assert.equal(result.status, "denied");
    assert.equal(result.trust?.source, "session-unavailable");
    assert.equal(reads, 0);
  });

  it("honors a negative upstream trust signal even when no project-agent directory exists", async () => {
    const project = tempProject();
    const result = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        isProjectTrusted: () => false,
        hasUI: true,
        confirm: () => {
          throw new Error("must not ask after an upstream denial");
        },
      },
    });

    assert.equal(result.status, "denied");
    assert.equal(result.trust?.source, "explicit-negative");
  });

  it("fails closed when host trust dependencies are missing and does not read definitions", async () => {
    const project = tempProject();
    writeDefinition(project, "missing-dependencies.md", { body: "must not be read" });
    let reads = 0;
    const fileSystem = fileSystemWithReadHook((_filePath, value) => {
      reads += 1;
      return value;
    });
    const result = await loadProjectAgentSnapshot({
      cwd: project,
      sessionId: "missing-dependencies-session",
      generationId: "missing-dependencies-generation",
      git: { showToplevel: () => project },
      fileSystem,
      defaultProjectTrust: "always",
      context: { hasUI: false },
    });

    assert.equal(result.status, "unavailable");
    assert.match(result.diagnostics.join("\n"), /trust dependencies are unavailable/);
    assert.equal(reads, 0);
  });

  it("does not construct the injected trust store when no saved trust file exists", async () => {
    const project = tempProject();
    writeDefinition(project, "no-trust-file.md");
    const agentDir = path.join(project, "missing-agent-dir");
    let constructions = 0;
    const result = await loadProjectAgentSnapshot({
      cwd: project,
      sessionId: "no-trust-file-session",
      generationId: "no-trust-file-generation",
      agentDir,
      git: { showToplevel: () => project },
      defaultProjectTrust: "always",
      trustDependencies: {
        createProjectTrustStore: () => {
          constructions += 1;
          throw new Error("must not construct a store without trust.json");
        },
        hasTrustRequiringProjectResources: () => false,
      },
      context: { hasUI: false },
    });

    assert.equal(result.status, "loaded");
    assert.equal(constructions, 0);
    assert.equal(fs.existsSync(agentDir), false);
  });

  it("covers saved/default/upstream/session trust decisions without persisting interactive approval", async () => {
    const project = tempProject();
    const noResources = () => false;
    const saved = (decision: boolean, trustPath = project) => ({
      trustStore: { getEntry: () => ({ path: trustPath, decision }) },
      hasTrustRequiringProjectResources: noResources,
      hasUI: false,
    });

    assert.equal((await resolveProjectAgentTrust(project, saved(true))).source, "saved-positive");
    assert.equal((await resolveProjectAgentTrust(project, saved(false))).source, "saved-negative");
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          ...saved(false),
          trustOverride: true,
        })
      ).source,
      "saved-negative",
    );
    assert.equal(
      (await resolveProjectAgentTrust(project, saved(true, path.dirname(project)))).trusted,
      true,
    );
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          ...saved(false, path.dirname(project)),
          defaultProjectTrust: "always",
        })
      ).trusted,
      false,
    );
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: noResources,
          isProjectTrusted: () => true,
          defaultProjectTrust: "ask",
          hasUI: true,
          confirm: () => true,
        })
      ).source,
      "session-positive",
    );
    let noResourceFalsePrompts = 0;
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: noResources,
          isProjectTrusted: () => false,
          defaultProjectTrust: "ask",
          hasUI: true,
          confirm: () => {
            noResourceFalsePrompts += 1;
            return true;
          },
        })
      ).source,
      "explicit-negative",
    );
    assert.equal(noResourceFalsePrompts, 0);
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: () => true,
          isProjectTrusted: () => true,
          hasUI: false,
        })
      ).source,
      "upstream-positive",
    );
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: () => true,
          isProjectTrusted: () => false,
          hasUI: true,
          confirm: () => true,
        })
      ).source,
      "explicit-negative",
    );
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: noResources,
          defaultProjectTrust: "always",
          hasUI: false,
        })
      ).source,
      "default-always",
    );
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: noResources,
          defaultProjectTrust: "never",
          hasUI: true,
          confirm: () => true,
        })
      ).source,
      "default-never",
    );
    let prompts = 0;
    const sessionTrust = {
      trustStore: { getEntry: () => null },
      hasTrustRequiringProjectResources: noResources,
      sessionId: "session-cache",
      hasUI: true,
      confirm: () => {
        prompts += 1;
        return true;
      },
    };
    assert.equal(
      (await resolveProjectAgentTrust(project, sessionTrust)).source,
      "session-positive",
    );
    assert.equal(
      (await resolveProjectAgentTrust(project, { ...sessionTrust, hasUI: false })).trusted,
      true,
    );
    assert.equal(prompts, 1);

    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: noResources,
          hasUI: true,
          confirm: () => false,
        })
      ).source,
      "session-negative",
    );

    let dialogOptions: unknown;
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: noResources,
          sessionId: "trust-ui-options",
          hasUI: true,
          ui: {
            confirm: async (_title, _message, options) => {
              dialogOptions = options;
              return true;
            },
          },
        })
      ).source,
      "session-positive",
    );
    assert.deepEqual(dialogOptions, { timeout: PROJECT_AGENT_TRUST_UI_TIMEOUT_MS });

    const nonSettlingStarted = Date.now();
    const nonSettling = await resolveProjectAgentTrust(project, {
      trustStore: { getEntry: () => null },
      hasTrustRequiringProjectResources: noResources,
      sessionId: "trust-ui-timeout",
      hasUI: true,
      trustUiTimeoutMs: 10,
      ui: { confirm: () => new Promise(() => {}) },
    });
    assert.equal(nonSettling.source, "session-unavailable");
    assert.ok(Date.now() - nonSettlingStarted < 1000, "trust prompt timeout should be finite");

    let overridePrompts = 0;
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustOverride: true,
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: noResources,
          sessionId: "trust-override-prompt",
          hasUI: true,
          confirm: () => {
            overridePrompts += 1;
            return true;
          },
        })
      ).source,
      "session-positive",
    );
    assert.equal(overridePrompts, 1);
    assert.equal(
      (
        await resolveProjectAgentTrust(project, {
          trustOverride: true,
          trustStore: { getEntry: () => null },
          hasTrustRequiringProjectResources: noResources,
          sessionId: "trust-override-noninteractive",
          hasUI: false,
        })
      ).source,
      "session-unavailable",
    );
  });

  it("creates an empty generation when agents appear after the initial absence probe", async () => {
    const project = tempProject();
    const canonicalProject = fs.realpathSync(project);
    const agentsDirectory = path.join(project, ".tlh", "agents");
    let materialized = false;
    let reads = 0;
    let prompts = 0;
    const baseFileSystem = fileSystemWithReadHook((_filePath, value) => {
      reads += 1;
      return value;
    });
    const fileSystem: ProjectAgentLoaderFileSystem = {
      ...baseFileSystem,
      lstatSync: (filePath) => {
        if (filePath === path.join(canonicalProject, ".tlh") && !materialized) {
          materialized = true;
          writeDefinition(project, "appeared.md", { body: "appeared after probe" });
          const error = new Error("materialized after absence probe") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return fs.lstatSync(filePath);
      },
    };
    const options: ProjectAgentSnapshotLoadOptions = {
      cwd: project,
      sessionId: "absence-race-session",
      generationId: "absence-generation",
      git: { showToplevel: () => project },
      fileSystem,
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        hasUI: true,
        confirm: () => {
          prompts += 1;
          return true;
        },
      },
    };

    const first = await loadProjectAgentSnapshot(options);
    assert.equal(first.status, "loaded");
    assert.equal(first.trust?.source, "no-project-agents");
    assert.deepEqual(first.manifest?.entries, []);
    assert.equal(reads, 0);
    assert.equal(prompts, 0);

    const second = await loadProjectAgentSnapshot({
      ...options,
      generationId: "materialized-generation",
    });
    assert.equal(second.status, "loaded");
    assert.equal(second.trust?.source, "session-positive");
    assert.equal(prompts, 1);
    assert.deepEqual(
      second.manifest?.entries.map((entry) => entry.agent.name),
      ["embedded.appeared"],
    );
    assert.equal(fs.existsSync(agentsDirectory), true);
    assert.equal(reads > 0, true);
  });

  it("creates tombstones for malformed and duplicate same-name candidates", async () => {
    const project = tempProject();
    writeDefinition(project, "valid.md");
    writeDefinition(project, "malformed.md", { description: "" });
    writeDefinition(project, "nested/malformed.md");
    const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));

    assert.equal(result.status, "loaded");
    assert.deepEqual(
      result.manifest?.entries.map((entry) => entry.agent.name),
      ["embedded.valid"],
    );
    assert.deepEqual(result.manifest?.tombstones, ["embedded.malformed"]);
    assert.match(result.diagnostics.join("\n"), /Duplicate project-agent basename 'malformed'/);
  });

  it("treats a same-name directory as an invalid candidate tombstone", async () => {
    const project = tempProject();
    const directoryCandidate = path.join(project, ".tlh", "agents", "directory.md");
    fs.mkdirSync(directoryCandidate, { recursive: true });
    const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));

    assert.equal(result.status, "loaded");
    assert.deepEqual(result.manifest?.entries, []);
    assert.deepEqual(result.manifest?.tombstones, ["embedded.directory"]);
  });

  it("rejects symlink candidates without reading their target and tombstones their runtime name", async () => {
    const project = tempProject();
    const outside = path.join(project, "outside.md");
    fs.writeFileSync(
      outside,
      "---\nname: escaped\ndescription: escaped\ntools: read\n---\n",
      "utf8",
    );
    const link = path.join(project, ".tlh", "agents", "escaped.md");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return;
    }

    const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.manifest?.entries, []);
    assert.deepEqual(result.manifest?.tombstones, ["embedded.escaped"]);
    assert.match(result.diagnostics.join("\n"), /regular non-symlink/);
  });

  it("fails closed when a nested project-agent directory is a symlink", async () => {
    const project = tempProject();
    const target = path.join(project, "linked-agent-directory");
    const link = path.join(project, ".tlh", "agents", "linked");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(target, link, "dir");
    } catch {
      return;
    }

    const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));
    assert.equal(result.status, "unavailable");
    assert.equal(result.capability, undefined);
    assert.match(result.diagnostics.join("\n"), /Symlinked project-agent directory/);
  });

  it("aborts unstable scans without activating a partial generation", async () => {
    const project = tempProject();
    const filePath = writeDefinition(project, "unstable.md", { body: "before" });
    const canonicalFilePath = fs.realpathSync(filePath);
    const fileSystem = fileSystemWithReadHook((readPath, value) => {
      if (readPath === canonicalFilePath)
        fs.writeFileSync(filePath, value.toString("utf8").replace("before", "after"));
      return value;
    });
    const result = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      fileSystem,
      maxAttempts: 1,
    });

    assert.equal(result.status, "unstable");
    assert.equal(result.capability, undefined);
    assert.equal(result.manifest, undefined);
  });

  it("enforces count, total-size, and depth bounds before activation", async () => {
    const project = tempProject();
    writeDefinition(project, "one.md");
    writeDefinition(project, "two.md");
    const countBounded = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      maxFiles: 1,
    });
    assert.equal(countBounded.status, "bounded");
    assert.equal(countBounded.capability, undefined);

    const sizeBounded = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      maxTotalBytes: 1,
    });
    assert.equal(sizeBounded.status, "bounded");

    const deepPath = Array.from({ length: MAX_PROJECT_AGENT_DEPTH + 1 }, (_, i) => `d${i}`).join(
      path.sep,
    );
    writeDefinition(project, path.join(deepPath, "deep.md"));
    const depthBounded = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      maxDepth: MAX_PROJECT_AGENT_DEPTH,
    });
    assert.equal(depthBounded.status, "bounded");

    const directoryProject = tempProject();
    writeDefinition(directoryProject, path.join("nested", "agent.md"));
    let directoryReads = 0;
    const directoryFileSystem = fileSystemWithReadHook((_filePath, value) => {
      directoryReads += 1;
      return value;
    });
    const directoryBounded = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(directoryProject),
      fileSystem: directoryFileSystem,
      maxDirectories: 1,
    });
    assert.equal(directoryBounded.status, "bounded");
    assert.equal(directoryBounded.capability, undefined);
    assert.equal(directoryReads, 0);
  });

  it("registers a new generation on reload while retaining the previous generation", async () => {
    const project = tempProject();
    const filePath = writeDefinition(project, "reloadable.md", { body: "first" });
    const first = await loadProjectAgentSnapshot(
      trustedLoadOptions(project, { generationId: "generation-one" }),
    );
    fs.writeFileSync(
      filePath,
      fs.readFileSync(filePath, "utf8").replace("first", "second"),
      "utf8",
    );
    const second = await loadProjectAgentSnapshot(
      trustedLoadOptions(project, { generationId: "generation-two" }),
    );

    assert.equal(first.status, "loaded");
    assert.equal(second.status, "loaded");
    assert.notEqual(first.capability, second.capability);
    const firstExpected = getProjectAgentSnapshotProvenance(first.capability!);
    const secondExpected = getProjectAgentSnapshotProvenance(second.capability!);
    assert.equal(
      resolveProjectAgentSnapshot(first.capability!, firstExpected).entries[0]?.agent.systemPrompt,
      "first",
    );
    assert.equal(
      resolveProjectAgentSnapshot(second.capability!, secondExpected).entries[0]?.agent
        .systemPrompt,
      "second",
    );
    assert.equal(firstExpected.projectRoot, secondExpected.projectRoot);
    assert.notEqual(firstExpected.generationId, secondExpected.generationId);
  });

  it("scans only .tlh/agents and leaves generic project paths untouched", () => {
    const project = tempProject();
    writeDefinition(project, "tlh-only.md");
    const genericPaths: Array<[string, string]> = [
      [".pi/agents/generic.md", "generic"],
      [".agents/legacy.md", "legacy"],
      ["configured/agent.md", "configured"],
    ];
    for (const [relativePath, name] of genericPaths) {
      const filePath = path.join(project, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        `---\nname: ${name}\ndescription: Generic\ntools: read\n---\nGeneric.\n`,
        "utf8",
      );
    }

    const scan = scanProjectAgentDefinitions(project);
    assert.equal(scan.status, "stable");
    assert.deepEqual(
      scan.entries.map((entry) => entry.agent.name),
      ["embedded.tlh-only"],
    );
  });

  it("passes the loaded generation through the private provider only", async () => {
    const project = tempProject();
    const packageAgent = path.join(project, "package-agents", "package-only.md");
    fs.mkdirSync(path.dirname(packageAgent), { recursive: true });
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ "pi-subagents": { agents: ["./package-agents"] } }),
      "utf8",
    );
    fs.writeFileSync(
      packageAgent,
      "---\nname: package-only\ndescription: Generic package agent\ntools: read\n---\nPackage.\n",
      "utf8",
    );
    const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));
    assert.equal(result.status, "loaded");
    assert.equal(result.trust?.source, "no-project-agents");
    const discovered = discoverAgentsWithProjectSnapshot(
      project,
      result.capability!,
      result.provenance!,
    );
    assert.equal(discovered.projectSnapshot.provenance.projectRoot, fs.realpathSync(project));
    assert.equal(discovered.projectAgentsDir, null);
    assert.equal(discovered.projectSnapshot.provenance.generationId, "generation-loader-test");
    assert.equal(
      discovered.agents.some((agent) => agent.name === "package-only"),
      false,
    );
    assert.throws(
      () =>
        discoverAgentsWithProjectSnapshot(
          path.dirname(project),
          result.capability!,
          result.provenance!,
        ),
      (error: unknown) => error instanceof ProjectAgentSnapshotCapabilityError,
    );
  });
});
