import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildCandidateEnvironment, setupPackagedCandidate } from "./tlh-live-eval-candidate.mjs";

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
    mkdirp(path);
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
    GIT_AUTHOR_NAME: "Candidate Test",
    GIT_AUTHOR_EMAIL: "candidate@example.invalid",
    GIT_COMMITTER_NAME: "Candidate Test",
    GIT_COMMITTER_EMAIL: "candidate@example.invalid",
  };
}

function createFixture({
  runtimeVersion = "0.85.1",
  packageVersion = "0.40.0",
  installerRuntimeVersion = "0.85.1",
  moduleRuntimeVersion = "",
  baseEnv = process.env,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-fixture-"));
  const repoDir = join(root, "repo");
  const homeDir = join(root, "git-home");
  mkdirp(repoDir);
  mkdirp(homeDir);
  const env = isolatedGitEnvironment(root, homeDir, baseEnv);
  const packageJson = {
    name: "tlh-candidate-fixture",
    version: packageVersion,
    private: true,
    scripts: { prepack: "touch pack-script-ran" },
  };
  const hooksDir = join(root, "empty-hooks");
  mkdirp(hooksDir);
  const runtimePinDeclaration =
    installerRuntimeVersion === null ? "" : `TLH_PINNED_PI_VERSION="${installerRuntimeVersion}"`;
  const installScript = `#!/usr/bin/env bash
set -eu
${runtimePinDeclaration}
agent_dir=""
bin_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-dir) agent_dir="$2"; shift 2 ;;
    --bin-dir) bin_dir="$2"; shift 2 ;;
    --wrapper-name) shift 2 ;;
    --ref|--track) shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$agent_dir" "$bin_dir" "$(dirname "$agent_dir")/runtime/bin"
printf '%s\\n' "\${HOME-}" > "$agent_dir/observed-home"
printf '%s\\n' "\${PI_CODING_AGENT_DIR-}" > "$agent_dir/observed-agent"
printf '%s\\n' "\${NPM_CONFIG_CACHE-}" > "$agent_dir/observed-npm-cache"
source_path="\${TLH_PACKAGE_SOURCE#file:}"
printf '{"packages":["%s"]}\\n' "$source_path" > "$agent_dir/settings.json"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$bin_dir/tlh"
chmod 700 "$bin_dir/tlh"
cat > "$(dirname "$agent_dir")/runtime/bin/pi" <<'RUNTIME'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then printf '%s\\n' "${runtimeVersion}"; exit 0; fi
exit 0
RUNTIME
chmod 700 "$(dirname "$agent_dir")/runtime/bin/pi"
`;
  writeFileSync(join(repoDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  writeFileSync(join(repoDir, "install.sh"), installScript, "utf8");
  chmodSync(join(repoDir, "install.sh"), 0o700);
  writeFileSync(join(repoDir, "MUTABLE.txt"), "committed snapshot\n", "utf8");
  if (moduleRuntimeVersion) {
    const scriptsDir = join(repoDir, "scripts");
    mkdirp(scriptsDir);
    writeFileSync(
      join(scriptsDir, "tlh-install.mjs"),
      `const PINNED_PI_VERSION = "${moduleRuntimeVersion}";\n`,
      "utf8",
    );
  }
  runGit(repoDir, ["init", "-q", "--template="], env);
  runGit(repoDir, ["config", "user.name", "Candidate Test"], env);
  runGit(repoDir, ["config", "user.email", "candidate@example.invalid"], env);
  runGit(repoDir, ["config", "core.hooksPath", hooksDir], env);
  runGit(repoDir, ["add", "."], env);
  runGit(
    repoDir,
    ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", "fixture"],
    env,
  );
  const commit = runGit(repoDir, ["rev-parse", "HEAD"], env);
  return { root, repoDir, commit };
}

function mkdirp(path) {
  // Keep fixture setup explicit and independent of the candidate implementation.
  const result = spawnSync("mkdir", ["-p", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function commandAdapter(commands, failure = null) {
  return (specification) => {
    commands.push({
      ...specification,
      env: { ...specification.env },
    });
    if (failure?.phase === specification.phase) {
      if (failure.error) throw failure.error;
      return failure.result;
    }
    return spawnSync(specification.command, specification.args, {
      cwd: specification.cwd,
      env: specification.env,
      encoding: "utf8",
      timeout: specification.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
  };
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function createDisposableVictim() {
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-victim-"));
  const victimDir = join(root, "victim");
  const victimHome = join(root, "victim-home");
  mkdirp(victimDir);
  mkdirp(victimHome);
  const cleanEnv = isolatedGitEnvironment(root, victimHome);
  writeFileSync(join(victimDir, "victim.txt"), "victim baseline\n", "utf8");
  runGit(victimDir, ["init", "-q", "--template="], cleanEnv);
  runGit(victimDir, ["config", "user.name", "Victim Test"], cleanEnv);
  runGit(victimDir, ["config", "user.email", "victim@example.invalid"], cleanEnv);
  runGit(victimDir, ["add", "."], cleanEnv);
  runGit(
    victimDir,
    ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", "victim baseline"],
    cleanEnv,
  );

  const hookDir = join(root, "attacker-hooks");
  const templateHooksDir = join(root, "attacker-template", "hooks");
  const xdgGitDir = join(root, "attacker-xdg", "git");
  const sentinelPath = join(root, "hook-sentinel");
  const templateSentinelPath = join(root, "template-hook-sentinel");
  mkdirp(hookDir);
  mkdirp(templateHooksDir);
  mkdirp(xdgGitDir);
  const hookScript = `#!/bin/sh\nprintf 'hook ran\\n' > ${sentinelPath}\nexit 0\n`;
  writeFileSync(join(hookDir, "pre-commit"), hookScript, "utf8");
  chmodSync(join(hookDir, "pre-commit"), 0o700);
  const templateHookScript = `#!/bin/sh\nprintf 'template hook ran\\n' > ${templateSentinelPath}\nexit 0\n`;
  writeFileSync(join(templateHooksDir, "pre-commit"), templateHookScript, "utf8");
  chmodSync(join(templateHooksDir, "pre-commit"), 0o700);
  const globalConfig = join(root, "attacker-global.gitconfig");
  const systemConfig = join(root, "attacker-system.gitconfig");
  const attackerConfig = `[core]\n\thooksPath = ${hookDir}\n[commit]\n\tgpgSign = true\n[init]\n\ttemplateDir = ${join(root, "attacker-template")}\n[user]\n\tsigningKey = unavailable\n`;
  writeFileSync(globalConfig, attackerConfig, "utf8");
  writeFileSync(systemConfig, attackerConfig, "utf8");
  writeFileSync(join(xdgGitDir, "config"), attackerConfig, "utf8");

  const adversarialEnv = {
    PATH: cleanEnv.PATH,
    HOME: victimHome,
    XDG_CONFIG_HOME: join(root, "attacker-xdg"),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hookDir,
    GIT_DIR: join(victimDir, ".git"),
    GIT_WORK_TREE: victimDir,
    GIT_INDEX_FILE: join(victimDir, ".git", "index"),
    GIT_OBJECT_DIRECTORY: join(victimDir, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(victimDir, ".git", "objects"),
    GIT_COMMON_DIR: join(victimDir, ".git"),
    GIT_TEMPLATE_DIR: join(root, "attacker-template"),
  };
  return {
    root,
    victimDir,
    cleanEnv,
    adversarialEnv,
    sentinelPath,
    templateSentinelPath,
    snapshot: {
      head: runGit(victimDir, ["rev-parse", "HEAD"], cleanEnv),
      index: readFileSync(join(victimDir, ".git", "index")),
      tracked: readFileSync(join(victimDir, "victim.txt"), "utf8"),
    },
  };
}

test("packs and installs only a frozen local commit with isolated paths and evidence", () => {
  const fixture = createFixture();
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-run-"));
  const outside = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-outside-"));
  const outsideSentinel = join(outside, "sentinel");
  writeFileSync(outsideSentinel, "untouched\n", "utf8");
  const commands = [];
  try {
    const candidate = setupPackagedCandidate({
      repoRoot: fixture.repoDir,
      candidateRef: "HEAD",
      rootDir: root,
      homeDir: join(root, "home"),
      agentDir: join(root, "agent"),
      binDir: join(root, "bin"),
      baseEnv: {
        ...process.env,
        HOME: outside,
        XDG_CONFIG_HOME: outside,
        XDG_CACHE_HOME: outside,
        XDG_DATA_HOME: outside,
        XDG_STATE_HOME: outside,
        NPM_CONFIG_CACHE: outside,
        NPM_CONFIG_USERCONFIG: join(outside, "user.npmrc"),
        PI_CODING_AGENT_DIR: outside,
        PI_CODING_AGENT_SESSION_DIR: outside,
        TLH_PACKAGE_SOURCE: outside,
        OPENAI_API_KEY: "candidate-secret-value",
        AWS_SECRET_ACCESS_KEY: "candidate-secret-value",
        GITHUB_TOKEN: "candidate-secret-value",
      },
      commandRunner: commandAdapter(commands),
    });

    assert.equal(candidate.commit, fixture.commit);
    assert.equal(candidate.expectedRuntimeVersion, "0.85.1");
    assert.equal(candidate.observedRuntimeVersion, "0.85.1");
    assert.equal(candidate.installedPackage.identity, `local:${resolve(candidate.packageRoot)}`);
    assert.equal(candidate.metadata.validationKind, "local-packed-commit");
    assert.equal(candidate.metadata.releasedArtifactValidation, false);
    assert.equal(candidate.metadata.packageSha256, candidate.packageSha256);
    assert.equal(candidate.metadata.packageName, candidate.packageName);
    assert.equal(candidate.metadata.packageSource, candidate.packageSource);
    assert.equal(candidate.metadata.environmentPaths.agentDir, candidate.agentDir);
    assert.equal(
      candidate.packageSha256,
      createHash("sha256").update(readFileSync(candidate.tarballPath)).digest("hex"),
    );
    assert.equal(candidate.metadata.installedPackageIdentity, candidate.installedPackage.identity);
    assert.equal(candidate.metadata.status, "ready");
    assert.equal(candidate.metadata.cleanupPath, root);
    assert.equal(
      readFileSync(join(root, "candidate-metadata.json"), "utf8").includes('"status": "ready"'),
      true,
    );
    assert.equal(mode(root) & 0o077, 0);
    assert.equal(mode(candidate.sourceRoot) & 0o077, 0);
    assert.equal(mode(candidate.packageRoot) & 0o077, 0);
    assert.equal(mode(candidate.tarballPath) & 0o077, 0);
    assert.equal(existsSync(join(candidate.sourceRoot, "pack-script-ran")), false);

    const packCommand = commands.find((command) => command.phase === "pack candidate");
    assert.ok(packCommand);
    assert.equal(packCommand.env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
    assert.equal(packCommand.env.npm_config_ignore_scripts, "true");
    const installCommand = commands.find(
      (command) => command.phase === "install packaged candidate",
    );
    assert.ok(installCommand);
    assert.equal(installCommand.cwd, candidate.sourceRoot);
    assert.equal(installCommand.args[0], join(candidate.sourceRoot, "install.sh"));
    assert.notEqual(installCommand.cwd, fixture.repoDir);
    assert.equal(installCommand.env.HOME, join(root, "home"));
    assert.equal(installCommand.env.XDG_CONFIG_HOME, join(root, "xdg", "config"));
    assert.equal(installCommand.env.XDG_CACHE_HOME, join(root, "xdg", "cache"));
    assert.equal(installCommand.env.NPM_CONFIG_CACHE, join(root, "npm", "cache"));
    assert.equal(installCommand.env.PI_CODING_AGENT_DIR, join(root, "agent"));
    assert.equal(installCommand.env.TLH_PACKAGE_SOURCE, `file:${candidate.packageRoot}`);
    for (const name of [
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "TLH_PACKAGE_SOURCE",
    ]) {
      if (name !== "TLH_PACKAGE_SOURCE") assert.equal(installCommand.env[name], undefined, name);
    }
    assert.deepEqual(readFileSync(outsideSentinel, "utf8"), "untouched\n");

    writeFileSync(join(fixture.repoDir, "MUTABLE.txt"), "changed after commit\n", "utf8");
    assert.equal(
      readFileSync(join(candidate.sourceRoot, "MUTABLE.txt"), "utf8"),
      "committed snapshot\n",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("candidate fixture git setup cannot mutate a disposable victim repo or run inherited hooks", () => {
  const victim = createDisposableVictim();
  let fixture;
  try {
    fixture = createFixture({ baseEnv: victim.adversarialEnv });
    assert.notEqual(fixture.repoDir, victim.victimDir);
    assert.equal(
      runGit(victim.victimDir, ["rev-parse", "HEAD"], victim.cleanEnv),
      victim.snapshot.head,
    );
    assert.deepEqual(readFileSync(join(victim.victimDir, ".git", "index")), victim.snapshot.index);
    assert.equal(
      readFileSync(join(victim.victimDir, "victim.txt"), "utf8"),
      victim.snapshot.tracked,
    );
    assert.equal(runGit(victim.victimDir, ["status", "--short"], victim.cleanEnv), "");
    assert.equal(existsSync(victim.sentinelPath), false);
    assert.equal(existsSync(victim.templateSentinelPath), false);
  } finally {
    if (fixture) rmSync(fixture.root, { recursive: true, force: true });
    rmSync(victim.root, { recursive: true, force: true });
  }
});

test("rejects an unresolved candidate ref before archive, pack, or install", () => {
  const fixture = createFixture();
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-invalid-"));
  const commands = [];
  let metadata;
  try {
    assert.throws(
      () =>
        setupPackagedCandidate({
          repoRoot: fixture.repoDir,
          candidateRef: "does-not-exist",
          rootDir: root,
          baseEnv: process.env,
          commandRunner: commandAdapter(commands),
          onMetadata: (value) => {
            metadata = value;
          },
        }),
      (error) => {
        assert.match(error.message, /resolve candidate commit|candidate ref/i);
        assert.equal(error.cleanupPath, root);
        return true;
      },
    );
    assert.deepEqual(
      commands.map((command) => command.phase),
      ["resolve candidate commit"],
    );
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.commit, "");
    assert.equal(metadata.cleanupPath, root);
    assert.equal(existsSync(join(root, "candidate-metadata.json")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when the candidate does not declare an upstream runtime pin", () => {
  const fixture = createFixture({ installerRuntimeVersion: null });
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-runtime-pin-missing-"));
  const commands = [];
  try {
    assert.throws(
      () =>
        setupPackagedCandidate({
          repoRoot: fixture.repoDir,
          candidateRef: fixture.commit,
          rootDir: root,
          baseEnv: process.env,
          commandRunner: commandAdapter(commands),
        }),
      (error) => {
        assert.match(error.message, /does not declare an expected upstream runtime version/i);
        assert.match(error.message, /expectedRuntimeVersion/i);
        assert.equal(error.cleanupPath, root);
        return true;
      },
    );
    assert.equal(
      commands.some((command) => command.phase === "pack candidate"),
      false,
    );
    const metadata = JSON.parse(readFileSync(join(root, "candidate-metadata.json"), "utf8"));
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.expectedRuntimeVersion, "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when candidate installer runtime pins disagree", () => {
  const fixture = createFixture({
    installerRuntimeVersion: "0.85.1",
    moduleRuntimeVersion: "9.9.9",
  });
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-runtime-pin-disagree-"));
  try {
    assert.throws(
      () =>
        setupPackagedCandidate({
          repoRoot: fixture.repoDir,
          candidateRef: fixture.commit,
          rootDir: root,
          baseEnv: process.env,
          commandRunner: commandAdapter([]),
        }),
      (error) => {
        assert.match(error.message, /runtime versions disagree/i);
        assert.match(error.message, /0\.85\.1/);
        assert.match(error.message, /9\.9\.9/);
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts an explicitly supplied runtime expectation when the candidate has no pin", () => {
  const fixture = createFixture({ installerRuntimeVersion: null });
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-runtime-pin-override-"));
  try {
    const candidate = setupPackagedCandidate({
      repoRoot: fixture.repoDir,
      candidateRef: fixture.commit,
      rootDir: root,
      baseEnv: process.env,
      expectedRuntimeVersion: "0.85.1",
      commandRunner: commandAdapter([]),
    });
    assert.equal(candidate.expectedRuntimeVersion, "0.85.1");
    assert.equal(candidate.observedRuntimeVersion, "0.85.1");
    assert.equal(candidate.metadata.expectedRuntimeVersion, "0.85.1");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when the installed runtime version disagrees with the candidate expectation", () => {
  const fixture = createFixture({ runtimeVersion: "9.9.9" });
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-runtime-"));
  const commands = [];
  let metadata;
  try {
    assert.throws(
      () =>
        setupPackagedCandidate({
          repoRoot: fixture.repoDir,
          candidateRef: fixture.commit,
          rootDir: root,
          baseEnv: process.env,
          commandRunner: commandAdapter(commands),
          onMetadata: (value) => {
            metadata = value;
          },
        }),
      (error) => {
        assert.match(error.message, /runtime version .* does not match expected/i);
        assert.equal(error.cleanupPath, root);
        return true;
      },
    );
    assert.equal(
      commands.some((command) => command.phase === "install packaged candidate"),
      true,
    );
    assert.equal(
      commands.some((command) => command.phase === "probe installed upstream runtime"),
      true,
    );
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.expectedRuntimeVersion, "0.85.1");
    assert.equal(metadata.observedRuntimeVersion, "9.9.9");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("failure after packing retains package identity, hash, and environment paths", () => {
  const fixture = createFixture();
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-pack-failure-"));
  const commands = [];
  try {
    assert.throws(
      () =>
        setupPackagedCandidate({
          repoRoot: fixture.repoDir,
          candidateRef: fixture.commit,
          rootDir: root,
          baseEnv: process.env,
          commandRunner: commandAdapter(commands, {
            phase: "extract packed candidate package",
            result: {
              status: 1,
              signal: null,
              stdout: "",
              stderr: "tar extraction failed",
            },
          }),
        }),
      (error) => {
        assert.match(error.message, /extract packed candidate package failed/i);
        assert.match(error.message, /tar extraction failed/i);
        assert.equal(error.cleanupPath, root);
        return true;
      },
    );
    const metadata = JSON.parse(readFileSync(join(root, "candidate-metadata.json"), "utf8"));
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.packageName, "tlh-candidate-fixture");
    assert.equal(metadata.packageSource, `file:${metadata.paths.unpackedPackage}`);
    assert.equal(metadata.packageVersion, "0.40.0");
    assert.equal(metadata.package.name, metadata.packageName);
    assert.equal(metadata.package.source, metadata.packageSource);
    assert.equal(metadata.package.version, metadata.packageVersion);
    assert.match(metadata.packageSha256, /^[0-9a-f]{64}$/);
    assert.equal(
      metadata.packageSha256,
      createHash("sha256").update(readFileSync(metadata.paths.packedPackage)).digest("hex"),
    );
    assert.equal(metadata.environmentPaths.agentDir, join(root, "agent"));
    assert.equal(metadata.environmentPaths.homeDir, join(root, "home"));
    assert.equal(metadata.paths.environment.agentDir, metadata.environmentPaths.agentDir);
    assert.match(metadata.error, /tar extraction failed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawn errors retain a sanitized code and cause in candidate diagnostics", () => {
  const fixture = createFixture();
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-spawn-error-"));
  const spawnError = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  try {
    assert.throws(
      () =>
        setupPackagedCandidate({
          repoRoot: fixture.repoDir,
          candidateRef: fixture.commit,
          rootDir: root,
          baseEnv: process.env,
          commandRunner: commandAdapter([], {
            phase: "resolve candidate commit",
            error: spawnError,
          }),
        }),
      (error) => {
        assert.match(error.message, /code=ENOENT/);
        assert.match(error.message, /cause=spawn git ENOENT/);
        return true;
      },
    );
    const metadata = JSON.parse(readFileSync(join(root, "candidate-metadata.json"), "utf8"));
    assert.match(metadata.error, /code=ENOENT/);
    assert.match(metadata.error, /cause=spawn git ENOENT/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout errors retain their code and cause in candidate diagnostics", () => {
  const fixture = createFixture();
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-timeout-error-"));
  const timeoutError = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
  try {
    assert.throws(
      () =>
        setupPackagedCandidate({
          repoRoot: fixture.repoDir,
          candidateRef: fixture.commit,
          rootDir: root,
          baseEnv: process.env,
          commandRunner: commandAdapter([], {
            phase: "resolve candidate commit",
            result: {
              status: null,
              signal: "SIGTERM",
              error: timeoutError,
              stdout: "",
              stderr: "",
            },
          }),
        }),
      (error) => {
        assert.match(error.message, /ETIMEDOUT/);
        assert.match(error.message, /spawnSync git ETIMEDOUT/);
        return true;
      },
    );
    const metadata = JSON.parse(readFileSync(join(root, "candidate-metadata.json"), "utf8"));
    assert.match(metadata.error, /ETIMEDOUT/);
    assert.match(metadata.error, /spawnSync git ETIMEDOUT/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate environment rewrites inherited storage roots and removes credential overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-live-eval-candidate-env-"));
  try {
    const { environment } = buildCandidateEnvironment({
      ownedRoot: root,
      baseEnv: {
        HOME: "/outside/home",
        XDG_CONFIG_HOME: "/outside/config",
        NPM_CONFIG_CACHE: "/outside/cache",
        PI_CODING_AGENT_DIR: "/outside/agent",
        TLH_PACKAGE_SOURCE: "/outside/package",
        BASH_ENV: "/outside/bash-env",
        AWS_CONFIG_FILE: "/outside/aws-config",
        SOME_API_KEY: "secret-value",
        PATH: process.env.PATH,
      },
    });
    assert.equal(environment.HOME, join(root, "home"));
    assert.equal(environment.XDG_CONFIG_HOME, join(root, "xdg", "config"));
    assert.equal(environment.NPM_CONFIG_CACHE, join(root, "npm", "cache"));
    assert.equal(environment.PI_CODING_AGENT_DIR, join(root, "agent"));
    assert.equal(environment.TLH_PACKAGE_SOURCE, undefined);
    assert.equal(environment.SOME_API_KEY, undefined);
    assert.equal(environment.BASH_ENV, undefined);
    assert.equal(environment.AWS_CONFIG_FILE, undefined);
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
