import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  loadProjectDefaults,
  MAX_PROJECT_DEFAULTS_FILE_BYTES,
  MAX_PROJECT_DEFAULT_WARNING_LENGTH,
  MAX_PROJECT_DEFAULT_WARNINGS,
  PROJECT_DEFAULTS_FILE,
  resolveProjectConfigTrust,
  type ProjectDefaultsLoadOptions,
  type ProjectDefaultsLoaderFileSystem,
} from "../../src/agents/project-defaults-loader.ts";
import { resolveProjectAgentTrust } from "../../src/agents/project-agent-loader.ts";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-defaults-loader-"));
  tempDirs.push(dir);
  const gitDir = path.join(dir, ".git");
  fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "refs"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  fs.writeFileSync(path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\n", "utf8");
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a .tlh/defaults.json file and return the project root. */
function writeDefaults(projectRoot: string, content: unknown): void {
  const tlhDir = path.join(projectRoot, ".tlh");
  fs.mkdirSync(tlhDir, { recursive: true });
  fs.writeFileSync(
    path.join(tlhDir, "defaults.json"),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
}

/** Build trusted load options that gate on an in-memory trust store. */
function trustedOptions(
  projectRoot: string,
  overrides: Partial<ProjectDefaultsLoadOptions> = {},
): ProjectDefaultsLoadOptions {
  const canonicalRoot = fs.realpathSync(projectRoot);
  return {
    cwd: projectRoot,
    sessionId: "loader-test-session",
    trust: {
      trustStore: { getEntry: () => ({ path: canonicalRoot, decision: true }) },
      hasTrustRequiringProjectResources: () => false,
    },
    ...overrides,
  };
}

/** Build denied load options. */
function deniedOptions(projectRoot: string): ProjectDefaultsLoadOptions {
  return {
    cwd: projectRoot,
    sessionId: "loader-test-session",
    trust: {
      trustStore: { getEntry: () => ({ path: fs.realpathSync(projectRoot), decision: false }) },
      hasTrustRequiringProjectResources: () => false,
    },
  };
}

/** Stat-based fake that reports a symlink for the named path. */
function fileSystemWithSymlinkAt(
  real: ProjectDefaultsLoaderFileSystem,
  symlinkPath: string,
): ProjectDefaultsLoaderFileSystem {
  return {
    ...real,
    lstatSync: (filePath: string) => {
      const stat = fs.lstatSync(filePath);
      if (path.resolve(filePath) === path.resolve(symlinkPath)) {
        return Object.create(stat, {
          isSymbolicLink: { value: () => true },
          isFile: { value: () => false },
          isDirectory: { value: () => false },
        }) as fs.Stats;
      }
      return stat;
    },
    realpathSync: (filePath: string) => fs.realpathSync(filePath),
    readFileSync: (filePath: string) => fs.readFileSync(filePath),
  };
}

/** Add descriptor hooks while preserving the shared filesystem seam. */
function descriptorFileSystem(
  real: ProjectDefaultsLoaderFileSystem,
  onRead?: (filePath: string) => void,
  onOpen?: (filePath: string, flags: number) => void,
  onClose?: (filePath: string) => void,
): ProjectDefaultsLoaderFileSystem {
  const descriptors = new Map<number, string>();
  return {
    ...real,
    openSync: (filePath, flags) => {
      if (!real.openSync) throw new Error("openSync unavailable");
      onOpen?.(filePath, flags);
      const descriptor = real.openSync(filePath, flags);
      descriptors.set(descriptor, filePath);
      return descriptor;
    },
    fstatSync: (descriptor) => {
      if (!real.fstatSync) throw new Error("fstatSync unavailable");
      return real.fstatSync(descriptor);
    },
    readSync: (descriptor, buffer, offset, length, position) => {
      if (!real.readSync) throw new Error("readSync unavailable");
      const filePath = descriptors.get(descriptor);
      if (filePath) onRead?.(filePath);
      return real.readSync(descriptor, buffer, offset, length, position);
    },
    closeSync: (descriptor) => {
      const filePath = descriptors.get(descriptor);
      try {
        if (!real.closeSync) throw new Error("closeSync unavailable");
        real.closeSync(descriptor);
      } finally {
        if (filePath) onClose?.(filePath);
        descriptors.delete(descriptor);
      }
    },
  };
}

/** Inject a post-read lstat result without relying on filesystem timing. */
function fileSystemWithPostReadStat(
  real: ProjectDefaultsLoaderFileSystem,
  targetPath: string,
  mutate: (stat: fs.Stats) => fs.Stats,
): ProjectDefaultsLoaderFileSystem {
  const canonicalTarget = path.resolve(real.realpathSync(targetPath));
  let readStarted = false;
  const fileSystem = {
    ...real,
    lstatSync: (filePath: string) => {
      const stat = real.lstatSync(filePath);
      return readStarted && path.resolve(filePath) === canonicalTarget ? mutate(stat) : stat;
    },
  } satisfies ProjectDefaultsLoaderFileSystem;
  return descriptorFileSystem(fileSystem, (filePath) => {
    if (path.resolve(filePath) === canonicalTarget) readStarted = true;
  });
}

/** Inject a target identity change on the lstat immediately before reading. */
function fileSystemWithBeforeReadStat(
  real: ProjectDefaultsLoaderFileSystem,
  targetPath: string,
  mutate: (stat: fs.Stats) => fs.Stats,
  onRead: () => void,
): ProjectDefaultsLoaderFileSystem {
  const canonicalTarget = path.resolve(real.realpathSync(targetPath));
  let targetLstatCount = 0;
  const fileSystem = {
    ...real,
    lstatSync: (filePath: string) => {
      const stat = real.lstatSync(filePath);
      if (path.resolve(filePath) !== canonicalTarget) return stat;
      targetLstatCount += 1;
      return targetLstatCount === 3 ? mutate(stat) : stat;
    },
  } satisfies ProjectDefaultsLoaderFileSystem;
  return descriptorFileSystem(fileSystem, (filePath) => {
    if (path.resolve(filePath) === canonicalTarget) onRead();
  });
}

function cloneStatsWithIdentity(stat: fs.Stats, dev: number, ino: number): fs.Stats {
  const clone = Object.create(Object.getPrototypeOf(stat)) as fs.Stats;
  Object.assign(clone, stat, { dev, ino });
  return clone;
}

const REAL_FS: ProjectDefaultsLoaderFileSystem = {
  lstatSync: (filePath: string) => fs.lstatSync(filePath),
  realpathSync: (filePath: string) => fs.realpathSync(filePath),
  readFileSync: (filePath: string) => fs.readFileSync(filePath),
  openSync: (filePath, flags) => fs.openSync(filePath, flags),
  fstatSync: (descriptor) => fs.fstatSync(descriptor),
  readSync: (descriptor, buffer, offset, length, position) =>
    fs.readSync(descriptor, buffer, offset, length, position),
  closeSync: (descriptor) => fs.closeSync(descriptor),
  noFollowFlag: fs.constants.O_NOFOLLOW,
};

// ---------------------------------------------------------------------------
// Module exports (parity gate)
// ---------------------------------------------------------------------------

describe("project-defaults-loader exports", () => {
  it("exports PROJECT_DEFAULTS_FILE constant", () => {
    assert.ok(typeof PROJECT_DEFAULTS_FILE === "string");
    assert.ok(PROJECT_DEFAULTS_FILE.includes("defaults.json"));
  });

  it("exports warning bounds as positive numbers", () => {
    assert.ok(MAX_PROJECT_DEFAULT_WARNINGS > 0);
    assert.ok(MAX_PROJECT_DEFAULT_WARNING_LENGTH > 0);
  });

  it("exports MAX_PROJECT_DEFAULTS_FILE_BYTES as a positive number", () => {
    assert.ok(typeof MAX_PROJECT_DEFAULTS_FILE_BYTES === "number");
    assert.ok(MAX_PROJECT_DEFAULTS_FILE_BYTES > 0);
  });

  it("exports loadProjectDefaults as an async function", () => {
    assert.ok(typeof loadProjectDefaults === "function");
  });
});

// ---------------------------------------------------------------------------
// Generated .js parity
// ---------------------------------------------------------------------------

describe("generated .js parity", () => {
  it("the generated .js exports the same public symbols as the .ts source", async () => {
    const jsUrl = new URL("../../src/agents/project-defaults-loader.js", import.meta.url);
    const jsModule = (await import(jsUrl.href)) as Record<string, unknown>;
    assert.ok(typeof jsModule.PROJECT_DEFAULTS_FILE === "string");
    assert.ok(typeof jsModule.MAX_PROJECT_DEFAULTS_FILE_BYTES === "number");
    assert.equal(jsModule.MAX_PROJECT_DEFAULT_WARNINGS, MAX_PROJECT_DEFAULT_WARNINGS);
    assert.equal(jsModule.MAX_PROJECT_DEFAULT_WARNING_LENGTH, MAX_PROJECT_DEFAULT_WARNING_LENGTH);
    assert.ok(typeof jsModule.loadProjectDefaults === "function");
  });
});

// ---------------------------------------------------------------------------
// Worktree root resolution
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — worktree resolution", () => {
  it("returns unavailable when cwd is not inside a git worktree", async () => {
    const result = await loadProjectDefaults({
      cwd: "/tmp",
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
      },
    });
    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((w) => w.includes("Git worktree")));
  });
});

// ---------------------------------------------------------------------------
// Trust gating
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — trust gating", () => {
  it("returns denied when trust store explicitly denies the project", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const result = await loadProjectDefaults(deniedOptions(projectRoot));
    assert.equal(result.status, "denied");
    assert.ok(result.warnings.some((w) => w.includes("denied")));
  });

  it("returns unavailable when trust dependencies are missing", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {});
    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "missing-trust-dependencies",
      // No trust provided at all
      trust: {},
    });
    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((w) => w.includes("trust dependencies")));
  });

  it("returns unavailable when hasTrustRequiringProjectResources is not a function", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {});
    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "missing-resource-probe",
      trust: {
        trustStore: { getEntry: () => null },
        // hasTrustRequiringProjectResources is missing
      },
    });
    assert.equal(result.status, "unavailable");
  });

  it("fails closed without a session identity and never prompts", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    let prompts = 0;
    const result = await loadProjectDefaults({
      cwd: projectRoot,
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        hasUI: true,
        confirm: () => {
          prompts += 1;
          return true;
        },
      },
    });

    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((w) => w.includes("Session identity")));
    assert.equal(prompts, 0);
  });

  it("loads successfully when trust store grants access", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(result.defaults !== undefined);
  });

  it("uses trustOverride=false to deny without consulting trust store", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "explicit-denial",
      trust: {
        trustOverride: false,
        hasTrustRequiringProjectResources: () => false,
        trustStore: { getEntry: () => ({ path: fs.realpathSync(projectRoot), decision: true }) },
      },
    });
    assert.equal(result.status, "denied");
  });
});

// ---------------------------------------------------------------------------
// File absence
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — file absence", () => {
  it("returns loaded with empty defaults when .tlh/ directory does not exist", async () => {
    const projectRoot = tempProject();
    // No .tlh directory at all
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults, { primaryAgents: {}, subagents: {} });
    assert.deepEqual(result.warnings, []);
  });

  it("returns loaded with empty defaults when .tlh/ exists but defaults.json does not", async () => {
    const projectRoot = tempProject();
    fs.mkdirSync(path.join(projectRoot, ".tlh"));
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults, { primaryAgents: {}, subagents: {} });
    assert.deepEqual(result.warnings, []);
  });

  it("does not consult trust services when the defaults file is absent", async () => {
    const projectRoot = tempProject();
    let trustReads = 0;
    let prompts = 0;
    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "absent-defaults-no-trust",
      trust: {
        trustStore: {
          getEntry: () => {
            trustReads += 1;
            return null;
          },
        },
        hasTrustRequiringProjectResources: () => {
          trustReads += 1;
          return true;
        },
        hasUI: true,
        confirm: () => {
          prompts += 1;
          return true;
        },
      },
    });

    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults, { primaryAgents: {}, subagents: {} });
    assert.equal(trustReads, 0);
    assert.equal(prompts, 0);
  });
});

// ---------------------------------------------------------------------------
// Project-configuration trust flow and trust-plane isolation
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — project-configuration trust", () => {
  it("prompts only for defaults and loads a defaults-only project", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    let prompts = 0;
    let promptTitle = "";
    let promptMessage = "";
    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "defaults-only-interactive",
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        isProjectTrusted: () => true,
        hasUI: true,
        confirm: (_root) => {
          prompts += 1;
          return true;
        },
        ui: {
          confirm: (title, message) => {
            promptTitle = title;
            promptMessage = message;
            return true;
          },
        },
      },
    });

    assert.equal(result.status, "loaded");
    assert.equal(result.trust?.kind, "project-config");
    assert.equal(result.trust?.source, "session-positive");
    assert.deepEqual(result.defaults?.primaryAgents.architect, { effort: "high" });
    assert.equal(prompts, 1);
    assert.equal(promptTitle, "");
    assert.equal(promptMessage, "");

    const uiResult = await resolveProjectConfigTrust(projectRoot, {
      sessionId: "defaults-prompt-copy",
      trustStore: { getEntry: () => null },
      hasTrustRequiringProjectResources: () => false,
      hasUI: true,
      ui: {
        confirm: (title, message) => {
          promptTitle = title;
          promptMessage = message;
          return true;
        },
      },
    });
    assert.equal(uiResult.source, "session-positive");
    assert.match(promptTitle, /defaults/i);
    assert.match(promptMessage, /defaults\.json/);
    assert.match(promptMessage, /custom agents require persisted \/trust authorization/i);
  });

  it("caches session configuration approval without sharing it with agent trust", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    let prompts = 0;
    const trust = {
      trustStore: { getEntry: () => null },
      hasTrustRequiringProjectResources: () => false,
      isProjectTrusted: () => true,
      hasUI: true,
      confirm: () => {
        prompts += 1;
        return prompts === 1;
      },
    };

    const first = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "isolated-session",
      trust,
    });
    const second = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "isolated-session",
      trust,
    });

    assert.equal(first.status, "loaded");
    assert.equal(first.trust?.kind, "project-config");
    assert.equal(first.trust?.source, "session-positive");
    assert.equal(second.status, "loaded");
    assert.equal(second.trust?.source, "session-positive");
    assert.equal(prompts, 1, "the project-config session cache should avoid a second prompt");

    const agentTrust = await resolveProjectAgentTrust(projectRoot, {
      sessionId: "isolated-session",
      trustStore: { getEntry: () => null },
      // These legacy-looking fields must remain inert for the execution plane.
      hasTrustRequiringProjectResources: () => true,
      isProjectTrusted: () => true,
      defaultProjectTrust: "always",
      hasUI: true,
      confirm: () => true,
    } as never);
    assert.equal(agentTrust.kind, "project-agent");
    assert.equal(agentTrust.trusted, false);
    assert.equal(agentTrust.source, "no-persisted-trust");
  });

  it("preserves upstream, default, denial, and session-cache configuration semantics", async () => {
    const projectRoot = tempProject();
    const canonicalRoot = fs.realpathSync(projectRoot);
    const noPersistedTrust = { trustStore: { getEntry: () => null } };

    const savedPositive = await resolveProjectConfigTrust(projectRoot, {
      trustStore: { getEntry: () => ({ path: canonicalRoot, decision: true }) },
      defaultProjectTrust: "never",
    });
    assert.deepEqual(savedPositive, {
      kind: "project-config",
      trusted: true,
      source: "saved-positive",
    });

    const savedNegative = await resolveProjectConfigTrust(projectRoot, {
      trustStore: { getEntry: () => ({ path: canonicalRoot, decision: false }) },
      defaultProjectTrust: "always",
    });
    assert.deepEqual(savedNegative, {
      kind: "project-config",
      trusted: false,
      source: "saved-negative",
    });

    const upstream = await resolveProjectConfigTrust(projectRoot, {
      ...noPersistedTrust,
      hasTrustRequiringProjectResources: () => true,
      isProjectTrusted: () => true,
    });
    assert.deepEqual(upstream, {
      kind: "project-config",
      trusted: true,
      source: "upstream-positive",
    });

    const always = await resolveProjectConfigTrust(projectRoot, {
      ...noPersistedTrust,
      defaultProjectTrust: "always",
    });
    assert.deepEqual(always, { kind: "project-config", trusted: true, source: "default-always" });

    const never = await resolveProjectConfigTrust(projectRoot, {
      ...noPersistedTrust,
      defaultProjectTrust: "never",
    });
    assert.deepEqual(never, { kind: "project-config", trusted: false, source: "default-never" });

    const explicitlyDenied = await resolveProjectConfigTrust(projectRoot, {
      ...noPersistedTrust,
      trustOverride: false,
      defaultProjectTrust: "always",
    });
    assert.deepEqual(explicitlyDenied, {
      kind: "project-config",
      trusted: false,
      source: "explicit-negative",
    });

    let prompts = 0;
    const sessionOptions = {
      ...noPersistedTrust,
      sessionId: "config-negative-cache",
      hasUI: true,
      confirm: () => {
        prompts += 1;
        return false;
      },
    };
    const denied = await resolveProjectConfigTrust(projectRoot, sessionOptions);
    const cachedDenied = await resolveProjectConfigTrust(projectRoot, {
      ...sessionOptions,
      confirm: () => {
        prompts += 1;
        return true;
      },
    });
    assert.equal(denied.source, "session-negative");
    assert.equal(cachedDenied.source, "session-negative");
    assert.equal(prompts, 1);
  });

  it("fails closed when the interactive decision denies defaults", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    let prompts = 0;
    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "defaults-denied-interactive",
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        isProjectTrusted: () => true,
        hasUI: true,
        confirm: () => {
          prompts += 1;
          return false;
        },
      },
    });

    assert.equal(result.status, "denied");
    assert.equal(result.trust?.kind, "project-config");
    assert.equal(result.trust?.source, "session-negative");
    assert.equal(result.defaults, undefined);
    assert.equal(prompts, 1);
  });

  it("fails closed when no interactive UI is available", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "defaults-no-ui",
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        isProjectTrusted: () => true,
        hasUI: false,
        confirm: () => {
          throw new Error("must not prompt without UI");
        },
      },
    });

    assert.equal(result.status, "denied");
    assert.equal(result.trust?.kind, "project-config");
    assert.equal(result.trust?.source, "session-unavailable");
    assert.equal(result.defaults, undefined);
  });

  it("fails closed when the trust UI times out", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "defaults-timeout",
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        isProjectTrusted: () => true,
        hasUI: true,
        trustUiTimeoutMs: 10,
        ui: { confirm: () => new Promise<boolean>(() => {}) },
      },
    });

    assert.equal(result.status, "denied");
    assert.equal(result.trust?.kind, "project-config");
    assert.equal(result.trust?.source, "session-unavailable");
    assert.equal(result.defaults, undefined);
  });
});

// ---------------------------------------------------------------------------
// Unsafe path conditions (fail-closed)
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — symlink rejection", () => {
  it("returns unavailable without prompting when .tlh is a symlink", async () => {
    const projectRoot = tempProject();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-symlink-target-"));
    tempDirs.push(target);
    const tlhPath = path.join(projectRoot, ".tlh");
    fs.symlinkSync(target, tlhPath);
    let prompts = 0;

    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "unsafe-tlh-symlink",
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        hasUI: true,
        confirm: () => {
          prompts += 1;
          return true;
        },
      },
      fileSystem: REAL_FS,
    });
    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((w) => w.includes("symlink") || w.includes(".tlh")));
    assert.equal(prompts, 0);
  });

  it("returns unavailable without prompting when .tlh is not a directory", async () => {
    const projectRoot = tempProject();
    fs.writeFileSync(path.join(projectRoot, ".tlh"), "not a directory", "utf8");
    let prompts = 0;

    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "unsafe-tlh-file",
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        hasUI: true,
        confirm: () => {
          prompts += 1;
          return true;
        },
      },
    });
    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((w) => w.includes(".tlh")));
    assert.equal(prompts, 0);
  });

  it("returns unavailable without prompting when defaults.json is a symlink", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "medium" } } });

    // Use realpathSync so the path matches what the loader sees after canonicalization.
    const canonicalRoot = fs.realpathSync(projectRoot);
    const filePath = path.join(canonicalRoot, PROJECT_DEFAULTS_FILE);
    const fakeFsWithSymlink = fileSystemWithSymlinkAt(REAL_FS, filePath);
    let prompts = 0;

    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "unsafe-defaults-symlink",
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        hasUI: true,
        confirm: () => {
          prompts += 1;
          return true;
        },
      },
      fileSystem: fakeFsWithSymlink,
    });
    assert.equal(result.status, "unavailable");
    assert.ok(
      result.warnings.some((w) => w.toLowerCase().includes("symlink")),
      `Expected symlink warning, got: ${result.warnings.join("; ")}`,
    );
    assert.equal(prompts, 0);
  });

  it("returns unavailable without prompting when defaults.json is not a regular file", async () => {
    const projectRoot = tempProject();
    fs.mkdirSync(path.join(projectRoot, ".tlh", "defaults.json"), { recursive: true });
    let prompts = 0;

    const result = await loadProjectDefaults({
      cwd: projectRoot,
      sessionId: "unsafe-defaults-directory",
      trust: {
        trustStore: { getEntry: () => null },
        hasTrustRequiringProjectResources: () => false,
        hasUI: true,
        confirm: () => {
          prompts += 1;
          return true;
        },
      },
    });
    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((w) => w.includes("regular file")));
    assert.equal(prompts, 0);
  });
});

describe("loadProjectDefaults — file size limit", () => {
  it("returns unavailable when defaults.json exceeds the size limit", async () => {
    const projectRoot = tempProject();
    const tlhDir = path.join(projectRoot, ".tlh");
    fs.mkdirSync(tlhDir);
    const oversized = "x".repeat(MAX_PROJECT_DEFAULTS_FILE_BYTES + 1);
    fs.writeFileSync(path.join(tlhDir, "defaults.json"), oversized, "utf8");

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      maxFileBytes: MAX_PROJECT_DEFAULTS_FILE_BYTES,
    });
    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((w) => w.includes("size")));
  });

  it("respects a custom maxFileBytes override", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "low" } } });

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      maxFileBytes: 5, // very small — will be exceeded
    });
    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((w) => w.includes("size")));
  });
});

// ---------------------------------------------------------------------------
// Stable descriptor reads
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — descriptor reads", () => {
  it("opens the canonical defaults file read-only with O_NOFOLLOW", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);
    const maxFileBytes = 1024;
    let openedPath: string | undefined;
    let openedFlags: number | undefined;
    let largestRead = 0;
    const fileSystem = descriptorFileSystem(
      {
        ...REAL_FS,
        readSync: (descriptor, buffer, offset, length, position) => {
          largestRead = Math.max(largestRead, length);
          return REAL_FS.readSync!(descriptor, buffer, offset, length, position);
        },
      },
      undefined,
      (openedFilePath, flags) => {
        openedPath = openedFilePath;
        openedFlags = flags;
      },
    );

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
      maxFileBytes,
    });

    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults?.primaryAgents.architect, { effort: "high" });
    assert.equal(openedPath, fs.realpathSync(filePath));
    assert.equal(openedFlags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    assert.ok(largestRead <= maxFileBytes + 1);
  });

  it("rejects an in-window large replacement before reading its bytes", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const filePath = path.join(fs.realpathSync(projectRoot), PROJECT_DEFAULTS_FILE);
    const backupPath = `${filePath}.old`;
    let replacementDone = false;
    let readCalls = 0;
    const fileSystem = descriptorFileSystem(
      {
        ...REAL_FS,
        openSync: (openedFilePath, flags) => {
          if (!replacementDone && path.resolve(openedFilePath) === path.resolve(filePath)) {
            replacementDone = true;
            fs.renameSync(filePath, backupPath);
            fs.writeFileSync(filePath, "x".repeat(MAX_PROJECT_DEFAULTS_FILE_BYTES + 1), "utf8");
          }
          return REAL_FS.openSync!(openedFilePath, flags);
        },
      },
      () => {
        readCalls += 1;
      },
    );

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
    });

    assert.equal(result.status, "unavailable");
    assert.equal(readCalls, 0, "a replacement larger than the bound must not be read");
    assert.ok(
      result.warnings.some((warning) => /changed before reading|exceeds maximum/.test(warning)),
      `Expected bounded replacement warning; got: ${result.warnings.join("; ")}`,
    );
  });

  it("rejects a descriptor read that reaches the sentinel bound", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {});
    const maxFileBytes = 32;
    let largestRead = 0;
    let readCalls = 0;
    const fileSystem = descriptorFileSystem(
      {
        ...REAL_FS,
        readSync: (_descriptor, buffer, _offset, length) => {
          readCalls += 1;
          largestRead = Math.max(largestRead, length);
          buffer.fill(0x78);
          return length;
        },
      },
      undefined,
    );

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
      maxFileBytes,
    });

    assert.equal(result.status, "unavailable");
    assert.equal(readCalls, 1);
    assert.equal(largestRead, maxFileBytes + 1);
    assert.ok(result.warnings.some((warning) => warning.includes("exceeds maximum")));
  });

  it("fails closed when O_NOFOLLOW is unavailable", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    let openCalls = 0;
    const fileSystem = descriptorFileSystem(
      { ...REAL_FS, noFollowFlag: undefined },
      undefined,
      () => {
        openCalls += 1;
      },
    );

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
    });

    assert.equal(result.status, "unavailable");
    assert.equal(openCalls, 0);
    assert.ok(result.warnings.some((warning) => warning.includes("O_NOFOLLOW")));
  });

  it("fails closed when the no-follow descriptor open fails", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const fileSystem = descriptorFileSystem({
      ...REAL_FS,
      openSync: () => {
        const error = new Error("symlink appeared") as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      },
    });

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
    });

    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((warning) => warning.includes("changed before reading")));
  });

  it("closes a descriptor when post-open identity validation rejects it", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    let readCalls = 0;
    let closeCalls = 0;
    let fstatCalls = 0;
    const fileSystem = descriptorFileSystem(
      {
        ...REAL_FS,
        fstatSync: (descriptor) => {
          const stat = REAL_FS.fstatSync!(descriptor);
          fstatCalls += 1;
          return fstatCalls === 1 ? cloneStatsWithIdentity(stat, stat.dev, stat.ino + 1) : stat;
        },
      },
      () => {
        readCalls += 1;
      },
      undefined,
      () => {
        closeCalls += 1;
      },
    );

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
    });

    assert.equal(result.status, "unavailable");
    assert.equal(readCalls, 0);
    assert.equal(closeCalls, 1);
    assert.ok(result.warnings.some((warning) => warning.includes("changed before reading")));
  });

  it("rejects a fixed .tlh directory identity change after reading", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const tlhPath = path.join(fs.realpathSync(projectRoot), ".tlh");
    let readStarted = false;
    const fileSystem = descriptorFileSystem(
      {
        ...REAL_FS,
        lstatSync: (filePath) => {
          const stat = REAL_FS.lstatSync(filePath);
          return readStarted && path.resolve(filePath) === path.resolve(tlhPath)
            ? cloneStatsWithIdentity(stat, stat.dev, stat.ino + 1)
            : stat;
        },
      },
      (filePath) => {
        if (path.basename(filePath) === "defaults.json") readStarted = true;
      },
    );

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
    });

    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.some((warning) => warning.includes("changed while reading")));
  });
});

// ---------------------------------------------------------------------------
// TOCTOU checks
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — pre-read identity checks", () => {
  it("rejects a same-size replacement before reading and applies no content", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);
    let readCalls = 0;
    const fileSystem = fileSystemWithBeforeReadStat(
      REAL_FS,
      filePath,
      (stat) => Object.create(stat, { ino: { value: Number(stat.ino) + 1 } }),
      () => {
        readCalls += 1;
      },
    );

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
    });

    assert.equal(result.status, "unavailable");
    assert.equal(readCalls, 0, "pre-read identity replacement must not read content");
    assert.ok(
      result.warnings.some((warning) => warning.includes("changed before reading")),
      `Expected pre-read replacement warning; got: ${result.warnings.join("; ")}`,
    );
  });
});

describe("loadProjectDefaults — post-read identity checks", () => {
  it("rejects a same-size replacement after the pre-read lstat", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);
    const fileSystem = fileSystemWithPostReadStat(REAL_FS, filePath, (stat) =>
      Object.create(stat, { ino: { value: Number(stat.ino) + 1 } }),
    );

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
    });

    assert.equal(result.status, "unavailable");
    assert.ok(
      result.warnings.some((warning) => warning.includes("changed while reading")),
      `Expected same-size replacement warning; got: ${result.warnings.join("; ")}`,
    );
  });

  it("rejects a regular-file-to-symlink swap after the pre-read lstat", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { architect: { effort: "high" } } });
    const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);
    const fileSystem = fileSystemWithPostReadStat(REAL_FS, filePath, (stat) =>
      Object.create(stat, {
        isSymbolicLink: { value: () => true },
        isFile: { value: () => false },
        isDirectory: { value: () => false },
      }),
    );

    const result = await loadProjectDefaults({
      ...trustedOptions(projectRoot),
      fileSystem,
    });

    assert.equal(result.status, "unavailable");
    assert.ok(
      result.warnings.some((warning) => warning.includes("became a symlink")),
      `Expected symlink-swap warning; got: ${result.warnings.join("; ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — malformed JSON", () => {
  it("warns and returns empty defaults on invalid JSON", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, "not valid json {{{");
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults, { primaryAgents: {}, subagents: {} });
    assert.ok(result.warnings.some((w) => w.includes("not valid JSON")));
  });

  it("warns and returns empty defaults when top-level is a JSON array", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, "[1, 2, 3]");
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults, { primaryAgents: {}, subagents: {} });
    assert.ok(result.warnings.some((w) => w.includes("JSON object at the top level")));
  });

  it("warns and returns empty defaults when top-level is a JSON string", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, '"hello"');
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults, { primaryAgents: {}, subagents: {} });
    assert.ok(result.warnings.some((w) => w.includes("JSON object")));
  });
});

// ---------------------------------------------------------------------------
// Warning bounds
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — warning bounds", () => {
  it("truncates file-controlled warning strings", async () => {
    const projectRoot = tempProject();
    const longRole = `unknown-${"x".repeat(50_000)}`;
    writeDefaults(projectRoot, {
      primaryAgents: {
        [longRole]: { effort: "high" },
        architect: { effort: "low" },
      },
    });

    const result = await loadProjectDefaults(trustedOptions(projectRoot));

    assert.equal(result.status, "loaded");
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.length, MAX_PROJECT_DEFAULT_WARNING_LENGTH);
    assert.ok(result.warnings[0]?.endsWith("…"));
    assert.deepEqual(result.defaults?.primaryAgents.architect, { effort: "low" });
  });

  it("bounds file-controlled warnings while retaining valid entries", async () => {
    const projectRoot = tempProject();
    const primaryAgents: Record<string, unknown> = {
      architect: { effort: "high" },
    };
    const subagents: Record<string, unknown> = {};
    for (let index = 0; index < 3000; index += 1) {
      primaryAgents[`p${index.toString(36)}`] = {};
      subagents[`s${index.toString(36)}`] = {};
    }
    const content = JSON.stringify({ primaryAgents, subagents });
    assert.ok(Buffer.byteLength(content, "utf8") <= MAX_PROJECT_DEFAULTS_FILE_BYTES);
    writeDefaults(projectRoot, content);

    const result = await loadProjectDefaults(trustedOptions(projectRoot));

    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults?.primaryAgents.architect, { effort: "high" });
    assert.equal(result.warnings.length, MAX_PROJECT_DEFAULT_WARNINGS + 1);
    assert.ok(
      result.warnings.every((warning) => warning.length <= MAX_PROJECT_DEFAULT_WARNING_LENGTH),
    );
    const summaries = result.warnings.filter((warning) => warning.includes("more issues in"));
    assert.equal(summaries.length, 1);
    assert.ok(
      summaries[0]?.includes("5980"),
      `Expected deterministic summary, got: ${summaries[0]}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Happy-path schema parsing
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — valid schema", () => {
  it("parses a complete valid defaults file", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      primaryAgents: {
        architect: { model: "anthropic/claude-opus-5", effort: "max" },
        rush: { effort: "low" },
      },
      subagents: {
        developer: { model: "openai-codex/gpt-5.6-sol" },
        "test-runner": { model: "openai-codex/gpt-5.6-luna", effort: "low" },
        "code-reviewer": { effort: "medium" },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.warnings, []);
    assert.ok(result.defaults !== undefined);
    assert.deepEqual(result.defaults.primaryAgents.architect, {
      model: "anthropic/claude-opus-5",
      effort: "max",
    });
    assert.deepEqual(result.defaults.primaryAgents.rush, { effort: "low" });
    assert.deepEqual(result.defaults.subagents.developer, {
      model: "openai-codex/gpt-5.6-sol",
    });
    assert.deepEqual(result.defaults.subagents["test-runner"], {
      model: "openai-codex/gpt-5.6-luna",
      effort: "low",
    });
    assert.deepEqual(result.defaults.subagents["code-reviewer"], { effort: "medium" });
  });

  it("accepts model-only entries", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { subagents: { oracle: { model: "anthropic/claude-sonnet-5" } } });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults?.subagents.oracle, { model: "anthropic/claude-sonnet-5" });
  });

  it("accepts effort-only entries", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, { primaryAgents: { "bug-hunter": { effort: "xhigh" } } });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults?.primaryAgents["bug-hunter"], { effort: "xhigh" });
  });

  it("returns loaded with empty maps when the file has no recognized sections", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {});
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.defaults, { primaryAgents: {}, subagents: {} });
    assert.deepEqual(result.warnings, []);
  });
});

// ---------------------------------------------------------------------------
// Unknown roles
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — unknown role names", () => {
  it("warns and ignores an unknown primary agent name, keeps valid entries", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      primaryAgents: {
        unknown_primary: { effort: "high" },
        architect: { effort: "medium" },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(
      result.warnings.some((w) => w.includes("unknown_primary")),
      `Expected warning about unknown_primary; got: ${result.warnings.join("; ")}`,
    );
    assert.deepEqual(result.defaults?.primaryAgents.architect, { effort: "medium" });
    assert.ok(result.defaults?.primaryAgents["unknown_primary" as never] === undefined);
  });

  it("warns and ignores an unknown subagent role, keeps valid entries", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      subagents: {
        "phantom-agent": { effort: "low" },
        developer: { effort: "high" },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(result.warnings.some((w) => w.includes("phantom-agent")));
    assert.deepEqual(result.defaults?.subagents.developer, { effort: "high" });
  });
});

// ---------------------------------------------------------------------------
// Unknown keys
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — unknown keys", () => {
  it("warns and ignores an entry with an unknown key", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      primaryAgents: {
        rush: { effort: "medium", temperature: 0.5 }, // unknown key
        architect: { effort: "low" },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(
      result.warnings.some((w) => w.includes("temperature") || w.includes("unknown key")),
      `Expected unknown-key warning; got: ${result.warnings.join("; ")}`,
    );
    // rush entry is ignored; architect is intact
    assert.ok(result.defaults?.primaryAgents.rush === undefined);
    assert.deepEqual(result.defaults?.primaryAgents.architect, { effort: "low" });
  });

  it("warns and ignores an entry with multiple unknown keys", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      subagents: {
        librarian: { effort: "low", maxTokens: 1000, debug: true },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(result.warnings.some((w) => w.includes("unknown key")));
    assert.ok(result.defaults?.subagents.librarian === undefined);
  });
});

// ---------------------------------------------------------------------------
// Invalid model values
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — invalid model values", () => {
  it("warns and ignores an entry with an empty model string", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      subagents: {
        oracle: { model: "" },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(
      result.warnings.some((w) => w.includes("model") && w.includes("provider/model")),
      `Expected model warning; got: ${result.warnings.join("; ")}`,
    );
    assert.ok(result.defaults?.subagents.oracle === undefined);
  });

  it("warns and ignores an entry with a non-string model", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      primaryAgents: {
        product: { model: 42 },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(result.warnings.some((w) => w.includes("model")));
    assert.ok(result.defaults?.primaryAgents.product === undefined);
  });

  it("warns and ignores malformed references without leaking effort", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      primaryAgents: {
        product: { model: "not-a-model-ref", effort: "high" },
      },
      subagents: {
        oracle: { model: "openrouter/anthropic/claude-sonnet-5" },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(
      result.warnings.some((w) => w.includes("model") && w.includes("provider/model")),
      `Expected model-reference warning; got: ${result.warnings.join("; ")}`,
    );
    assert.equal(result.defaults?.primaryAgents.product, undefined);
    assert.deepEqual(result.defaults?.subagents.oracle, {
      model: "openrouter/anthropic/claude-sonnet-5",
    });
  });
});

// ---------------------------------------------------------------------------
// Invalid effort values
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — invalid effort values", () => {
  it("warns and ignores an entry with an unknown effort value", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      primaryAgents: {
        architect: { effort: "ultra" },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(
      result.warnings.some((w) => w.includes("effort") && w.includes("case-sensitive")),
      `Expected effort warning; got: ${result.warnings.join("; ")}`,
    );
    assert.ok(result.defaults?.primaryAgents.architect === undefined);
  });

  it("warns and ignores a non-string effort value", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      subagents: {
        "web-scout": { effort: 3 },
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(result.warnings.some((w) => w.includes("effort")));
    assert.ok(result.defaults?.subagents["web-scout"] === undefined);
  });
});

// ---------------------------------------------------------------------------
// Effort vocabulary case-sensitivity
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — effort case-sensitivity", () => {
  const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const invalidCasings = [
    "Off",
    "Minimal",
    "Low",
    "Medium",
    "High",
    "Xhigh",
    "Max",
    "MEDIUM",
    "HIGH",
    "MAX",
  ];

  for (const level of validLevels) {
    it(`accepts lowercase effort "${level}"`, async () => {
      const projectRoot = tempProject();
      writeDefaults(projectRoot, { subagents: { developer: { effort: level } } });
      const result = await loadProjectDefaults(trustedOptions(projectRoot));
      assert.equal(result.status, "loaded");
      assert.equal(result.defaults?.subagents.developer?.effort, level);
      assert.deepEqual(result.warnings, []);
    });
  }

  for (const bad of invalidCasings) {
    it(`rejects wrong-case effort "${bad}"`, async () => {
      const projectRoot = tempProject();
      writeDefaults(projectRoot, { primaryAgents: { architect: { effort: bad } } });
      const result = await loadProjectDefaults(trustedOptions(projectRoot));
      assert.equal(result.status, "loaded");
      assert.ok(
        result.warnings.some((w) => w.includes("effort") && w.includes("case-sensitive")),
        `Expected case-sensitivity warning for "${bad}"; got: ${result.warnings.join("; ")}`,
      );
      assert.ok(result.defaults?.primaryAgents.architect === undefined);
    });
  }
});

// ---------------------------------------------------------------------------
// Empty entry (no model or effort)
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — entry with no fields", () => {
  it("warns and ignores an empty entry object", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      subagents: { contrarian: {} },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(
      result.warnings.some((w) => w.includes("at least one")),
      `Expected 'at least one' warning; got: ${result.warnings.join("; ")}`,
    );
    assert.ok(result.defaults?.subagents.contrarian === undefined);
  });
});

// ---------------------------------------------------------------------------
// Section-level schema errors
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — section-level schema errors", () => {
  it("warns and ignores primaryAgents section when it is an array", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      primaryAgents: [{ effort: "low" }],
      subagents: { developer: { effort: "medium" } },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(result.warnings.some((w) => w.includes("primaryAgents")));
    // subagents should still be parsed
    assert.deepEqual(result.defaults?.subagents.developer, { effort: "medium" });
  });

  it("warns and ignores subagents section when it is not an object", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      subagents: "not-an-object",
      primaryAgents: { architect: { effort: "high" } },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.ok(result.warnings.some((w) => w.includes("subagents")));
    // primaryAgents should still be parsed
    assert.deepEqual(result.defaults?.primaryAgents.architect, { effort: "high" });
  });
});

// ---------------------------------------------------------------------------
// Multiple warnings (partial apply)
// ---------------------------------------------------------------------------

describe("loadProjectDefaults — partial application across entries", () => {
  it("skips invalid entries and applies valid ones in the same file", async () => {
    const projectRoot = tempProject();
    writeDefaults(projectRoot, {
      primaryAgents: {
        architect: { effort: "high" },
        rush: { effort: "WRONG_CASE" }, // rejected
        product: { unknownKey: "value" }, // rejected
        "bug-hunter": { model: "anthropic/claude-opus-5", effort: "max" },
      },
      subagents: {
        developer: { effort: "medium" },
        "fake-role": { effort: "low" }, // rejected
      },
    });
    const result = await loadProjectDefaults(trustedOptions(projectRoot));
    assert.equal(result.status, "loaded");
    assert.equal(result.warnings.length, 3); // rush, product, fake-role
    assert.deepEqual(result.defaults?.primaryAgents.architect, { effort: "high" });
    assert.deepEqual(result.defaults?.primaryAgents["bug-hunter"], {
      model: "anthropic/claude-opus-5",
      effort: "max",
    });
    assert.deepEqual(result.defaults?.subagents.developer, { effort: "medium" });
    assert.ok(result.defaults?.primaryAgents.rush === undefined);
    assert.ok(result.defaults?.primaryAgents.product === undefined);
  });
});
