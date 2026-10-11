import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { readDefaultExtensions } from "../scripts/lib/default-extensions.mjs";
import {
  evaluateMcpAdapterCutover,
  mcpAdapterStartupGuardNotice,
} from "../scripts/lib/mcp-adapter-cutover.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const defaultsPath = join(repoRoot, "config", "default-extensions.json");
const guardPath = join(repoRoot, "scripts", "lib", "mcp-adapter-cutover.mjs");
const mcporter = readDefaultExtensions(defaultsPath).find((entry) => entry.id === "mcporter");
assert.ok(mcporter, "the bundled mcporter manifest entry must exist");
const source = "npm:@diegopetrucci/pi-mcp-adapter";
const legacyPin = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
const nativePin = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tlh-mcp-adapter-paths-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  return { root, agentDir };
}

function writeMetadata(agentDir, version) {
  const packageDir = join(agentDir, "npm", "node_modules", "@diegopetrucci", "pi-mcp-adapter");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version }, null, 2)}\n`,
  );
}

test("startup guard distinguishes missing, warm legacy, and native metadata", () => {
  for (const [version, expectedHeld] of [
    [undefined, true],
    ["2.36.0", false],
    ["5.0.0", false],
  ]) {
    const { root, agentDir } = fixture();
    try {
      if (version) writeMetadata(agentDir, version);
      const decision = evaluateMcpAdapterCutover({ packages: [source] }, mcporter, {
        agentDir,
        homeDir: join(root, "home"),
      });
      assert.equal(Boolean(mcpAdapterStartupGuardNotice(decision)), expectedHeld, version);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("startup guard admits only verified warm git checkouts and bounded npm ranges", () => {
  const { root, agentDir } = fixture();
  try {
    const gitSource = "git:github.com/diegopetrucci/pi-mcp-adapter@main";
    const gitDir = join(agentDir, "git", "github.com", "diegopetrucci", "pi-mcp-adapter");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(gitDir, "package.json"),
      `${JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: "5.0.0" }, null, 2)}\n`,
    );
    const gitDecision = evaluateMcpAdapterCutover({ packages: [gitSource] }, mcporter, {
      agentDir,
      homeDir: join(root, "home"),
    });
    assert.equal(mcpAdapterStartupGuardNotice(gitDecision), undefined);

    const rangeSource = "npm:@diegopetrucci/pi-mcp-adapter@^5.0.0";
    writeMetadata(agentDir, "5.2.0");
    const rangeDecision = evaluateMcpAdapterCutover({ packages: [rangeSource] }, mcporter, {
      agentDir,
      homeDir: join(root, "home"),
    });
    assert.equal(mcpAdapterStartupGuardNotice(rangeDecision), undefined);
    writeMetadata(agentDir, "6.0.0");
    const incompatibleDecision = evaluateMcpAdapterCutover({ packages: [rangeSource] }, mcporter, {
      agentDir,
      homeDir: join(root, "home"),
    });
    assert.match(mcpAdapterStartupGuardNotice(incompatibleDecision), /launch held/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup guard rejects cache metadata that escapes the managed profile root", () => {
  const { root, agentDir } = fixture();
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeMetadata(outside, "5.0.0");
  symlinkSync(join(outside, "npm"), join(agentDir, "npm"), "dir");
  try {
    const decision = evaluateMcpAdapterCutover({ packages: [source] }, mcporter, {
      agentDir,
      homeDir: join(root, "home"),
    });
    assert.equal(decision.selected[0]?.metadata.kind, "invalid");
    assert.match(mcpAdapterStartupGuardNotice(decision), /launch held/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper guard includes current-project settings without changing project trust", () => {
  const { root, agentDir } = fixture();
  const project = join(root, "project");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(
    join(project, ".pi", "settings.json"),
    `${JSON.stringify({ packages: [source] }, null, 2)}\n`,
  );
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [] })}\n`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        guardPath,
        "--startup-guard",
        "--agent-dir",
        agentDir,
        "--defaults",
        defaultsPath,
        "--cwd",
        project,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /launch held/);
    assert.doesNotMatch(result.stderr, /pi-mcp-adapter/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup guard follows SDK project dedupe and autoload delta bases", () => {
  const { root, agentDir } = fixture();
  const project = join(root, "project");
  const projectSettingsDir = join(project, ".pi");
  mkdirSync(projectSettingsDir, { recursive: true });
  const runGuard = () =>
    spawnSync(
      process.execPath,
      [
        guardPath,
        "--startup-guard",
        "--agent-dir",
        agentDir,
        "--defaults",
        defaultsPath,
        "--cwd",
        project,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
    );
  try {
    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [] })}\n`);
    writeFileSync(
      join(projectSettingsDir, "settings.json"),
      `${JSON.stringify({ packages: [{ source, autoload: false }] })}\n`,
    );
    const projectOnly = runGuard();
    assert.equal(projectOnly.status, 1);
    assert.match(projectOnly.stderr, /launch held/);

    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [source] })}\n`);
    const unsafeGlobalBase = runGuard();
    assert.equal(unsafeGlobalBase.status, 1);
    assert.match(unsafeGlobalBase.stderr, /launch held/);

    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ packages: [legacyPin] })}\n`,
    );
    const safeLegacyGlobalBase = runGuard();
    assert.equal(safeLegacyGlobalBase.status, 0, safeLegacyGlobalBase.stderr);

    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [source] })}\n`);
    writeFileSync(
      join(projectSettingsDir, "settings.json"),
      `${JSON.stringify({ packages: [nativePin] })}\n`,
    );
    const nativeProjectOverride = runGuard();
    assert.equal(nativeProjectOverride.status, 0, nativeProjectOverride.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup guard treats only confirmed ENOENT settings as absent", () => {
  const { root, agentDir } = fixture();
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [nativePin] })}\n`);
  try {
    const missingProject = spawnSync(
      process.execPath,
      [
        guardPath,
        "--startup-guard",
        "--agent-dir",
        agentDir,
        "--defaults",
        defaultsPath,
        "--cwd",
        project,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
    );
    assert.equal(missingProject.status, 0, missingProject.stderr);

    const brokenSettings = join(project, ".pi");
    mkdirSync(brokenSettings, { recursive: true });
    symlinkSync(join(root, "does-not-exist.json"), join(brokenSettings, "settings.json"));
    const brokenProject = spawnSync(
      process.execPath,
      [
        guardPath,
        "--startup-guard",
        "--agent-dir",
        agentDir,
        "--defaults",
        defaultsPath,
        "--cwd",
        project,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
    );
    assert.equal(brokenProject.status, 1);
    assert.match(brokenProject.stderr, /launch held/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Symlinked settings regression tests (pma-ru86 fix B)
// ---------------------------------------------------------------------------

test("startup guard follows a valid symlinked project settings file with no adapter entry", () => {
  const { root, agentDir } = fixture();
  const project = join(root, "project");
  const settingsTarget = join(root, "target-settings.json");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [nativePin] })}\n`);
  writeFileSync(settingsTarget, `${JSON.stringify({ packages: [] })}\n`);
  symlinkSync(settingsTarget, join(project, ".pi", "settings.json"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        guardPath,
        "--startup-guard",
        "--agent-dir",
        agentDir,
        "--defaults",
        defaultsPath,
        "--cwd",
        project,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup guard evaluates a symlinked settings file that selects the native adapter", () => {
  // Case 1: symlinked project settings with native pin passes
  {
    const { root, agentDir } = fixture();
    const project = join(root, "project");
    const settingsTarget = join(root, "target-settings.json");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [] })}\n`);
    writeFileSync(settingsTarget, `${JSON.stringify({ packages: [nativePin] })}\n`);
    symlinkSync(settingsTarget, join(project, ".pi", "settings.json"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          guardPath,
          "--startup-guard",
          "--agent-dir",
          agentDir,
          "--defaults",
          defaultsPath,
          "--cwd",
          project,
        ],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
      );
      // native v5 pin is safe — guard should pass
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Case 2: symlinked profile settings with unpinned source, no cached metadata
  // The file must be read through the link; the hold comes from evaluation, not refusal.
  {
    const { root, agentDir } = fixture();
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const profileTarget = join(root, "profile-settings-target.json");
    writeFileSync(profileTarget, `${JSON.stringify({ packages: [source] })}\n`);
    symlinkSync(profileTarget, join(agentDir, "settings.json"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          guardPath,
          "--startup-guard",
          "--agent-dir",
          agentDir,
          "--defaults",
          defaultsPath,
          "--cwd",
          project,
        ],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
      );
      // unpinned source with no metadata is held by evaluation, not by a refusal
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not safely resolved/);
      assert.doesNotMatch(
        result.stderr,
        /could not verify/,
        "hold must come from evaluation, not from a settings-file refusal",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("startup guard refuses a broken symlink and a symlink to a directory, with the path in stderr", () => {
  const { root, agentDir } = fixture();
  const project = join(root, "project");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [nativePin] })}\n`);
  const settingsLink = join(project, ".pi", "settings.json");

  // Broken symlink
  symlinkSync(join(root, "does-not-exist.json"), settingsLink);
  try {
    const broken = spawnSync(
      process.execPath,
      [
        guardPath,
        "--startup-guard",
        "--agent-dir",
        agentDir,
        "--defaults",
        defaultsPath,
        "--cwd",
        project,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
    );
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /launch held/);
    assert.ok(
      broken.stderr.includes(settingsLink),
      `expected settings path in stderr for broken symlink: ${broken.stderr}`,
    );
  } finally {
    rmSync(settingsLink);
  }

  // Regular file with invalid JSON
  writeFileSync(settingsLink, "{ not valid json {{{\n");
  try {
    const invalidJson = spawnSync(
      process.execPath,
      [
        guardPath,
        "--startup-guard",
        "--agent-dir",
        agentDir,
        "--defaults",
        defaultsPath,
        "--cwd",
        project,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
    );
    assert.equal(invalidJson.status, 1);
    assert.match(invalidJson.stderr, /launch held/);
    assert.ok(
      invalidJson.stderr.includes(settingsLink),
      `expected settings path in stderr for invalid JSON: ${invalidJson.stderr}`,
    );
  } finally {
    rmSync(settingsLink);
  }

  // Symlink to a directory
  const dirTarget = join(root, "a-directory");
  mkdirSync(dirTarget);
  symlinkSync(dirTarget, settingsLink);
  try {
    const dirLink = spawnSync(
      process.execPath,
      [
        guardPath,
        "--startup-guard",
        "--agent-dir",
        agentDir,
        "--defaults",
        defaultsPath,
        "--cwd",
        project,
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } },
    );
    assert.equal(dirLink.status, 1);
    assert.match(dirLink.stderr, /launch held/);
    assert.ok(
      dirLink.stderr.includes(settingsLink),
      `expected settings path in stderr for dir symlink: ${dirLink.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

assert.ok(existsSync(guardPath), "the generated startup guard must exist");
