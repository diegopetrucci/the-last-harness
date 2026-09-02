import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  MAX_PROJECT_AGENT_FILE_BYTES,
  MAX_PROJECT_AGENT_FILES,
  MAX_PROJECT_AGENT_TOTAL_BYTES,
  parseProjectAgentDefinition,
  resolveCanonicalGitWorktreeRoot,
  resolveProjectAgentTrust,
  scanProjectAgentDefinitions,
  type ProjectAgentLoaderFileSystem,
  type ProjectAgentSnapshotLoadOptions,
} from "../../src/agents/project-agent-loader.ts";

const tempDirs: string[] = [];

function tempProject(options: { git?: boolean } = {}): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-agent-loader-"));
  tempDirs.push(project);
  if (options.git !== false) execFileSync("git", ["init", "--quiet"], { cwd: project });
  return project;
}

function customDirectory(projectRoot: string): string {
  return path.join(projectRoot, ".tlh", "agents", "custom");
}

function writeDefinition(
  projectRoot: string,
  fileName: string,
  options: {
    name?: string;
    packageName?: string;
    description?: string;
    tools?: string;
    extraFrontmatter?: string;
    body?: string;
  } = {},
): string {
  const filePath = path.join(customDirectory(projectRoot), fileName);
  const stem = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
  const content = [
    "---",
    `name: ${options.name ?? stem.toLowerCase()}`,
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
    trust: {
      trustStore: { getEntry: () => ({ path: canonicalRoot, decision: true }) },
    },
    ...overrides,
  };
}

function descriptorFileSystem(
  onRead?: (kind: "metadata" | "definition", filePath: string) => void,
  onOpen?: (filePath: string) => void,
): ProjectAgentLoaderFileSystem {
  const descriptors = new Map<number, string>();
  return {
    lstatSync: (filePath) => fs.lstatSync(filePath),
    readdirSync: (filePath, options) => fs.readdirSync(filePath, options),
    realpathSync: (filePath) => fs.realpathSync(filePath),
    readFileSync: (filePath) => {
      onRead?.(
        filePath.includes(`${path.sep}custom${path.sep}`) ? "definition" : "metadata",
        filePath,
      );
      return fs.readFileSync(filePath);
    },
    openSync: (filePath, flags) => {
      onOpen?.(filePath);
      const descriptor = fs.openSync(filePath, flags);
      descriptors.set(descriptor, filePath);
      return descriptor;
    },
    fstatSync: (descriptor) => fs.fstatSync(descriptor),
    readSync: (descriptor, buffer, offset, length, position) => {
      const filePath = descriptors.get(descriptor);
      if (filePath) onRead?.("definition", filePath);
      return fs.readSync(descriptor, buffer, offset, length, position);
    },
    closeSync: (descriptor) => {
      descriptors.delete(descriptor);
      fs.closeSync(descriptor);
    },
    noFollowFlag: fs.constants.O_NOFOLLOW,
  };
}

function cloneStatsWithIdentity(stat: fs.Stats, dev: number, ino: number): fs.Stats {
  const clone = Object.create(Object.getPrototypeOf(stat)) as fs.Stats;
  Object.assign(clone, stat, { dev, ino });
  return clone;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("trusted project-agent loader", () => {
  it("resolves a validated worktree without invoking the injected Git command seam", () => {
    const project = tempProject();
    fs.mkdirSync(path.join(project, "src"));
    let invoked = false;
    assert.equal(
      resolveCanonicalGitWorktreeRoot(path.join(project, "src"), {
        git: {
          showToplevel: () => {
            invoked = true;
            return project;
          },
        },
      }),
      fs.realpathSync(project),
    );
    assert.equal(invoked, false);
    assert.equal(
      resolveCanonicalGitWorktreeRoot(project, { git: { showToplevel: () => project } }),
      fs.realpathSync(project),
    );

    const outside = tempProject({ git: false });
    assert.equal(resolveCanonicalGitWorktreeRoot(outside), undefined);
    const file = path.join(project, "not-a-directory");
    fs.writeFileSync(file, "not a cwd", "utf8");
    assert.equal(resolveCanonicalGitWorktreeRoot(file), undefined);
    assert.equal(resolveCanonicalGitWorktreeRoot(path.join(project, "missing")), undefined);
  });

  it("maps an exact uppercase filename to lowercase runtime identity and preserves fields", () => {
    const project = tempProject();
    const filePath = writeDefinition(project, "REVIEWER.md", {
      tools: "read,bash,write,edit,mcp:ignored",
      extraFrontmatter: "model: openai/reviewer\nsupervisorBridge: false\ncustomField: retained",
      body: "Review the repository.",
    });
    const bytes = fs.readFileSync(filePath);
    const entry = parseProjectAgentDefinition(filePath, bytes);

    assert.equal(entry.agent.name, "embedded.reviewer");
    assert.equal(entry.agent.localName, "reviewer");
    assert.equal(entry.agent.packageName, "embedded");
    assert.equal(entry.agent.source, "project");
    assert.deepEqual(entry.agent.tools, ["read", "bash", "write", "edit"]);
    assert.equal(entry.agent.model, "openai/reviewer");
    assert.equal(entry.agent.supervisorBridge, false);
    assert.equal(entry.agent.extraFields?.customField, "retained");
    assert.deepEqual(entry.frontmatterFields, [
      "name",
      "package",
      "description",
      "tools",
      "model",
      "supervisorBridge",
      "customField",
    ]);
    assert.equal(entry.digest, createHash("sha256").update(bytes).digest("hex"));
    assert.throws(
      () => parseProjectAgentDefinition(filePath.replace("REVIEWER.md", "reviewer.md"), bytes),
      /uppercase ASCII/,
    );
  });

  it("preserves delegate defaults for the uppercase filename identity", () => {
    const project = tempProject();
    const filePath = writeDefinition(project, "DELEGATE.md");
    const entry = parseProjectAgentDefinition(filePath, fs.readFileSync(filePath));

    assert.equal(entry.agent.localName, "delegate");
    assert.equal(entry.agent.systemPromptMode, "append");
    assert.equal(entry.agent.inheritProjectContext, true);
  });

  it("enforces filename, frontmatter, package, tools, and extension agreement", () => {
    const project = tempProject();
    const cases = [
      ["WRONG-PACKAGE.md", { packageName: "other" }, /package must exactly be 'embedded'/],
      ["WRONG-NAME.md", { name: "different" }, /frontmatter name must exactly equal lowercase/],
      ["MISSING-TOOLS.md", { tools: "" }, /tools must declare at least one usable tool/],
      [
        "EXTENSIONS.md",
        { extraFrontmatter: "extensions: ./project-extension" },
        /extensions and subagentOnlyExtensions are prohibited/,
      ],
      [
        "SUBAGENT-EXTENSIONS.md",
        { extraFrontmatter: "subagentOnlyExtensions: ./project-extension" },
        /extensions and subagentOnlyExtensions are prohibited/,
      ],
      [
        "ONLY-MCP.md",
        { tools: "mcp:unsafe-project-tool" },
        /tools must declare at least one usable tool/,
      ],
      ["INVALID-TOOL.md", { tools: "read,grep[]" }, /valid runtime tool name/],
      ["INVALID-TOOL-PREFIX.md", { tools: "-read" }, /valid runtime tool name/],
      [
        "INVALID-SUPERVISOR-BRIDGE.md",
        { extraFrontmatter: "supervisorBridge: maybe" },
        /supervisorBridge must be true or false/,
      ],
      [
        "LEGACY-CONTEXT.md",
        { extraFrontmatter: "defaultContext: fork" },
        /defaultContext is no longer supported.*starts child sessions fresh/,
      ],
    ] as const;

    for (const [fileName, options, expected] of cases) {
      const filePath = writeDefinition(project, fileName, options);
      assert.throws(
        () => parseProjectAgentDefinition(filePath, fs.readFileSync(filePath)),
        expected,
      );
    }

    const malformedDelimiter = writeDefinition(project, "MALFORMED-DELIMITER.md");
    fs.writeFileSync(
      malformedDelimiter,
      fs.readFileSync(malformedDelimiter, "utf8").replace("\n---\n", "\n----\n"),
      "utf8",
    );
    assert.throws(
      () => parseProjectAgentDefinition(malformedDelimiter, fs.readFileSync(malformedDelimiter)),
      /frontmatter closing delimiter is invalid/,
    );

    const validBudget = writeDefinition(project, "VALID-TOOL-BUDGET.md", {
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

    const budgetCases = [
      ["TOOL-BUDGET-MISSING-HARD.md", '{"soft": 1}', /toolBudget\.hard must be an integer >= 1/],
      [
        "TOOL-BUDGET-INVALID-SOFT.md",
        '{"hard": 2, "soft": 0}',
        /toolBudget\.soft must be an integer >= 1/,
      ],
      [
        "TOOL-BUDGET-INVALID-BLOCK.md",
        '{"hard": 2, "block": ["read", 1]}',
        /toolBudget\.block must contain non-empty tool names/,
      ],
      ["TOOL-BUDGET-ARRAY.md", '["read"]', /toolBudget must be an object/],
    ] as const;
    for (const [fileName, budget, expected] of budgetCases) {
      const filePath = writeDefinition(project, fileName, {
        extraFrontmatter: `toolBudget: ${budget}`,
      });
      assert.throws(
        () => parseProjectAgentDefinition(filePath, fs.readFileSync(filePath)),
        expected,
      );
    }
  });

  it("loads only direct uppercase custom files at the Git root", async () => {
    const project = tempProject();
    const valid = writeDefinition(project, "REVIEWER.md", { body: "Root custom prompt." });
    writeDefinition(project, "lowercase.md");
    writeDefinition(project, "Mixed-Case.md");
    writeDefinition(project, "nested/NESTED.md");
    const nestedOutside = path.join(project, "nested-outside");
    fs.mkdirSync(nestedOutside, { recursive: true });
    try {
      fs.symlinkSync(nestedOutside, path.join(customDirectory(project), "nested-link"), "dir");
    } catch {
      // Symlink support is optional on some contributor filesystems; the
      // non-recursive assertion below remains meaningful without it.
    }
    const wrongDirectory = path.join(project, ".tlh", "agents", "WRONG-DIRECTORY.md");
    fs.mkdirSync(path.dirname(wrongDirectory), { recursive: true });
    fs.writeFileSync(wrongDirectory, "---\nname: wrong-directory\n---\n", "utf8");
    const builtIn = path.join(project, ".tlh", "agents", "builtin", "BUILTIN.md");
    fs.mkdirSync(path.dirname(builtIn), { recursive: true });
    fs.writeFileSync(builtIn, "---\nname: builtin\n---\n", "utf8");

    const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));
    assert.equal(result.status, "loaded");
    assert.equal(result.agentsDirectory, fs.realpathSync(customDirectory(project)));
    assert.deepEqual(
      result.manifest?.entries.map((entry) => entry.agent.name),
      ["embedded.reviewer"],
    );
    assert.equal(result.manifest?.entries[0]?.agent.filePath, fs.realpathSync(valid));
    assert.deepEqual(result.manifest?.tombstones, []);
    assert.equal(result.scan?.candidateCount, 3);
    assert.equal(
      result.scan?.totalBytes,
      fs.statSync(valid).size +
        fs.statSync(path.join(customDirectory(project), "lowercase.md")).size +
        fs.statSync(path.join(customDirectory(project), "Mixed-Case.md")).size,
    );
  });

  it("does not read definition contents before trust authorization", async () => {
    const project = tempProject();
    const definition = writeDefinition(project, "SECRET.md", { body: "must not be read" });
    const reads: Array<{ kind: "metadata" | "definition"; path: string }> = [];
    let prompted = 0;
    const fileSystem = descriptorFileSystem((kind, filePath) =>
      reads.push({ kind, path: filePath }),
    );
    const result = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      fileSystem,
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => true,
        isProjectTrusted: () => true,
        defaultProjectTrust: "always",
        hasUI: true,
        confirm: () => {
          prompted += 1;
          return true;
        },
      } as never,
    });

    assert.equal(result.status, "denied");
    assert.equal(result.trust?.source, "no-persisted-trust");
    assert.equal(prompted, 0);
    assert.equal(
      reads.some(({ kind, path: readPath }) => kind === "definition" || readPath === definition),
      false,
    );
  });

  it("keeps the execution-plane trust resolver persisted-only in both source artifacts", () => {
    for (const sourceName of ["project-agent-loader.ts", "project-agent-loader.js"]) {
      const source = fs.readFileSync(
        new URL(`../../src/agents/${sourceName}`, import.meta.url),
        "utf8",
      );
      for (const forbidden of [
        "SESSION_TRUST_DECISIONS",
        "defaultProjectTrust",
        "isProjectTrusted",
        "options.confirm",
        "options.ui",
        "hasUI",
      ]) {
        assert.equal(
          source.includes(forbidden),
          false,
          `${sourceName} must not contain non-persisted trust input ${forbidden}`,
        );
      }
    }
  });

  it("requires a persisted containing trust entry and ignores transient or upstream approval", async () => {
    const project = tempProject();
    const nested = path.join(project, "nested");
    fs.mkdirSync(nested);
    const saved = (decision: boolean, trustPath = project) => ({
      trustStore: { getEntry: () => ({ path: trustPath, decision }) },
    });

    assert.equal((await resolveProjectAgentTrust(project, saved(true))).source, "saved-positive");
    assert.equal((await resolveProjectAgentTrust(project, saved(false))).source, "saved-negative");
    assert.equal(
      (await resolveProjectAgentTrust(project, { ...saved(false), trustOverride: true })).source,
      "saved-negative",
    );
    assert.equal(
      (await resolveProjectAgentTrust(project, saved(true, path.dirname(project)))).trusted,
      true,
    );
    assert.equal(
      (await resolveProjectAgentTrust(project, saved(true, nested))).source,
      "trust-path-mismatch",
    );
    assert.equal(
      (await resolveProjectAgentTrust(project, saved(true, path.join(project, "missing")))).source,
      "trust-path-mismatch",
    );
    assert.equal(
      (await resolveProjectAgentTrust(project, { trustStore: { getEntry: () => null } })).source,
      "no-persisted-trust",
    );

    let prompts = 0;
    const nonAuthoritativeInputs = {
      trustStore: { getEntry: () => null },
      hasTrustRequiringProjectResources: () => true,
      isProjectTrusted: () => true,
      defaultProjectTrust: "always",
      sessionId: "loader-session-cache",
      hasUI: true,
      confirm: () => {
        prompts += 1;
        return true;
      },
    } as never;
    const transient = await resolveProjectAgentTrust(project, nonAuthoritativeInputs);
    assert.equal(transient.kind, "project-agent");
    assert.equal(transient.trusted, false);
    assert.equal(transient.source, "no-persisted-trust");
    assert.equal(prompts, 0);

    const malformed = await resolveProjectAgentTrust(project, {
      trustStore: {
        getEntry: () => ({ path: project, decision: "yes" }) as never,
      },
    });
    assert.equal(malformed.source, "trust-store-error");
    const unsupportedStore = await resolveProjectAgentTrust(project, {
      trustStore: { get: () => true } as never,
    });
    assert.equal(unsupportedStore.source, "trust-store-error");
  });

  it("fails closed when trust dependencies are unavailable without reading definitions", async () => {
    const project = tempProject();
    const definition = writeDefinition(project, "MISSING-DEPENDENCIES.md");
    const reads: Array<{ kind: "metadata" | "definition"; path: string }> = [];
    const result = await loadProjectAgentSnapshot({
      cwd: project,
      sessionId: "missing-dependencies-session",
      fileSystem: descriptorFileSystem((kind, filePath) => reads.push({ kind, path: filePath })),
    });
    assert.equal(result.status, "unavailable");
    assert.match(result.diagnostics.join("\n"), /trust dependencies are unavailable/);
    assert.equal(
      reads.some(({ kind, path: readPath }) => kind === "definition" || readPath === definition),
      false,
    );
  });

  it("does not construct a trust store when no saved trust file exists", async () => {
    const project = tempProject();
    const agentDir = path.join(project, "missing-agent-dir");
    let constructions = 0;
    const result = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project, { agentDir, trust: undefined }),
      trustDependencies: {
        createProjectTrustStore: () => {
          constructions += 1;
          throw new Error("must not construct a store without trust.json");
        },
      },
    });
    assert.equal(result.status, "loaded");
    assert.equal(constructions, 0);
    assert.equal(fs.existsSync(agentDir), false);
  });

  it("keeps an absent custom directory inactive without consulting transient trust state", async () => {
    const project = tempProject();
    let prompted = false;
    const result = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      trust: {
        trustStore: { getEntry: () => null },
        isProjectTrusted: () => false,
        hasUI: true,
        confirm: () => {
          prompted = true;
          return true;
        },
      } as never,
    });
    assert.equal(result.status, "loaded");
    assert.equal(result.trust?.source, "no-project-agents");
    assert.deepEqual(result.manifest?.entries, []);
    assert.equal(prompted, false);
  });

  it("ignores all fixed built-in and generic paths while retaining the exact custom root", async () => {
    const project = tempProject();
    writeDefinition(project, "CUSTOM.md");
    for (const relativePath of [
      ".tlh/agents/BUILTIN.md",
      ".tlh/agents/builtin/ARCHITECT_PROMPT_APPEND.md",
      ".tlh/agents/other/OTHER.md",
      ".pi/agents/GENERIC.md",
      ".agents/GENERIC.md",
    ]) {
      const filePath = path.join(project, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "not a custom candidate", "utf8");
    }
    const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));
    assert.deepEqual(
      result.manifest?.entries.map((entry) => entry.agent.name),
      ["embedded.custom"],
    );
  });

  it("fails closed for symlinked and non-directory fixed components", async () => {
    const components = [".tlh", path.join(".tlh", "agents"), path.join(".tlh", "agents", "custom")];
    for (const component of components) {
      const project = tempProject();
      const outside = path.join(project, "outside");
      fs.mkdirSync(outside, { recursive: true });
      const componentPath = path.join(project, component);
      fs.mkdirSync(path.dirname(componentPath), { recursive: true });
      try {
        fs.symlinkSync(outside, componentPath, "dir");
      } catch {
        continue;
      }
      const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));
      assert.equal(result.status, "unavailable");
      assert.equal(result.capability, undefined);
      assert.match(
        result.diagnostics.join("\n"),
        /not a regular non-symlink directory|validated Git worktree/,
      );
    }
    for (const component of components) {
      const project = tempProject();
      const componentPath = path.join(project, component);
      fs.mkdirSync(path.dirname(componentPath), { recursive: true });
      fs.writeFileSync(componentPath, "not a directory", "utf8");
      const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));
      assert.equal(result.status, "unavailable");
      assert.equal(result.capability, undefined);
      assert.match(result.diagnostics.join("\n"), /not a regular non-symlink directory/);
    }
  });

  it("tombstones direct symlink, non-regular, oversize, and unavailable-O_NOFOLLOW candidates", async () => {
    const project = tempProject();
    const outside = path.join(project, "outside.md");
    fs.writeFileSync(outside, "secret outside", "utf8");
    const symlink = path.join(customDirectory(project), "ESCAPED.md");
    fs.mkdirSync(customDirectory(project), { recursive: true });
    try {
      fs.symlinkSync(outside, symlink);
    } catch {
      return;
    }
    const nonRegular = path.join(customDirectory(project), "DIRECTORY.md");
    fs.mkdirSync(nonRegular);
    const oversized = writeDefinition(project, "OVERSIZE.md", {
      body: "x".repeat(MAX_PROJECT_AGENT_FILE_BYTES),
    });
    writeDefinition(project, "SAFE.md");
    const noFollow = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      fileSystem: { ...descriptorFileSystem(), noFollowFlag: undefined },
    });

    assert.equal(noFollow.status, "loaded");
    assert.deepEqual(noFollow.manifest?.entries, []);
    assert.deepEqual(noFollow.manifest?.tombstones, [
      "embedded.directory",
      "embedded.escaped",
      "embedded.oversize",
      "embedded.safe",
    ]);
    assert.match(
      noFollow.diagnostics.join("\n"),
      /O_NOFOLLOW|regular non-symlink|file size exceeds/,
    );
    assert.equal(fs.existsSync(oversized), true);
  });

  it("requires positive root and candidate dev/ino identities", async () => {
    const project = tempProject();
    const valid = writeDefinition(project, "VALID.md");
    const rootIdentityFs = descriptorFileSystem();
    const originalLstat = rootIdentityFs.lstatSync;
    rootIdentityFs.lstatSync = (filePath) => {
      const stat = originalLstat(filePath);
      return filePath === fs.realpathSync(project)
        ? cloneStatsWithIdentity(stat, 0, stat.ino)
        : stat;
    };
    const rootResult = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      fileSystem: rootIdentityFs,
    });
    assert.equal(rootResult.status, "unavailable");

    const candidateIdentityFs = descriptorFileSystem();
    const candidateLstat = candidateIdentityFs.lstatSync;
    candidateIdentityFs.lstatSync = (filePath) => {
      const stat = candidateLstat(filePath);
      return filePath === fs.realpathSync(valid) ? cloneStatsWithIdentity(stat, stat.dev, 0) : stat;
    };
    const candidateResult = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      fileSystem: candidateIdentityFs,
    });
    assert.equal(candidateResult.status, "loaded");
    assert.deepEqual(candidateResult.manifest?.entries, []);
    assert.deepEqual(candidateResult.manifest?.tombstones, ["embedded.valid"]);
  });

  it("detects descriptor, directory, and path identity swaps before activating a generation", async () => {
    const project = tempProject();
    const filePath = writeDefinition(project, "SWAP.md", { body: "before" });
    const backup = `${filePath}.old`;
    let swapped = false;
    const fileSystem = descriptorFileSystem(undefined, (openedPath) => {
      if (openedPath !== fs.realpathSync(filePath) || swapped) return;
      swapped = true;
      fs.renameSync(filePath, backup);
      writeDefinition(project, "SWAP.md", { body: "after" });
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

  it("rejects descriptor and fixed-directory identity swaps before reading", async () => {
    const descriptorProject = tempProject();
    writeDefinition(descriptorProject, "DESCRIPTOR.md");
    const descriptorFs = descriptorFileSystem();
    const originalFstat = descriptorFs.fstatSync!;
    let fstatCalls = 0;
    descriptorFs.fstatSync = (descriptor) => {
      const stat = originalFstat(descriptor);
      fstatCalls += 1;
      return fstatCalls === 1 ? cloneStatsWithIdentity(stat, stat.dev + 1, stat.ino) : stat;
    };
    const descriptorResult = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(descriptorProject),
      fileSystem: descriptorFs,
      maxAttempts: 1,
    });
    assert.equal(descriptorResult.status, "unstable");
    assert.equal(descriptorResult.capability, undefined);

    const directoryProject = tempProject();
    const directoryFile = writeDefinition(directoryProject, "DIRECTORY-SWAP.md");
    const custom = customDirectory(directoryProject);
    const moved = `${custom}.old`;
    let directorySwapped = false;
    const directoryFs = descriptorFileSystem(undefined, () => {
      if (directorySwapped) return;
      directorySwapped = true;
      fs.renameSync(custom, moved);
      fs.mkdirSync(custom, { recursive: true });
    });
    const directoryResult = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(directoryProject),
      fileSystem: directoryFs,
      maxAttempts: 1,
    });
    assert.equal(directoryResult.status, "unstable");
    assert.equal(directoryResult.capability, undefined);
    assert.equal(fs.existsSync(directoryFile), false);
  });

  it("keeps scan bounds and double-inventory stability before registration", async () => {
    const project = tempProject();
    writeDefinition(project, "ONE.md");
    writeDefinition(project, "TWO.md");
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

    let reads = 0;
    const changing = descriptorFileSystem((kind, readPath) => {
      if (kind !== "definition" || !readPath.endsWith(`${path.sep}ONE.md`)) return;
      reads += 1;
      if (reads === 1) writeDefinition(project, "ONE.md", { body: "changed while reading" });
    });
    const unstable = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(project),
      fileSystem: changing,
      maxAttempts: 1,
    });
    assert.equal(unstable.status, "unstable");
    assert.equal(unstable.capability, undefined);
  });

  it("fails closed for case-insensitive filename collisions", async () => {
    const project = tempProject();
    const uppercase = writeDefinition(project, "COLLISION.md");
    const lowercase = writeDefinition(project, "collision.md");
    const fileSystem = descriptorFileSystem();
    const custom = fs.realpathSync(customDirectory(project));
    const originalReaddir = fileSystem.readdirSync;
    fileSystem.readdirSync = (directory, options) =>
      directory === custom
        ? [{ name: "COLLISION.md" }, { name: "collision.md" }]
        : originalReaddir(directory, options);
    const result = await loadProjectAgentSnapshot(trustedLoadOptions(project, { fileSystem }));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.manifest?.entries, []);
    assert.deepEqual(result.manifest?.tombstones, ["embedded.collision"]);
    assert.match(result.diagnostics.join("\n"), /Case-insensitive duplicate/);
    assert.equal(fs.existsSync(uppercase) || fs.existsSync(lowercase), true);
  });

  it("rejects malformed nearest Git metadata and does not fall back to an outer root", () => {
    const outer = tempProject();
    const child = path.join(outer, "nested");
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, ".git"), "not a git marker\n", "utf8");
    assert.equal(resolveCanonicalGitWorktreeRoot(child), undefined);

    const linkedRoot = path.join(outer, "linked");
    const linkedCwd = path.join(linkedRoot, "src");
    const admin = path.join(outer, ".git", "worktrees", "linked");
    fs.mkdirSync(linkedCwd, { recursive: true });
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/linked\n", "utf8");
    fs.writeFileSync(path.join(admin, "gitdir"), `${path.join(linkedRoot, ".git")}\n`, "utf8");
    fs.writeFileSync(path.join(admin, "commondir"), "../..\n", "utf8");
    fs.writeFileSync(path.join(linkedRoot, ".git"), `gitdir: ${admin}\n`, "utf8");
    assert.equal(resolveCanonicalGitWorktreeRoot(linkedCwd), fs.realpathSync(linkedRoot));
  });

  it("registers one immutable generation and preserves project-snapshot package resolution", async () => {
    const project = tempProject();
    const filePath = writeDefinition(project, "RELOADABLE.md", { body: "first" });
    const first = await loadProjectAgentSnapshot(
      trustedLoadOptions(project, { generationId: "one" }),
    );
    fs.writeFileSync(
      filePath,
      fs.readFileSync(filePath, "utf8").replace("first", "second"),
      "utf8",
    );
    const second = await loadProjectAgentSnapshot(
      trustedLoadOptions(project, { generationId: "two" }),
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

    const discovered = discoverAgentsWithProjectSnapshot(
      project,
      second.capability!,
      second.provenance!,
    );
    assert.deepEqual(
      discovered.agents
        .filter((agent) => agent.name.startsWith("embedded."))
        .map((agent) => agent.name),
      ["embedded.reloadable"],
    );
    assert.throws(
      () =>
        discoverAgentsWithProjectSnapshot(
          path.dirname(project),
          second.capability!,
          second.provenance!,
        ),
      (error: unknown) => error instanceof ProjectAgentSnapshotCapabilityError,
    );
  });

  it("accepts current content after an inode replacement during fresh reload", async () => {
    const project = tempProject();
    const filePath = writeDefinition(project, "REPLACEABLE.md", { body: "before replacement" });
    const first = await loadProjectAgentSnapshot(
      trustedLoadOptions(project, { generationId: "inode-one" }),
    );
    const movedPath = `${filePath}.old`;
    fs.renameSync(filePath, movedPath);
    writeDefinition(project, "REPLACEABLE.md", { body: "after inode replacement" });
    const second = await loadProjectAgentSnapshot(
      trustedLoadOptions(project, { generationId: "inode-two" }),
    );

    assert.equal(first.status, "loaded");
    assert.equal(second.status, "loaded");
    assert.equal(second.manifest?.entries[0]?.agent.systemPrompt, "after inode replacement");
    assert.notEqual(
      second.manifest?.entries[0]?.digest,
      first.manifest?.entries[0]?.digest,
      "replacement content must produce a fresh digest",
    );
    assert.equal(fs.existsSync(movedPath), true);
  });

  it("ignores default trust and still requires a validated root", async () => {
    const project = tempProject();
    writeDefinition(project, "TRUST.md");
    const result = await resolveProjectAgentTrust(project, {
      trustStore: { getEntry: () => null },
      hasTrustRequiringProjectResources: () => true,
      defaultProjectTrust: "always",
      hasUI: true,
      confirm: () => true,
    } as never);
    assert.equal(result.source, "no-persisted-trust");
    const outside = tempProject({ git: false });
    const unavailable = await loadProjectAgentSnapshot({
      ...trustedLoadOptions(outside),
      trust: {
        trustStore: { getEntry: () => ({ path: outside, decision: true }) },
      },
    });
    assert.equal(unavailable.status, "unavailable");
  });

  it("enforces the exact 64 KiB per-file boundary", async () => {
    assert.equal(MAX_PROJECT_AGENT_FILE_BYTES, 64 * 1024);
    const project = tempProject();
    const exactPath = writeDefinition(project, "EXACT.md");
    const overPath = writeDefinition(project, "OVER.md");
    const exactBytes = fs.readFileSync(exactPath);
    const overBytes = fs.readFileSync(overPath);
    assert.ok(exactBytes.byteLength < MAX_PROJECT_AGENT_FILE_BYTES);
    assert.ok(overBytes.byteLength < MAX_PROJECT_AGENT_FILE_BYTES);
    fs.appendFileSync(
      exactPath,
      Buffer.alloc(MAX_PROJECT_AGENT_FILE_BYTES - exactBytes.byteLength, 0x78),
    );
    fs.appendFileSync(
      overPath,
      Buffer.alloc(MAX_PROJECT_AGENT_FILE_BYTES + 1 - overBytes.byteLength, 0x78),
    );

    const result = await loadProjectAgentSnapshot(trustedLoadOptions(project));
    assert.equal(result.status, "loaded");
    assert.deepEqual(
      result.manifest?.entries.map((entry) => entry.agent.name),
      ["embedded.exact"],
    );
    assert.deepEqual(result.manifest?.tombstones, ["embedded.over"]);
    assert.match(result.diagnostics.join("\n"), /file size exceeds 65536 bytes/);
    assert.equal(fs.statSync(exactPath).size, 64 * 1024);
    assert.equal(fs.statSync(overPath).size, 64 * 1024 + 1);
  });

  it("keeps direct scan bounds aligned with the public constants", () => {
    assert.ok(MAX_PROJECT_AGENT_FILES > 0);
    assert.ok(MAX_PROJECT_AGENT_TOTAL_BYTES > MAX_PROJECT_AGENT_FILE_BYTES);
    const project = tempProject();
    writeDefinition(project, "DIRECT.md");
    const scan = scanProjectAgentDefinitions(project);
    assert.equal(scan.status, "stable");
    assert.deepEqual(
      scan.entries.map((entry) => entry.agent.name),
      ["embedded.direct"],
    );
  });
});
