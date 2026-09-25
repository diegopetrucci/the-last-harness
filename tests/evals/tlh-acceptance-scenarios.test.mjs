import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ACCEPTANCE_MODEL_FORMAT,
  ARCHITECT_ACCEPTANCE_CHECKS,
  BUNDLED_MINOR_ROLES,
  SUBAGENT_ACCEPTANCE_CHECKS,
  createFixtureRepo,
  parseAcceptanceModel,
  prepareArchitectScenario,
  prepareSubagentAcceptanceScenario,
} from "./tlh-acceptance-scenarios.mjs";

function runGit(repoDir, args, env) {
  const result = spawnSync("git", args, {
    cwd: repoDir,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function isolatedGitEnvironment(root, homeDir, baseEnv = process.env) {
  const configDir = join(root, "git-config");
  const xdgConfigHome = join(root, "xdg-config");
  const xdgCacheHome = join(root, "xdg-cache");
  const xdgDataHome = join(root, "xdg-data");
  const xdgStateHome = join(root, "xdg-state");
  for (const path of [configDir, xdgConfigHome, xdgCacheHome, xdgDataHome, xdgStateHome])
    mkdirSync(path, { recursive: true });
  return {
    PATH: baseEnv.PATH || process.env.PATH || "",
    HOME: homeDir,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_CACHE_HOME: xdgCacheHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
    GIT_CONFIG_GLOBAL: join(configDir, "global"),
    GIT_CONFIG_SYSTEM: join(configDir, "system"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Acceptance Test",
    GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
    GIT_COMMITTER_NAME: "Acceptance Test",
    GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
  };
}

function createScenarioContext({ candidate = false, model = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "tlh-acceptance-scenarios-"));
  const homeDir = join(rootDir, "home");
  const workspaceDir = join(rootDir, "workspace");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const attackerRoot = join(rootDir, "attacker");
  const victimRoot = join(rootDir, "victim");
  mkdirSync(join(attackerRoot, "template", "hooks"), { recursive: true });
  const hookSentinel = join(attackerRoot, "hook-ran");
  writeFileSync(
    join(attackerRoot, "template", "hooks", "pre-commit"),
    `#!/bin/sh\nprintf 'hook ran\n' > ${hookSentinel}\n`,
    { mode: 0o755 },
  );
  const attackerConfig = `[core]\n\thooksPath = ${join(attackerRoot, "template", "hooks")}\n[commit]\n\tgpgSign = true\n[init]\n\ttemplateDir = ${join(attackerRoot, "template")}\n[user]\n\tsigningKey = unavailable\n`;
  writeFileSync(join(attackerRoot, "global.gitconfig"), attackerConfig, "utf8");
  writeFileSync(join(attackerRoot, "system.gitconfig"), attackerConfig, "utf8");
  const ctx = {
    rootDir,
    homeDir,
    agentDir: join(rootDir, "agent"),
    binDir: join(rootDir, "bin"),
    workspaceDir,
    wrapperPath: join(rootDir, "bin", "tlh"),
    baseEnv: {
      ...process.env,
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: join(attackerRoot, "global.gitconfig"),
      GIT_CONFIG_SYSTEM: join(attackerRoot, "system.gitconfig"),
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: join(attackerRoot, "template", "hooks"),
      GIT_TEMPLATE_DIR: join(attackerRoot, "template"),
      GIT_DIR: join(victimRoot, ".git"),
      GIT_WORK_TREE: victimRoot,
      GIT_INDEX_FILE: join(victimRoot, "victim.index"),
      GIT_OBJECT_DIRECTORY: join(victimRoot, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(victimRoot, ".git", "objects"),
      GIT_COMMON_DIR: join(victimRoot, ".git"),
    },
    candidateRef: candidate ? "frozen-acceptance-commit" : "",
    acceptanceModel: model ? parseAcceptanceModel("openai-codex/gpt-6-astra:medium") : null,
    candidate: null,
    candidateMetadata: candidate
      ? {
          status: "ready",
          commit: "0123456789abcdef0123456789abcdef01234567",
          packageName: "the-last-harness",
          packageVersion: "0.40.0",
          packageSha256: "a".repeat(64),
          observedRuntimeVersion: "0.85.1",
          validationKind: "local-packed-commit",
        }
      : null,
    artifactPaths: new Set(),
    artifactsByScenario: new Map(),
    redactText: (text) => text,
  };
  const commands = [];
  let installCalls = 0;
  const helpers = {
    ensureInstalled: () => {
      installCalls += 1;
      if (candidate) {
        const candidateRoot = join(rootDir, "candidate");
        ctx.candidate = {
          homeDir: join(candidateRoot, "home"),
          binDir: join(candidateRoot, "bin"),
          tempDir: join(candidateRoot, "tmp"),
          xdgConfigHome: join(candidateRoot, "config"),
          xdgCacheHome: join(candidateRoot, "cache"),
          xdgDataHome: join(candidateRoot, "data"),
          xdgStateHome: join(candidateRoot, "state"),
          xdgRuntimeDir: join(candidateRoot, "runtime"),
          agentDir: join(candidateRoot, "agent"),
          sessionDir: join(candidateRoot, "sessions"),
          npmCacheDir: join(candidateRoot, "npm-cache"),
          npmUserConfigPath: join(candidateRoot, "npmrc"),
          npmGlobalConfigPath: join(candidateRoot, "npm-globalrc"),
          env: { PI_OFFLINE: "1" },
        };
      }
      return { status: "prepared" };
    },
    runCommand: (specification) => {
      commands.push(specification);
      return spawnSync(specification.command, specification.args || [], {
        cwd: specification.cwd,
        env: specification.env,
        encoding: "utf8",
        timeout: specification.timeoutMs,
      });
    },
  };
  return {
    ctx,
    helpers,
    commands,
    getInstallCalls: () => installCalls,
    attackerRoot,
    victimRoot,
    hookSentinel,
  };
}

function cleanupScenarioContext(context) {
  rmSync(context.ctx.rootDir, { recursive: true, force: true });
}

test("acceptance model parser preserves the explicit provider/model/thinking contract", () => {
  const model = parseAcceptanceModel("openai-codex/gpt-6-astra:medium");
  assert.deepEqual(model, {
    raw: "openai-codex/gpt-6-astra:medium",
    provider: "openai-codex",
    model: "gpt-6-astra",
    thinkingLevel: "medium",
  });
  for (const invalid of [
    "gpt-6-astra:medium",
    "openai-codex/gpt-6-astra",
    "openai-codex/gpt-6-astra:turbo",
  ]) {
    assert.throws(
      () => parseAcceptanceModel(invalid),
      new RegExp(ACCEPTANCE_MODEL_FORMAT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("fixture Git setup ignores inherited routing and hook/signing controls", () => {
  const context = createScenarioContext();
  try {
    const { ctx, helpers, victimRoot, hookSentinel } = context;
    const cleanEnv = isolatedGitEnvironment(ctx.rootDir, ctx.homeDir);
    const emptyHooksDir = join(ctx.rootDir, "victim-hooks");
    mkdirSync(victimRoot, { recursive: true });
    mkdirSync(emptyHooksDir, { recursive: true });
    writeFileSync(join(victimRoot, "untouched.txt"), "victim content\n", "utf8");
    runGit(victimRoot, ["init", "-q", "--template="], cleanEnv);
    runGit(victimRoot, ["config", "user.name", "victim"], cleanEnv);
    runGit(victimRoot, ["config", "user.email", "victim@example.invalid"], cleanEnv);
    runGit(victimRoot, ["config", "core.hooksPath", emptyHooksDir], cleanEnv);
    runGit(victimRoot, ["config", "commit.gpgSign", "false"], cleanEnv);
    runGit(victimRoot, ["config", "tag.gpgSign", "false"], cleanEnv);
    runGit(victimRoot, ["add", "--", "untouched.txt"], cleanEnv);
    runGit(
      victimRoot,
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=" + emptyHooksDir,
        "commit",
        "--no-verify",
        "-q",
        "-m",
        "victim baseline",
      ],
      cleanEnv,
    );
    const beforeHead = runGit(victimRoot, ["rev-parse", "HEAD"], cleanEnv);
    const beforeIndex = readFileSync(join(victimRoot, ".git", "index"));
    const redirectedIndexPath = join(victimRoot, "victim.index");
    const beforeRedirectedIndex = existsSync(redirectedIndexPath)
      ? readFileSync(redirectedIndexPath)
      : null;
    const beforeContent = readFileSync(join(victimRoot, "untouched.txt"), "utf8");
    const beforeHookSentinel = existsSync(hookSentinel);

    const fixture = createFixtureRepo(
      ctx,
      "fixture-git-isolation",
      "isolated-fixture",
      { "README.md": "fixture\n" },
      {},
      helpers,
    );
    assert.match(fixture.baselineCommit, /^[0-9a-f]{40}$/);
    assert.equal(fixture.gitEnvironment.GIT_DIR, undefined);
    assert.equal(fixture.gitEnvironment.GIT_WORK_TREE, undefined);
    assert.equal(fixture.gitEnvironment.GIT_INDEX_FILE, undefined);
    assert.equal(fixture.gitEnvironment.GIT_OBJECT_DIRECTORY, undefined);
    assert.notEqual(fixture.gitEnvironment.GIT_CONFIG_GLOBAL, ctx.baseEnv.GIT_CONFIG_GLOBAL);
    assert.equal(existsSync(hookSentinel), false);
    assert.equal(
      runGit(fixture.repoDir, ["config", "--local", "core.hooksPath"], fixture.gitEnvironment),
      "/dev/null",
    );
    assert.equal(
      runGit(fixture.repoDir, ["config", "--local", "commit.gpgSign"], fixture.gitEnvironment),
      "false",
    );
    assert.equal(readFileSync(join(victimRoot, "untouched.txt"), "utf8"), beforeContent);
    assert.deepEqual(readFileSync(join(victimRoot, ".git", "index")), beforeIndex);
    assert.equal(runGit(victimRoot, ["rev-parse", "HEAD"], cleanEnv), beforeHead);
    assert.equal(runGit(victimRoot, ["status", "--short"], cleanEnv), "");
    if (beforeRedirectedIndex === null) assert.equal(existsSync(redirectedIndexPath), false);
    else assert.deepEqual(readFileSync(redirectedIndexPath), beforeRedirectedIndex);
    assert.equal(existsSync(hookSentinel), beforeHookSentinel);
    assert.equal(commandsFor(context, "git-commit").length, 1);
  } finally {
    cleanupScenarioContext(context);
  }
});

function commandsFor(context, label) {
  return context.commands.filter((command) => command.label === label);
}

test("architect acceptance scaffold has stable evidence checks, tickets, and explicit launch model", () => {
  const context = createScenarioContext({ candidate: true, model: true });
  try {
    const { ctx, helpers, getInstallCalls } = context;
    const outcome = prepareArchitectScenario(ctx, helpers);
    assert.equal(outcome.status, "prepared");
    assert.equal(getInstallCalls(), 1);
    const manifestPath = join(ctx.rootDir, "artifacts", "architect-e2e", "evidence-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.status, "prepared");
    assert.equal(manifest.scoreStatus, "pending");
    assert.deepEqual(
      manifest.checks.map((check) => check.id),
      ARCHITECT_ACCEPTANCE_CHECKS.map((check) => check.id),
    );
    assert.equal(new Set(manifest.checks.map((check) => check.id)).size, manifest.checks.length);
    for (const check of manifest.checks) {
      assert.equal(check.status, "pending");
      assert.equal(check.passed, null);
      assert.ok(check.expectedSignal);
      assert.ok(check.captureGuidance);
      assert.ok(check.captureLocations.length > 0);
      assert.equal(check.missingPrerequisiteOutcome.status, "blocked");
    }
    const readme = readFileSync(
      join(ctx.rootDir, "artifacts", "architect-e2e", "README.md"),
      "utf8",
    );
    assert.match(readme, /openai-codex\/gpt-6-astra:medium/);
    assert.match(readme, /architect plan \+ human approval/);
    assert.match(readme, /tk show tlh-eval-architect-final-validation/);
    assert.match(readme, /node --input-type=module -e/);
    assert.match(readme, /code-reviewer/);
    assert.match(readme, /do not substitute|no substitution/i);
    assert.match(
      readFileSync(
        join(
          ctx.rootDir,
          "workspace",
          "architect-e2e-repo",
          ".tickets",
          "tlh-eval-architect-final-validation.md",
        ),
        "utf8",
      ),
      /status: open/,
    );
    const fixtureRoot = join(ctx.rootDir, "workspace", "architect-e2e-repo");
    const fixtureEnv = { ...process.env };
    delete fixtureEnv.NODE_TEST_CONTEXT;
    const baselineValidation = spawnSync(process.execPath, ["--test", "test/greeter.test.mjs"], {
      cwd: fixtureRoot,
      env: fixtureEnv,
      encoding: "utf8",
    });
    assert.notEqual(baselineValidation.status, 0);
    writeFileSync(
      join(fixtureRoot, "src", "greeter.mjs"),
      `export function formatGreeting(name) {
\tif (!name) return "Hello.";
\treturn \`Hello, \${String(name).trim()}!\`;
}

export function formatGreetingList(names) {
\treturn names.map(formatGreeting).join("\\n");
}
`,
      "utf8",
    );
    const completedValidation = spawnSync(process.execPath, ["--test", "test/greeter.test.mjs"], {
      cwd: fixtureRoot,
      env: fixtureEnv,
      encoding: "utf8",
    });
    assert.equal(
      completedValidation.status,
      0,
      `${completedValidation.stdout}\n${completedValidation.stderr}`,
    );
    const finalTicket = readFileSync(
      join(fixtureRoot, ".tickets", "tlh-eval-architect-final-validation.md"),
      "utf8",
    );
    const probe = finalTicket
      .split("\n")
      .find((line) => line.startsWith("2. node --input-type=module"))
      ?.slice(3);
    assert.ok(probe);
    const probeResult = spawnSync("sh", ["-c", probe], {
      cwd: fixtureRoot,
      env: fixtureEnv,
      encoding: "utf8",
    });
    assert.equal(probeResult.status, 0, `${probeResult.stdout}\n${probeResult.stderr}`);
    assert.match(
      readFileSync(join(fixtureRoot, "EXPECTED_BEHAVIOR.md"), "utf8"),
      /formatGreetingList/,
    );
    assert.ok(readme.includes("--model openai-codex/gpt-6-astra:medium"));
  } finally {
    cleanupScenarioContext(context);
  }
});

test("subagent scaffold covers every bundled role and separates dispatch from execution", () => {
  const context = createScenarioContext({ candidate: true, model: true });
  try {
    const { ctx, helpers } = context;
    const outcome = prepareSubagentAcceptanceScenario(ctx, helpers);
    assert.equal(outcome.status, "prepared");
    const manifest = JSON.parse(
      readFileSync(
        join(ctx.rootDir, "artifacts", "subagent-acceptance", "evidence-manifest.json"),
        "utf8",
      ),
    );
    const roleIds = BUNDLED_MINOR_ROLES.flatMap((role) => [
      `subagent-acceptance-${role}-dispatch`,
      `subagent-acceptance-${role}-execution`,
    ]);
    for (const id of roleIds)
      assert.ok(
        manifest.checks.some((check) => check.id === id),
        id,
      );
    for (const role of BUNDLED_MINOR_ROLES) {
      assert.equal(
        existsSync(
          join(ctx.rootDir, "workspace", "subagent-acceptance-repo", "role-tasks", `${role}.md`),
        ),
        true,
      );
      assert.equal(
        existsSync(
          join(ctx.rootDir, "workspace", "subagent-acceptance-repo", "evidence", `${role}.md`),
        ),
        true,
      );
    }
    for (const id of [
      "subagent-acceptance-nonallowlisted-block",
      "subagent-acceptance-user-scope",
      "subagent-acceptance-fresh-context",
      "subagent-acceptance-native-supervisor-pause-resume",
      "subagent-acceptance-async-status-resume",
      "subagent-acceptance-compact-description",
      "subagent-acceptance-max-thinking-badge",
    ]) {
      assert.ok(
        manifest.checks.some((check) => check.id === id),
        id,
      );
    }
    assert.deepEqual(manifest.dispatchPolicy.allowedRoles, BUNDLED_MINOR_ROLES);
    assert.equal(manifest.dispatchPolicy.nestedSubagents, false);
    assert.equal(manifest.dispatchPolicy.fallbackPolicy, "none");
    assert.equal(
      manifest.checks.every((check) => check.status === "pending" && check.passed === null),
      true,
    );
    assert.equal(
      new Set(SUBAGENT_ACCEPTANCE_CHECKS.map((check) => check.id)).size,
      SUBAGENT_ACCEPTANCE_CHECKS.length,
    );
    const fixtureRoot = join(ctx.rootDir, "workspace", "subagent-acceptance-repo");
    const fixtureEnv = { ...process.env };
    delete fixtureEnv.NODE_TEST_CONTEXT;
    const baselineValidation = spawnSync(process.execPath, ["--test", "test/value.test.mjs"], {
      cwd: fixtureRoot,
      env: fixtureEnv,
      encoding: "utf8",
    });
    assert.notEqual(baselineValidation.status, 0);
    writeFileSync(
      join(fixtureRoot, "src", "value.mjs"),
      "export function identity(value) {\n\treturn value;\n}\n\nexport function boundedIncrement(value) {\n\tif (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('value must be finite');\n\treturn Math.min(10, value + 1);\n}\n",
      "utf8",
    );
    const completedValidation = spawnSync(process.execPath, ["--test", "test/value.test.mjs"], {
      cwd: fixtureRoot,
      env: fixtureEnv,
      encoding: "utf8",
    });
    assert.equal(
      completedValidation.status,
      0,
      `${completedValidation.stdout}\n${completedValidation.stderr}`,
    );
    const runnerTask = readFileSync(join(fixtureRoot, "role-tasks", "test-runner.md"), "utf8");
    assert.match(
      runnerTask,
      /tk-eval-subagent-final-validation|tlh-eval-subagent-final-validation/,
    );
    assert.match(runnerTask, /node --test test\/value\.test\.mjs/);
    assert.doesNotMatch(runnerTask, /npm install/);
    assert.match(
      readFileSync(
        join(ctx.rootDir, "workspace", "subagent-acceptance-repo", "role-tasks", "oracle.md"),
        "utf8",
      ),
      /BOUNDARIED ACCEPTANCE SMOKE APPROVAL/,
    );
  } finally {
    cleanupScenarioContext(context);
  }
});

test("missing packaged acceptance inputs remain blocked without installation or a false pass", () => {
  const context = createScenarioContext();
  try {
    const { ctx, helpers, getInstallCalls } = context;
    const outcome = prepareSubagentAcceptanceScenario(ctx, helpers);
    assert.equal(outcome.status, "blocked");
    assert.equal(getInstallCalls(), 0);
    const manifest = JSON.parse(
      readFileSync(
        join(ctx.rootDir, "artifacts", "subagent-acceptance", "evidence-manifest.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.status, "blocked");
    assert.equal(manifest.scoreStatus, "pending");
    assert.deepEqual(manifest.prerequisites.outcome, "blocked");
    assert.match(manifest.prerequisites.missing.join("; "), /candidate-ref/);
    assert.match(manifest.prerequisites.missing.join("; "), /acceptance-model/);
    assert.equal(
      manifest.checks.some((check) => check.status === "passed" || check.passed === true),
      false,
    );
    const readme = readFileSync(
      join(ctx.rootDir, "artifacts", "subagent-acceptance", "README.md"),
      "utf8",
    );
    assert.match(readme, /This scaffold is blocked/);
    assert.match(readme, /not a pass/i);
  } finally {
    cleanupScenarioContext(context);
  }
});
