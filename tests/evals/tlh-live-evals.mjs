#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setupPackagedCandidate } from "./tlh-live-eval-candidate.mjs";
import {
  ACCEPTANCE_MODEL_FORMAT,
  ACCEPTANCE_SUITE_VERSION,
  SUBAGENT_ACCEPTANCE_CHECKS,
  acceptanceModelMetadata,
  parseAcceptanceModel,
  prepareArchitectScenario as prepareArchitectAcceptanceScenario,
  prepareDirtyRepoScenario,
  preparePrimaryBehaviorScenario,
  prepareSubagentAcceptanceScenario,
  prepareWebScoutScenario,
} from "./tlh-acceptance-scenarios.mjs";
import {
  createBinaryScoreCheck,
  createManualRubricCheck,
  createScenarioResult,
  createSuiteResult,
  writeResultsFile,
} from "./tlh-live-eval-results.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tempRootPrefix = "tlh-live-evals-";
const installTimeoutMs = 10 * 60 * 1000;
const commandTimeoutMs = 60 * 1000;
const sensitiveEnvNamePattern = /(KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION|BEARER)/i;
const minimumSensitiveEnvValueLength = 8;
const nonSecretSensitiveEnvValuePattern = /^(?:0|1|true|false|yes|no|on|off)$/i;

function usage() {
  return `Usage: node tests/evals/tlh-live-evals.mjs [options]

Prepare or run opt-in TLH live eval scenarios for real model/network/install smoke checks.
This command is never part of npm run validate.

By default it only prints the available scenarios and exits successfully.
To actually execute the runner, pass --run or set TLH_RUN_LIVE_EVALS=1.

Options:
  --list                 List the available scenarios and prerequisites
  --run                  Actually run the selected scenarios
  --scenario ID[,ID...]  Run only the named scenario ids
  --keep-artifacts       Keep the temp workspace even when only automated checks ran
  --artifacts-dir DIR    Create the temp workspace under parent DIR instead of the system temp root
  --results-file FILE    Write redacted JSON results to FILE outside the temp workspace
  --candidate-ref COMMIT Run from a frozen local commit snapshot packed with npm
  --acceptance-model M   Use explicit PROVIDER/MODEL:LEVEL for guided acceptance runs
  -h, --help             Show this help
`;
}

function isTruthyEnv(value) {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function parseArgs(argv) {
  const args = {
    list: false,
    run: false,
    keepArtifacts: false,
    artifactsDir: "",
    resultsFile: "",
    candidateRef: "",
    acceptanceModel: "",
    scenarios: [],
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--list") {
      args.list = true;
      continue;
    }
    if (arg === "--run") {
      args.run = true;
      continue;
    }
    if (arg === "--keep-artifacts") {
      args.keepArtifacts = true;
      continue;
    }
    if (arg === "--artifacts-dir") {
      index += 1;
      if (!argv[index]) throw new Error("--artifacts-dir requires a value");
      args.artifactsDir = argv[index];
      continue;
    }
    if (arg.startsWith("--artifacts-dir=")) {
      args.artifactsDir = arg.slice("--artifacts-dir=".length);
      continue;
    }
    if (arg === "--results-file") {
      index += 1;
      if (!argv[index]) throw new Error("--results-file requires a value");
      args.resultsFile = argv[index];
      continue;
    }
    if (arg === "--candidate-ref") {
      index += 1;
      if (!argv[index] || argv[index].startsWith("-") || argv[index].trim() === "")
        throw new Error("--candidate-ref requires a value");
      args.candidateRef = argv[index];
      continue;
    }
    if (arg.startsWith("--candidate-ref=")) {
      const candidateRef = arg.slice("--candidate-ref=".length);
      if (!candidateRef.trim()) throw new Error("--candidate-ref requires a value");
      args.candidateRef = candidateRef;
      continue;
    }
    if (arg === "--acceptance-model") {
      index += 1;
      if (!argv[index] || argv[index].startsWith("-") || argv[index].trim() === "")
        throw new Error(`--acceptance-model requires ${ACCEPTANCE_MODEL_FORMAT}`);
      args.acceptanceModel = parseAcceptanceModel(argv[index]).raw;
      continue;
    }
    if (arg.startsWith("--acceptance-model=")) {
      const acceptanceModel = arg.slice("--acceptance-model=".length);
      args.acceptanceModel = parseAcceptanceModel(acceptanceModel).raw;
      continue;
    }
    if (arg.startsWith("--results-file=")) {
      args.resultsFile = arg.slice("--results-file=".length);
      continue;
    }
    if (arg === "--scenario") {
      index += 1;
      if (!argv[index]) throw new Error("--scenario requires a value");
      args.scenarios.push(...splitScenarioValues(argv[index]));
      continue;
    }
    if (arg.startsWith("--scenario=")) {
      args.scenarios.push(...splitScenarioValues(arg.slice("--scenario=".length)));
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  args.scenarios = [...new Set(args.scenarios.filter(Boolean))];
  return args;
}

function splitScenarioValues(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sanitizePath(pathValue) {
  if (!pathValue) return "";
  const repoBin = resolve(repoRoot, "node_modules", ".bin");
  return String(pathValue)
    .split(delimiter)
    .filter((entry) => resolve(entry || ".") !== repoBin)
    .join(delimiter);
}

function buildBaseEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === "PI_CODING_AGENT_DIR" || name.startsWith("TLH_")) delete env[name];
  }
  env.PATH = sanitizePath(env.PATH || "");
  return env;
}

function quoteShellWord(value) {
  const text = String(value ?? "");
  if (text === "") return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function renderCommand(command, args = []) {
  return [command, ...args].map((value) => quoteShellWord(value)).join(" ");
}

function commandExists(command, pathValue) {
  for (const entry of String(pathValue || "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, command);
    if (existsSync(candidate)) return true;
  }
  return false;
}

function requireCommands(names, ctx) {
  const missing = names.filter((name) => !commandExists(name, ctx.baseEnv.PATH));
  if (missing.length > 0) {
    throw new Error(`missing required command(s) on PATH: ${missing.join(", ")}`);
  }
}

function isSecretLikeSensitiveEnvValue(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return false;
  if (nonSecretSensitiveEnvValuePattern.test(normalized)) return false;
  return normalized.length >= minimumSensitiveEnvValueLength;
}

function buildRedactions(ctx) {
  const replacements = [
    { value: ctx.rootDir, replacement: "<LIVE_EVAL_ROOT>" },
    { value: ctx.homeDir, replacement: "<TEMP_HOME>" },
    { value: ctx.agentDir, replacement: "<TEMP_AGENT_DIR>" },
    { value: ctx.binDir, replacement: "<TEMP_BIN_DIR>" },
    { value: ctx.workspaceDir, replacement: "<TEMP_WORKSPACE>" },
  ];
  for (const [name, value] of Object.entries(process.env)) {
    if (!sensitiveEnvNamePattern.test(name) || !isSecretLikeSensitiveEnvValue(value)) continue;
    replacements.push({ value, replacement: `<${name}>` });
  }
  return replacements.sort((left, right) => right.value.length - left.value.length);
}

function redactText(text, ctx) {
  let output = String(text ?? "");
  for (const { value, replacement } of ctx.redactions) {
    if (!value) continue;
    output = output.split(value).join(replacement);
  }
  return output;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function normalizeArtifactPath(relativePath) {
  return String(relativePath).split("\\").join("/");
}

function registerArtifact(ctx, relativePath) {
  const normalized = normalizeArtifactPath(relativePath);
  if (!normalized.startsWith("artifacts/")) return;
  ctx.artifactPaths.add(normalized);
  const parts = normalized.split("/");
  if (parts.length < 3) return;
  const scenarioId = parts[1];
  if (!ctx.artifactsByScenario.has(scenarioId)) ctx.artifactsByScenario.set(scenarioId, new Set());
  ctx.artifactsByScenario.get(scenarioId).add(normalized);
}

function writeArtifact(ctx, relativePath, content) {
  const target = join(ctx.rootDir, relativePath);
  ensureDir(dirname(target));
  writeFileSync(target, redactText(content, ctx), "utf8");
  registerArtifact(ctx, relativePath);
  return target;
}

function runCommand(
  ctx,
  {
    scenarioId,
    label,
    command,
    args = [],
    cwd = repoRoot,
    env = ctx.baseEnv,
    timeoutMs = commandTimeoutMs,
  },
) {
  const commandText = renderCommand(command, args);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const combined = `${stdout}${stderr ? (stdout.endsWith("\n") || !stdout ? "" : "\n") + stderr : ""}`;
  writeArtifact(
    ctx,
    join("artifacts", scenarioId, `${label}.log`),
    [
      `# cwd\n${cwd}\n`,
      `# timeout_ms\n${timeoutMs}\n`,
      `# command\n${commandText}\n`,
      `# exit_status\n${result.status ?? "null"}\n`,
      `# signal\n${result.signal ?? ""}\n`,
      "# stdout\n",
      stdout,
      stdout.endsWith("\n") ? "" : "\n",
      "# stderr\n",
      stderr,
      stderr.endsWith("\n") ? "" : "\n",
    ].join(""),
  );
  if (result.error) throw result.error;
  return { ...result, combined, commandText };
}

function createWorkspaceRoot(artifactsDir = "") {
  if (!artifactsDir) return mkdtempSync(join(tmpdir(), tempRootPrefix));
  const parentDir = resolve(artifactsDir);
  ensureDir(parentDir);
  return mkdtempSync(join(parentDir, tempRootPrefix));
}

export function createContext(args) {
  const rootDir = createWorkspaceRoot(args.artifactsDir);
  const homeDir = join(rootDir, "home");
  const agentDir = join(rootDir, "agent");
  const binDir = join(rootDir, "bin");
  const workspaceDir = join(rootDir, "workspace");
  ensureDir(homeDir);
  ensureDir(agentDir);
  ensureDir(binDir);
  ensureDir(workspaceDir);
  const baseEnv = {
    ...buildBaseEnv(),
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    TLH_AGENT_DIR: agentDir,
    TLH_BIN_DIR: binDir,
    TLH_SKIP_TELEMETRY: "1",
    TLH_TELEMETRY_DISABLED: "1",
    PI_TELEMETRY: "0",
    TLH_SKIP_UPDATE_CHECK: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };
  const ctx = {
    rootDir,
    homeDir,
    agentDir,
    binDir,
    workspaceDir,
    baseEnv,
    candidateRef: args.candidateRef || "",
    acceptanceModel: args.acceptanceModel
      ? parseAcceptanceModel(
          typeof args.acceptanceModel === "string"
            ? args.acceptanceModel
            : args.acceptanceModel.raw,
        )
      : null,
    wrapperPath: join(binDir, "tlh"),
    redactions: [],
    artifactsByScenario: new Map(),
    artifactPaths: new Set(),
    installed: false,
    installBootstrapCheck: null,
    candidate: null,
    candidateEnv: null,
    candidateMetadata: null,
    candidateAttempted: false,
    candidateFailure: null,
  };
  ctx.redactions = buildRedactions(ctx);
  return ctx;
}

function listScenarios(selectedScenarios) {
  console.log("TLH live eval scenarios (opt-in; never part of npm run validate):\n");
  for (const scenario of selectedScenarios) {
    console.log(`- ${scenario.id} [${scenario.mode}]`);
    console.log(`  ${scenario.summary}`);
    console.log(`  prerequisites: ${scenario.prerequisites.join("; ")}`);
    if (scenario.acceptancePrerequisites?.length > 0) {
      console.log(`  acceptance prerequisites: ${scenario.acceptancePrerequisites.join("; ")}`);
    }
    console.log("");
  }
  console.log(
    "Model/TUI scenarios are prepared as manual scaffolds on purpose so TLH avoids brittle model-coupled automation in default CI.",
  );
  console.log(
    "To run them, use: node tests/evals/tlh-live-evals.mjs --run [--scenario <id>] or TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs",
  );
}

function bootstrapCheckArtifacts(candidateMode = false) {
  return candidateMode
    ? [
        "artifacts/candidate-bootstrap/resolve-commit.log",
        "artifacts/candidate-bootstrap/create-source-snapshot.log",
        "artifacts/candidate-bootstrap/extract-source-snapshot.log",
        "artifacts/candidate-bootstrap/pack-candidate.log",
        "artifacts/candidate-bootstrap/extract-packed-package.log",
        "artifacts/candidate-bootstrap/install-candidate.log",
        "artifacts/candidate-bootstrap/probe-runtime.log",
      ]
    : ["artifacts/install-bootstrap/install.log"];
}

function createFailureOutcome(details, artifacts = [], checks = []) {
  return {
    status: "failed",
    detail: details,
    checks:
      checks.length > 0
        ? checks
        : [
            createBinaryScoreCheck({
              id: "runner-detected-failure",
              label: "Runner detected a scenario failure",
              passed: false,
              details: details || "Review the saved artifacts for the failure details.",
              artifacts,
            }),
          ],
  };
}

function throwOutcomeError(message, outcome) {
  const error = new Error(message);
  error.liveEvalOutcome = outcome;
  throw error;
}

function candidateCommandLabel(phase) {
  const labels = {
    "resolve candidate commit": "resolve-commit",
    "create candidate source snapshot": "create-source-snapshot",
    "extract candidate source snapshot": "extract-source-snapshot",
    "pack candidate": "pack-candidate",
    "extract packed candidate package": "extract-packed-package",
    "install packaged candidate": "install-candidate",
    "probe installed upstream runtime": "probe-runtime",
  };
  return (
    labels[phase] ||
    String(phase || "candidate-command")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
  );
}

function ensureCandidateInstalled(ctx) {
  if (ctx.candidateFailure) {
    throwOutcomeError(ctx.candidateFailure.detail, ctx.candidateFailure.outcome);
  }
  if (ctx.candidate && ctx.installed && existsSync(ctx.wrapperPath)) {
    if (!ctx.installBootstrapCheck) {
      ctx.installBootstrapCheck = createBinaryScoreCheck({
        id: "install-bootstrap",
        label: "Packaged candidate install created and validated the tlh wrapper",
        passed: true,
        details: `frozen local commit ${ctx.candidate.commit} installed as ${ctx.candidate.packageName}@${ctx.candidate.packageVersion}; upstream runtime ${ctx.candidate.observedRuntimeVersion} matched expected ${ctx.candidate.expectedRuntimeVersion}`,
        artifacts: bootstrapCheckArtifacts(true),
      });
    }
    return ctx.installBootstrapCheck;
  }
  if (ctx.candidateAttempted) {
    const detail = `packaged candidate install did not create the expected wrapper: ${ctx.wrapperPath}; cleanup: rm -rf ${quoteShellWord(ctx.rootDir)}`;
    const outcome = createFailureOutcome(detail, bootstrapCheckArtifacts(true));
    ctx.candidateFailure = { detail, outcome };
    throwOutcomeError(detail, outcome);
  }
  ctx.candidateAttempted = true;
  console.log("[bootstrap] Preparing a frozen local candidate snapshot and isolated install ...");
  try {
    const candidate = setupPackagedCandidate({
      repoRoot,
      candidateRef: ctx.candidateRef,
      rootDir: ctx.rootDir,
      homeDir: ctx.homeDir,
      agentDir: ctx.agentDir,
      binDir: ctx.binDir,
      baseEnv: ctx.baseEnv,
      commandRunner: (specification) =>
        runCommand(ctx, {
          scenarioId: "candidate-bootstrap",
          label: candidateCommandLabel(specification.phase),
          command: specification.command,
          args: specification.args,
          cwd: specification.cwd,
          env: specification.env,
          timeoutMs: specification.timeoutMs || installTimeoutMs,
        }),
      onMetadata: (metadata) => {
        ctx.candidateMetadata = metadata;
      },
    });
    ctx.candidate = candidate;
    ctx.candidateMetadata = candidate.metadata;
    ctx.candidateEnv = candidate.env;
    ctx.baseEnv = candidate.env;
    ctx.installed = true;
    ctx.installBootstrapCheck = createBinaryScoreCheck({
      id: "install-bootstrap",
      label: "Packaged candidate install created and validated the tlh wrapper",
      passed: true,
      details: `frozen local commit ${candidate.commit} installed as ${candidate.packageName}@${candidate.packageVersion}; upstream runtime ${candidate.observedRuntimeVersion} matched expected ${candidate.expectedRuntimeVersion}`,
      artifacts: bootstrapCheckArtifacts(true),
    });
    return ctx.installBootstrapCheck;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cleanupPath =
      error && typeof error === "object" && error.cleanupPath ? error.cleanupPath : ctx.rootDir;
    const detail = `packaged candidate setup failed: ${message}; candidate diagnostics retained under ${cleanupPath}; cleanup: rm -rf ${quoteShellWord(cleanupPath)}`;
    const outcome = createFailureOutcome(detail, bootstrapCheckArtifacts(true), [
      createBinaryScoreCheck({
        id: "install-bootstrap",
        label: "Packaged candidate install created and validated the tlh wrapper",
        passed: false,
        details: detail,
        artifacts: bootstrapCheckArtifacts(true),
      }),
    ]);
    ctx.candidateFailure = { detail, outcome };
    throwOutcomeError(detail, outcome);
  }
}

function ensureInstalled(ctx) {
  if (ctx.candidateRef) return ensureCandidateInstalled(ctx);
  if (ctx.installed && existsSync(ctx.wrapperPath)) {
    if (!ctx.installBootstrapCheck) {
      ctx.installBootstrapCheck = createBinaryScoreCheck({
        id: "install-bootstrap",
        label: "Bootstrap isolated install created the tlh wrapper",
        passed: true,
        details: `bootstrap wrapper verified at ${ctx.wrapperPath}`,
        artifacts: bootstrapCheckArtifacts(),
      });
    }
    return ctx.installBootstrapCheck;
  }
  requireCommands(["bash", "node", "npm", "git"], ctx);
  console.log("[bootstrap] Installing TLH into an isolated temp HOME/agent/bin ...");
  const installEnv = {
    ...ctx.baseEnv,
    TLH_PACKAGE_SOURCE: `file:${repoRoot}`,
  };
  const result = runCommand(ctx, {
    scenarioId: "install-bootstrap",
    label: "install",
    command: "bash",
    args: [
      "install.sh",
      "--track",
      "custom",
      "--agent-dir",
      ctx.agentDir,
      "--bin-dir",
      ctx.binDir,
      "--wrapper-name",
      "tlh",
    ],
    cwd: repoRoot,
    env: installEnv,
    timeoutMs: installTimeoutMs,
  });
  if (result.status !== 0) {
    const detail = `bootstrap install failed with status ${result.status ?? "null"}; see ${join(ctx.rootDir, "artifacts", "install-bootstrap", "install.log")}`;
    throwOutcomeError(
      detail,
      createFailureOutcome(detail, bootstrapCheckArtifacts(), [
        createBinaryScoreCheck({
          id: "install-bootstrap",
          label: "Bootstrap isolated install created the tlh wrapper",
          passed: false,
          details: detail,
          artifacts: bootstrapCheckArtifacts(),
        }),
      ]),
    );
  }
  if (!existsSync(ctx.wrapperPath)) {
    const detail = `bootstrap install finished without creating wrapper: ${ctx.wrapperPath}`;
    throwOutcomeError(
      detail,
      createFailureOutcome(detail, bootstrapCheckArtifacts(), [
        createBinaryScoreCheck({
          id: "install-bootstrap",
          label: "Bootstrap isolated install created the tlh wrapper",
          passed: false,
          details: detail,
          artifacts: bootstrapCheckArtifacts(),
        }),
      ]),
    );
  }
  ctx.installed = true;
  ctx.installBootstrapCheck = createBinaryScoreCheck({
    id: "install-bootstrap",
    label: "Bootstrap isolated install created the tlh wrapper",
    passed: true,
    details: `bootstrap wrapper verified at ${ctx.wrapperPath}`,
    artifacts: bootstrapCheckArtifacts(),
  });
  return ctx.installBootstrapCheck;
}

function scenarioHelpers(ctx) {
  return {
    ensureInstalled,
    writeArtifact,
    runCommand: (specification) => runCommand(ctx, specification),
  };
}

function runInstallUpdateSmoke(ctx) {
  if (ctx.candidateRef) {
    throw new Error(
      "--candidate-ref cannot be combined with install-update-smoke; candidate mode never updates away from the frozen commit",
    );
  }
  const checks = [ensureInstalled(ctx)];
  const defaultsArtifact = "artifacts/install-update-smoke/defaults-list.log";
  const defaultsResult = runCommand(ctx, {
    scenarioId: "install-update-smoke",
    label: "defaults-list",
    command: ctx.wrapperPath,
    args: ["defaults", "list"],
    cwd: ctx.workspaceDir,
    env: ctx.baseEnv,
    timeoutMs: commandTimeoutMs,
  });
  const defaultsPassed = defaultsResult.status === 0;
  checks.push(
    createBinaryScoreCheck({
      id: "defaults-list",
      label: "Installed wrapper lists bundled default extensions",
      passed: defaultsPassed,
      details: defaultsPassed
        ? "tlh defaults list exited 0 in the isolated workspace."
        : `installed wrapper failed before update; see ${join(ctx.rootDir, "artifacts", "install-update-smoke", "defaults-list.log")}`,
      artifacts: [defaultsArtifact],
    }),
  );
  if (!defaultsPassed) {
    return createFailureOutcome(
      `installed wrapper failed before update; see ${join(ctx.rootDir, "artifacts", "install-update-smoke", "defaults-list.log")}`,
      [defaultsArtifact],
      checks,
    );
  }
  const updateArtifact = "artifacts/install-update-smoke/update.log";
  const updateResult = runCommand(ctx, {
    scenarioId: "install-update-smoke",
    label: "update",
    command: ctx.wrapperPath,
    args: ["update", "--track", "ref", "--ref", "main", "--package-source", `file:${repoRoot}`],
    cwd: ctx.workspaceDir,
    env: ctx.baseEnv,
    timeoutMs: installTimeoutMs,
  });
  const updatePassed = updateResult.status === 0;
  checks.push(
    createBinaryScoreCheck({
      id: "update",
      label: "Installed wrapper updates against the current checkout",
      passed: updatePassed,
      details: updatePassed
        ? "tlh update exited 0 on ref main with the current checkout file: package source."
        : `tlh update failed with status ${updateResult.status ?? "null"}; see ${join(ctx.rootDir, "artifacts", "install-update-smoke", "update.log")}`,
      artifacts: [updateArtifact],
    }),
  );
  if (!updatePassed) {
    return createFailureOutcome(
      `tlh update failed with status ${updateResult.status ?? "null"}; see ${join(ctx.rootDir, "artifacts", "install-update-smoke", "update.log")}`,
      [updateArtifact],
      checks,
    );
  }
  const statePath = join(ctx.agentDir, "tlh", "install-state.json");
  const stateArtifact = "artifacts/install-update-smoke/install-state.json";
  const stateExists = existsSync(statePath);
  let statePassed = false;
  let stateDetail = `missing install metadata after live smoke: ${statePath}`;
  if (stateExists) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      writeArtifact(ctx, stateArtifact, `${JSON.stringify(state, null, 2)}\n`);
      statePassed =
        state.track === "ref" &&
        state.ref === "main" &&
        state.packageSource === `file:${repoRoot}` &&
        state.wrapperName === "tlh";
      stateDetail = statePassed
        ? "install-state.json recorded ref main, the current checkout file: package source, and tlh wrapper name."
        : "install-state.json did not preserve the expected ref main, current checkout file: package source, and tlh wrapper name.";
    } catch (error) {
      writeArtifact(ctx, stateArtifact, readFileSync(statePath, "utf8"));
      stateDetail = `install-state.json was unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  checks.push(
    createBinaryScoreCheck({
      id: "install-state",
      label: "Install state reflects the ref update source",
      passed: statePassed,
      details: stateDetail,
      artifacts: stateExists ? [stateArtifact] : [],
    }),
  );
  if (!statePassed) {
    return createFailureOutcome(stateDetail, stateExists ? [stateArtifact] : [], checks);
  }
  return {
    status: "passed",
    detail: `wrapper: ${ctx.wrapperPath}`,
    checks,
  };
}

const bootstrapCommandPrerequisites = ["bash", "node", "npm", "git"];
const bootstrapNetworkPrerequisite = "network access when install/default-extension setup needs it";

export const allScenarios = [
  {
    id: "architect-e2e",
    mode: "manual",
    summary: "Prepare a ticketed fixture repo for a real architect -> developer end-to-end run.",
    prerequisites: [
      "interactive terminal",
      "model auth",
      ...bootstrapCommandPrerequisites,
      bootstrapNetworkPrerequisite,
    ],
    acceptancePrerequisites: [
      "candidate mode (--candidate-ref COMMIT)",
      `explicit acceptance model (--acceptance-model ${ACCEPTANCE_MODEL_FORMAT})`,
      "preparation only; missing live capabilities remain blocked",
    ],
    rubrics: [
      {
        id: "architect-orchestration-boundary",
        label: "Architect stays in orchestration mode",
        details:
          "Confirm the primary session scopes the work, manages ticket/developer flow, and does not edit the fixture files directly.",
      },
      {
        id: "ticketed-developer-flow",
        label: "Approved ticket and developer implementation flow occurs",
        details:
          "Verify the run uses the normal ticket/developer workflow instead of bypassing delegation for the requested change.",
      },
      {
        id: "fixture-repo-contained-change",
        label: "All edits and validation stay inside the fixture repo",
        details:
          "Check that any code changes and validation are contained to the prepared fixture repo so cleanup remains trivial.",
      },
    ],
    run: (ctx) => prepareArchitectAcceptanceScenario(ctx, scenarioHelpers(ctx)),
  },
  {
    id: "subagent-acceptance",
    mode: "manual",
    summary: "Prepare guided, offline-safe evidence scaffolding for all nine bundled minor roles.",
    prerequisites: [
      "interactive terminal",
      "candidate mode (--candidate-ref COMMIT)",
      `explicit acceptance model (--acceptance-model ${ACCEPTANCE_MODEL_FORMAT})`,
      ...bootstrapCommandPrerequisites,
      "preparation only; conditional live capabilities stay blocked when unavailable",
    ],
    rubrics: SUBAGENT_ACCEPTANCE_CHECKS.map((check) => ({
      id: check.id,
      label: check.label,
      details: `${check.expectedSignal} ${check.captureGuidance}`,
    })),
    run: (ctx) => prepareSubagentAcceptanceScenario(ctx, scenarioHelpers(ctx)),
  },
  {
    id: "rush-product-bug-hunter",
    mode: "manual",
    summary:
      "Prepare one fixture repo with prompts for Rush, product, and bug-hunter behavior checks.",
    prerequisites: [
      "interactive terminal",
      "model auth",
      ...bootstrapCommandPrerequisites,
      bootstrapNetworkPrerequisite,
    ],
    rubrics: [
      {
        id: "rush-direct-edit-boundary",
        label: "Rush edits directly and validates narrowly",
        details:
          "Confirm Rush fixes the bug directly in the fixture repo and reports narrow validation instead of starting ticket ceremony for this bounded task.",
      },
      {
        id: "product-non-implementing-boundary",
        label: "Product stays non-implementing and returns a ticket-shaped artifact",
        details:
          "Verify product mode clarifies requirements and hands back a tk-ready artifact without editing source files or running implementation loops.",
      },
      {
        id: "bug-hunter-read-only-boundary",
        label: "Bug-hunter remains investigative and read-only",
        details:
          "Check that bug-hunter explains root cause and candidate fixes without modifying files.",
      },
    ],
    run: (ctx) => preparePrimaryBehaviorScenario(ctx, scenarioHelpers(ctx)),
  },
  {
    id: "web-scout-network-research",
    mode: "manual",
    summary: "Prepare a web-scout research brief that exercises real Exa/network behavior.",
    prerequisites: [
      "interactive terminal",
      "model auth",
      ...bootstrapCommandPrerequisites,
      "network access (required for research; install/default-extension setup may also need it)",
      "EXA_API_KEY or equivalent isolated config",
    ],
    rubrics: [
      {
        id: "real-network-research",
        label: "Web-scout performs real network research",
        details:
          "Confirm the delegated research uses actual web/network access rather than unsupported guesses.",
      },
      {
        id: "cited-findings",
        label: "Returned findings include citations or sources",
        details:
          "Verify the final response includes concrete citations or linked sources for the reported findings.",
      },
      {
        id: "artifact-secret-hygiene",
        label: "Saved artifacts stay free of secrets",
        details:
          "Review the saved artifacts for accidental secret leakage before sharing them outside the temp workspace.",
      },
    ],
    run: (ctx) => prepareWebScoutScenario(ctx, scenarioHelpers(ctx)),
  },
  {
    id: "dirty-repo-guard",
    mode: "manual",
    summary: "Prepare a dirty git fixture repo for verifying the dirty-repo startup guard.",
    prerequisites: [
      "interactive terminal",
      ...bootstrapCommandPrerequisites,
      bootstrapNetworkPrerequisite,
    ],
    rubrics: [
      {
        id: "dirty-warning-before-work",
        label: "Dirty worktree warning appears before work begins",
        details:
          "Confirm TLH warns or prompts before the session starts working in the intentionally dirty fixture repo.",
      },
      {
        id: "dirty-warning-covers-risky-actions",
        label: "Warning appears before work that could hide the change",
        details:
          "Verify the guard triggers before starting, switching, or forking work that could obscure the uncommitted change.",
      },
      {
        id: "dirty-fixture-cleanup",
        label: "Cleanup remains trivial after the warning check",
        details:
          "Make sure leaving or removing the temp workspace is enough to undo the live eval fixture state.",
      },
    ],
    run: (ctx) => prepareDirtyRepoScenario(ctx, scenarioHelpers(ctx)),
  },
  {
    id: "install-update-smoke",
    mode: "automated",
    summary:
      "Run a real isolated install + tlh update smoke against this checkout with temp HOME/agent/bin.",
    prerequisites: [...bootstrapCommandPrerequisites, bootstrapNetworkPrerequisite],
    run: runInstallUpdateSmoke,
  },
];

function selectScenarios(args) {
  if (args.scenarios.length === 0) return allScenarios;
  const byId = new Map(allScenarios.map((scenario) => [scenario.id, scenario]));
  const selected = [];
  for (const id of args.scenarios) {
    const scenario = byId.get(id);
    if (!scenario) {
      throw new Error(
        `Unknown scenario id: ${id}. Available ids: ${allScenarios.map((entry) => entry.id).join(", ")}`,
      );
    }
    selected.push(scenario);
  }
  return selected;
}

function scenarioArtifactPaths(ctx, scenarioId) {
  return [...(ctx.artifactsByScenario.get(scenarioId) || [])].sort();
}

function sharedArtifactPaths(ctx, scenarioIds) {
  return [...ctx.artifactPaths]
    .filter(
      (artifactPath) =>
        !scenarioIds.some((scenarioId) => artifactPath.startsWith(`artifacts/${scenarioId}/`)),
    )
    .sort();
}

export function createScenarioScoreResult(ctx, scenario, outcome = {}) {
  const status = outcome.status || (scenario.mode === "automated" ? "passed" : "prepared");
  const detail = outcome.detail || "";
  const artifacts = scenarioArtifactPaths(ctx, scenario.id);
  let checks = outcome.checks || [];
  if (checks.length === 0 && status === "failed") {
    checks = createFailureOutcome(detail || `scenario ${scenario.id} failed`, artifacts).checks;
  } else if (checks.length === 0 && scenario.mode === "manual") {
    const guidance = artifacts.includes(`artifacts/${scenario.id}/README.md`)
      ? `Review artifacts/${scenario.id}/README.md and the prepared workspace before assigning a manual score.`
      : "Review the prepared workspace artifacts before assigning a manual score.";
    checks = (scenario.rubrics || []).map((rubric) =>
      createManualRubricCheck({
        id: rubric.id,
        label: rubric.label,
        details: `${rubric.details} ${guidance}`.trim(),
        artifacts,
      }),
    );
  } else if (checks.length === 0) {
    checks = [
      createBinaryScoreCheck({
        id: "scenario-completed",
        label: "Scenario completed without runner-detected failures",
        passed: status === "passed",
        details: detail || "Review the saved command logs for this scenario.",
        artifacts,
      }),
    ];
  }
  return createScenarioResult({
    scenarioId: scenario.id,
    mode: scenario.mode,
    summary: scenario.summary,
    status,
    detail,
    artifacts,
    checks,
  });
}

function formatScenarioScore(result) {
  if (result.score.type === "manual-rubric") {
    return `${result.score.manual.pending}/${result.score.manual.total} manual rubric pending`;
  }
  if (result.score.type === "mixed") {
    return `${result.score.automated.passed}/${result.score.automated.total} automated passed; ${result.score.manual.pending}/${result.score.manual.total} manual pending`;
  }
  return `${result.score.automated.passed}/${result.score.automated.total} automated passed`;
}

function writeWorkspaceResults(ctx, suiteResult) {
  writeArtifact(ctx, "results.json", `${JSON.stringify(suiteResult, null, 2)}\n`);
}

function writeTopLevelSummary(ctx, suiteResult) {
  const summary = [
    "# TLH live eval workspace",
    "",
    `Root: ${ctx.rootDir}`,
    `Home: ${ctx.homeDir}`,
    `Agent dir: ${ctx.agentDir}`,
    `Bin dir: ${ctx.binDir}`,
    `Wrapper: ${ctx.wrapperPath}`,
    "Structured results: results.json",
    "",
    "## Aggregate summary",
    `Run status: ${suiteResult.status}`,
    `Scenarios: ${suiteResult.summary.scenarios.total} total; ${suiteResult.summary.scenarios.passed} passed; ${suiteResult.summary.scenarios.prepared} prepared; ${suiteResult.summary.scenarios.failed} failed; ${suiteResult.summary.scenarios.other} blocked/other`,
    `Automated checks: ${suiteResult.summary.checks.automated.passed}/${suiteResult.summary.checks.automated.total} passed`,
    `Manual rubrics pending: ${suiteResult.summary.checks.manual.pending}/${suiteResult.summary.checks.manual.total}`,
    "",
    "## Scenario results",
    ...suiteResult.scenarios.map(
      (result) =>
        `- ${result.id}: ${result.status} (${formatScenarioScore(result)})${result.detail ? ` — ${result.detail}` : ""}`,
    ),
  ];
  if (suiteResult.artifacts.shared.length > 0) {
    summary.push(
      "",
      "## Shared artifacts",
      ...suiteResult.artifacts.shared.map((artifactPath) => `- ${artifactPath}`),
    );
  }
  summary.push("", "## Cleanup", `rm -rf ${quoteShellWord(ctx.rootDir)}`, "");
  writeArtifact(ctx, "README.md", summary.join("\n"));
}

export function writeWorkspaceOutputs(ctx, suiteResult) {
  writeTopLevelSummary(ctx, suiteResult);
  writeWorkspaceResults(ctx, suiteResult);
}

function printRunSummary(ctx, suiteResult, externalResultsPath = "") {
  console.log(`\nLive eval workspace: ${ctx.rootDir}`);
  for (const result of suiteResult.scenarios) {
    const prefix =
      result.status === "passed"
        ? "PASS"
        : result.status === "prepared"
          ? "PREP"
          : result.status === "blocked"
            ? "BLOCK"
            : "FAIL";
    console.log(
      `- [${prefix}] ${result.id} — ${formatScenarioScore(result)}${result.detail ? ` (${result.detail})` : ""}`,
    );
  }
  console.log(`Artifacts: ${join(ctx.rootDir, "artifacts")}`);
  if (externalResultsPath) console.log(`External results JSON: ${externalResultsPath}`);
  console.log(`Cleanup: rm -rf ${quoteShellWord(ctx.rootDir)}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const selectedScenarios = selectScenarios(args);
  if (args.list) {
    listScenarios(selectedScenarios);
    return;
  }
  const shouldRun = args.run || isTruthyEnv(process.env.TLH_RUN_LIVE_EVALS);
  if (!shouldRun) {
    listScenarios(selectedScenarios);
    console.log(
      "\nskipped: live evals are opt-in. Pass --run or set TLH_RUN_LIVE_EVALS=1 to execute them.",
    );
    return;
  }
  if (
    args.candidateRef &&
    selectedScenarios.some((scenario) => scenario.id === "install-update-smoke")
  ) {
    const selectionHint =
      args.scenarios.length === 0
        ? ". The default selection includes install-update-smoke; pass --scenario <id> (for example, --scenario architect-e2e) to choose candidate-compatible scenarios"
        : "";
    throw new Error(
      `--candidate-ref cannot be combined with install-update-smoke; candidate mode never updates away from the frozen commit${selectionHint}`,
    );
  }
  const ctx = createContext(args);
  const startedAt = new Date().toISOString();
  const scenarioResults = [];
  let failed = false;
  for (const scenario of selectedScenarios) {
    console.log(`\n[${scenario.id}] ${scenario.summary}`);
    try {
      const outcome = scenario.run(ctx) || {};
      if (outcome.status === "failed") failed = true;
      scenarioResults.push(createScenarioScoreResult(ctx, scenario, outcome));
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      const outcome =
        error && typeof error === "object" && "liveEvalOutcome" in error && error.liveEvalOutcome
          ? { ...error.liveEvalOutcome, detail: error.liveEvalOutcome.detail || message }
          : { status: "failed", detail: message };
      scenarioResults.push(createScenarioScoreResult(ctx, scenario, outcome));
    }
  }
  const keepWorkspace =
    failed ||
    args.keepArtifacts ||
    args.artifactsDir ||
    selectedScenarios.some((scenario) => scenario.mode === "manual");
  const finishedAt = new Date().toISOString();
  const suiteResult = createSuiteResult({
    selectedScenarios,
    scenarioResults,
    startedAt,
    finishedAt,
    keepWorkspace,
    failed,
    requestedResultsFile: Boolean(args.resultsFile),
    sharedArtifacts: sharedArtifactPaths(
      ctx,
      selectedScenarios.map((scenario) => scenario.id),
    ),
  });
  if (ctx.candidateMetadata) suiteResult.metadata.candidate = ctx.candidateMetadata;
  suiteResult.metadata.acceptanceModel = ctx.acceptanceModel?.raw || "";
  suiteResult.metadata.acceptanceModelContract = acceptanceModelMetadata(ctx.acceptanceModel);
  suiteResult.metadata.acceptanceSuiteVersion = ACCEPTANCE_SUITE_VERSION;
  suiteResult.metadata.candidateMode = Boolean(ctx.candidateRef);
  suiteResult.metadata.blockedScenarioIds = suiteResult.scenarios
    .filter((scenario) => scenario.status === "blocked")
    .map((scenario) => scenario.id);
  writeWorkspaceOutputs(ctx, suiteResult);
  const externalResultsPath = args.resultsFile
    ? writeResultsFile({
        results: suiteResult,
        filePath: args.resultsFile,
        rootDir: ctx.rootDir,
        transformText: (text) => redactText(text, ctx),
      })
    : "";
  printRunSummary(ctx, suiteResult, externalResultsPath);
  if (!keepWorkspace) {
    rmSync(ctx.rootDir, { recursive: true, force: true });
    console.log("Automated-only live eval finished cleanly; temp workspace removed.");
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  }
}
