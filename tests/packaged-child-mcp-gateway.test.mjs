import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsDir, "..");
const supportDir = join(testsDir, "support");
const fixtureServerPath = join(supportDir, "packaged-child-mcp-gateway-fixture.mjs");
const childCliPath = join(supportDir, "packaged-child-mcp-gateway-child.mjs");
const parentRunnerPath = join(supportDir, "packaged-child-mcp-gateway-runner.mjs");

function isolatedEnv(root, agentDir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("PI_") ||
      key.startsWith("TLH_") ||
      /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  delete env.MCP_DIRECT_TOOLS;
  return {
    ...env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    TLH_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    TLH_SKIP_TELEMETRY: "1",
    TLH_SKIP_UPDATE_CHECK: "1",
    TMPDIR: join(root, "tmp"),
    npm_config_userconfig: join(root, "npmrc"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function packLocalCandidate(packDir, env) {
  const result = runChecked("npm", ["pack", "--json", "--pack-destination", packDir], {
    cwd: repoRoot,
    env,
    timeout: 180_000,
  });
  const [pack] = JSON.parse(result.stdout);
  assert.ok(pack?.filename, "npm pack must return a candidate tarball");
  return join(packDir, pack.filename);
}

function readMcporterPackageSpec(packageRoot) {
  const defaultExtensions = JSON.parse(
    readFileSync(join(packageRoot, "config", "default-extensions.json"), "utf8"),
  );
  const source = defaultExtensions.find((extension) => extension?.id === "mcporter")?.source;
  assert.equal(typeof source, "string", "packed candidate must declare mcporter source");
  assert.match(source, /^npm:/, "mcporter source must be an npm package spec");
  const spec = source.slice("npm:".length);
  const separator = spec.lastIndexOf("@");
  assert.ok(separator > 0, `mcporter source must include a package name and version: ${source}`);
  const name = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  assert.match(
    version,
    /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$/,
    `mcporter source must pin an exact npm version: ${source}`,
  );
  return { spec, name, version };
}

function packPinnedAdapter(packDir, env, packageSpec) {
  const result = runChecked(
    "npm",
    ["pack", "--json", "--pack-destination", packDir, packageSpec.spec],
    { env, timeout: 180_000 },
  );
  const [pack] = JSON.parse(result.stdout);
  assert.deepEqual(
    { name: pack?.name, version: pack?.version },
    { name: packageSpec.name, version: packageSpec.version },
    "npm pack must return the configured mcporter package identity",
  );
  assert.ok(pack?.filename, "npm pack must return the pinned adapter tarball");
  return join(packDir, pack.filename);
}

async function stopFixture(pidFile) {
  if (!existsSync(pidFile)) return true;
  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  const isAlive = () => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };
  if (isAlive()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  let alive = isAlive();
  const deadline = Date.now() + 2_000;
  while (alive && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    alive = isAlive();
  }
  if (alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    alive = isAlive();
  }
  if (existsSync(pidFile)) unlinkSync(pidFile);
  return !alive;
}

test(
  "packaged read-only child reaches a real local MCP fixture through the restricted gateway",
  { timeout: 300_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tlh-packaged-child-mcp-gateway-"));
    const packDir = join(root, "pack");
    const adapterPackDir = join(root, "adapter-pack");
    const adapterInstallDir = join(root, "adapter-install");
    const extractDir = join(root, "extract");
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const homeDir = join(root, "home");
    const tmpDir = join(root, "tmp");
    const fixturePidPath = join(root, "fixture.pid");
    const fixtureLogPath = join(root, "fixture.log");
    const evidencePath = join(root, "child-evidence.json");
    const env = isolatedEnv(root, agentDir);
    try {
      for (const path of [
        packDir,
        adapterPackDir,
        adapterInstallDir,
        extractDir,
        cwd,
        agentDir,
        homeDir,
        tmpDir,
      ]) {
        mkdirSync(path, { recursive: true });
      }
      const candidateTarball = packLocalCandidate(packDir, env);
      runChecked("tar", ["-xzf", candidateTarball, "-C", extractDir], { env });
      const packageRoot = realpathSync(join(extractDir, "package"));
      symlinkSync(join(repoRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");

      const mcporterPackage = readMcporterPackageSpec(packageRoot);
      const adapterTarball = packPinnedAdapter(adapterPackDir, env, mcporterPackage);
      runChecked(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-package-lock",
          "--no-save",
          "--no-audit",
          "--no-fund",
          "--prefix",
          adapterInstallDir,
          adapterTarball,
        ],
        { env, timeout: 180_000 },
      );
      const adapterRoot = realpathSync(
        join(adapterInstallDir, "node_modules", ...mcporterPackage.name.split("/")),
      );
      const installedAdapter = JSON.parse(readFileSync(join(adapterRoot, "package.json"), "utf8"));
      assert.deepEqual(
        { name: installedAdapter.name, version: installedAdapter.version },
        { name: mcporterPackage.name, version: mcporterPackage.version },
        "installed mcporter package must match the configured identity",
      );

      const packagedRepoScoutPath = join(packageRoot, "agents", "subagents", "repo-scout.md");
      assert.ok(existsSync(packagedRepoScoutPath), "packed candidate must contain repo-scout");
      const packagedRepoScout = readFileSync(packagedRepoScoutPath, "utf8");
      const toolsLine = packagedRepoScout.match(/^tools: .+$/m)?.[0];
      assert.ok(toolsLine, "packed repo-scout must declare its tools");
      const directTool = "mcp:fixture_read_fixture";
      const restrictedRepoScout = packagedRepoScout.replace(
        toolsLine,
        `${toolsLine}, ${directTool}`,
      );
      const canonicalAgentsDir = join(agentDir, "tlh", "agents", "subagents");
      mkdirSync(canonicalAgentsDir, { recursive: true });
      writeFileSync(join(canonicalAgentsDir, "repo-scout.md"), restrictedRepoScout);
      assert.match(
        readFileSync(join(canonicalAgentsDir, "repo-scout.md"), "utf8"),
        /mcp:fixture_read_fixture/,
      );

      writeFileSync(
        join(agentDir, "settings.json"),
        `${JSON.stringify(
          {
            packages: [packageRoot, adapterRoot],
            tlh: {
              primaryAgent: { enabled: false, selected: "disabled" },
              telemetry: { enabled: false },
              updateCheck: { enabled: false },
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(agentDir, "mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              fixture: {
                command: process.execPath,
                args: [fixtureServerPath],
                env: {
                  FIXTURE_PID_FILE: fixturePidPath,
                  FIXTURE_LOG: fixtureLogPath,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const runtimeResult = spawnSync(
        process.execPath,
        [parentRunnerPath, packageRoot, adapterRoot, cwd, agentDir, childCliPath, evidencePath],
        {
          cwd,
          encoding: "utf8",
          env,
          timeout: 120_000,
        },
      );
      assert.equal(runtimeResult.status, 0, runtimeResult.stderr || runtimeResult.stdout);
      const runtimeEvidence = JSON.parse(runtimeResult.stdout.trim());
      const childEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      const fixtureLog = readFileSync(fixtureLogPath, "utf8").trim().split("\n").filter(Boolean);

      const childArtifactPath = runtimeEvidence.childResult.match(/Output artifact: (.+)$/m)?.[1];
      const childArtifact =
        childArtifactPath && existsSync(childArtifactPath)
          ? readFileSync(childArtifactPath, "utf8")
          : "missing";
      const debugEvidence = JSON.stringify({ runtimeEvidence, childEvidence, childArtifact });
      assert.match(runtimeEvidence.parentResponse, /PARENT_MCP_CHILD_OK/, debugEvidence);
      assert.match(runtimeEvidence.childResult, /FIXTURE_MCP_OK/, debugEvidence);
      assert.ok(
        runtimeEvidence.parentExtensions.some(
          (extension) =>
            extension.path.startsWith(packageRoot) && extension.tools.includes("subagent"),
        ),
        "the parent must exercise the packaged subagent extension",
      );
      assert.equal(childEvidence.env.mcpDirectTools, "__none__");
      assert.equal(childEvidence.env.child, "1");
      assert.equal(childEvidence.argvTools.includes("mcp"), true);
      assert.equal(
        childEvidence.argvTools.some((tool) => tool.startsWith("mcp:")),
        false,
        "direct mcp:* declarations must not reach the child allowlist",
      );
      const childMcpTools = childEvidence.allTools.filter(
        (tool) =>
          tool === "mcp" || tool.startsWith("mcp:") || tool.includes("fixture_read_fixture"),
      );
      assert.deepEqual(childMcpTools, ["mcp"]);
      assert.ok(
        childEvidence.extensions.some(
          (extension) => extension.path.startsWith(adapterRoot) && extension.tools.includes("mcp"),
        ),
        "the restricted child must load the real pinned adapter from the isolated package",
      );
      assert.ok(fixtureLog.includes("started"));
      assert.ok(fixtureLog.includes("tools/list"));
      assert.equal(fixtureLog.filter((event) => event === "tools/call:read_fixture").length, 1);
      assert.equal(existsSync(fixturePidPath), false, "fixture server must exit with the child");
      assert.equal(existsSync(join(cwd, "pi-shim")), false, "child shim must be removed");
      assert.equal(
        existsSync(join(cwd, "pi-shim.cmd")),
        false,
        "Windows child shim must be removed",
      );
    } finally {
      const fixtureStopped = await stopFixture(fixturePidPath);
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false, "all packaged smoke artifacts must be removed");
      assert.equal(fixtureStopped, true, "fixture server process must be stopped");
    }
  },
);
