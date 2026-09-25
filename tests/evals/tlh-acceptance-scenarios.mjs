#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const ACCEPTANCE_SUITE_VERSION = 1;
export const ACCEPTANCE_SUITE_ID = "tlh-packaged-acceptance";
export const ACCEPTANCE_MODEL_FORMAT = "PROVIDER/MODEL:LEVEL";
export const ACCEPTANCE_THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const BUNDLED_MINOR_ROLES = Object.freeze([
  "developer",
  "test-runner",
  "code-reviewer",
  "repo-scout",
  "diff-summarizer",
  "librarian",
  "web-scout",
  "oracle",
  "contrarian",
]);

const acceptanceRoot = "artifacts";
const defaultGitTimeoutMs = 15 * 1000;
const defaultCommandTimeoutMs = 60 * 1000;
const ticketCreatedAt = "2026-09-07T00:00:00Z";
const architectIndependentProbe =
  'node --input-type=module -e \'import { formatGreetingList } from "./src/greeter.mjs"; const names = [" Ada ", "", "TLH"]; const before = JSON.stringify(names); if (formatGreetingList(names) !== "Hello, Ada!\\nHello.\\nHello, TLH!" || formatGreetingList([]) !== "" || JSON.stringify(names) !== before) throw new Error("behavior mismatch");\'';

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeArtifactPath(pathValue) {
  return String(pathValue).split("\\").join("/");
}

function pathIsWithinRoot(pathValue, root) {
  const target = resolve(pathValue);
  const parent = resolve(root);
  return target === parent || target.startsWith(`${parent}${sep}`);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function fallbackWriteArtifact(ctx, relativePath, content) {
  const normalized = normalizeArtifactPath(relativePath);
  const target = resolve(ctx.rootDir, normalized);
  if (!pathIsWithinRoot(target, ctx.rootDir)) {
    throw new Error(
      `scenario artifact must remain inside the live eval workspace: ${relativePath}`,
    );
  }
  ensureDir(dirname(target));
  const redacted = typeof ctx.redactText === "function" ? ctx.redactText(content) : content;
  writeFileSync(target, redacted, "utf8");
  if (ctx.artifactPaths instanceof Set && normalized.startsWith(`${acceptanceRoot}/`)) {
    ctx.artifactPaths.add(normalized);
  }
  if (ctx.artifactsByScenario instanceof Map && normalized.startsWith(`${acceptanceRoot}/`)) {
    const [, scenarioId] = normalized.split("/");
    if (!ctx.artifactsByScenario.has(scenarioId))
      ctx.artifactsByScenario.set(scenarioId, new Set());
    ctx.artifactsByScenario.get(scenarioId).add(normalized);
  }
  return target;
}

function writeScenarioArtifact(ctx, helpers, relativePath, content) {
  const writer = helpers.writeArtifact || ctx.writeArtifact;
  return typeof writer === "function"
    ? writer(ctx, relativePath, content)
    : fallbackWriteArtifact(ctx, relativePath, content);
}

function runScenarioCommand(ctx, helpers, specification) {
  const runner = helpers.runCommand || ctx.runCommand;
  if (typeof runner === "function") return runner(specification);
  return spawnSync(specification.command, specification.args || [], {
    cwd: specification.cwd,
    env: specification.env,
    encoding: "utf8",
    timeout: specification.timeoutMs || defaultCommandTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function ensureScenarioInstalled(ctx, helpers) {
  const installer = helpers.ensureInstalled || ctx.ensureInstalled;
  if (typeof installer !== "function") {
    throw new Error("acceptance scenario preparation requires the runner install helper");
  }
  return installer(ctx);
}

function normalizeModelValue(value) {
  if (!value) return null;
  if (typeof value === "string") return parseAcceptanceModel(value);
  if (typeof value === "object" && typeof value.raw === "string") {
    return parseAcceptanceModel(value.raw);
  }
  throw new Error(`acceptance model must use ${ACCEPTANCE_MODEL_FORMAT}`);
}

export function parseAcceptanceModel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`--acceptance-model requires ${ACCEPTANCE_MODEL_FORMAT}`);
  const match = raw.match(/^([^/\s]+)\/([^\s:]+(?:\/[^\s:]+)*):([^\s:]+)$/);
  if (!match || !ACCEPTANCE_THINKING_LEVELS.includes(match[3])) {
    throw new Error(
      `--acceptance-model must use ${ACCEPTANCE_MODEL_FORMAT} with a supported thinking level (${ACCEPTANCE_THINKING_LEVELS.join(", ")})`,
    );
  }
  return Object.freeze({
    raw,
    provider: match[1],
    model: match[2],
    thinkingLevel: match[3],
  });
}

export function acceptanceModelWithThinking(modelValue, thinkingLevel) {
  const model = normalizeModelValue(modelValue);
  if (!model || !ACCEPTANCE_THINKING_LEVELS.includes(thinkingLevel)) {
    throw new Error(`acceptance model must use ${ACCEPTANCE_MODEL_FORMAT}`);
  }
  return `${model.provider}/${model.model}:${thinkingLevel}`;
}

export function acceptanceModelMetadata(modelValue) {
  const model = normalizeModelValue(modelValue);
  if (!model) return null;
  return {
    requested: model.raw,
    provider: model.provider,
    model: model.model,
    thinkingLevel: model.thinkingLevel,
    fallbackPolicy: "none",
  };
}

function fixtureGitEnvironment(ctx, repoDir) {
  const isolationRoot = join(ctx.rootDir, "fixture-git");
  const configRoot = join(isolationRoot, "config");
  const templateDir = join(isolationRoot, "template");
  const homeDir = ctx.homeDir || join(ctx.rootDir, "home");
  for (const path of [configRoot, templateDir, join(templateDir, "hooks"), homeDir]) {
    ensureDir(path);
  }
  const environment = { ...ctx.baseEnv };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  environment.HOME = homeDir;
  environment.PATH = ctx.baseEnv?.PATH || process.env.PATH || "";
  environment.XDG_CONFIG_HOME = join(isolationRoot, "xdg-config");
  environment.XDG_CACHE_HOME = join(isolationRoot, "xdg-cache");
  environment.XDG_DATA_HOME = join(isolationRoot, "xdg-data");
  environment.XDG_STATE_HOME = join(isolationRoot, "xdg-state");
  environment.GIT_CONFIG_GLOBAL = join(configRoot, "global.gitconfig");
  environment.GIT_CONFIG_SYSTEM = join(configRoot, "system.gitconfig");
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_AUTHOR_NAME = "TLH acceptance fixture";
  environment.GIT_AUTHOR_EMAIL = "tlh-acceptance-fixture@example.invalid";
  environment.GIT_COMMITTER_NAME = "TLH acceptance fixture";
  environment.GIT_COMMITTER_EMAIL = "tlh-acceptance-fixture@example.invalid";
  return { environment, repoDir, templateDir };
}

export function buildFixtureGitEnvironment(ctx, repoDir = "") {
  return fixtureGitEnvironment(ctx, repoDir);
}

function requireCommandSuccess(result, label, fixtureName) {
  if (!result || result.status !== 0) {
    const status = result?.status ?? result?.signal ?? result?.error?.code ?? "unknown";
    throw new Error(
      `failed to prepare fixture repo '${fixtureName}' during ${label} (exit ${status})`,
    );
  }
}

function assertFixturePath(repoDir, relativePath) {
  const target = resolve(repoDir, relativePath);
  if (!pathIsWithinRoot(target, repoDir)) {
    throw new Error(`fixture file escapes the disposable repository: ${relativePath}`);
  }
  return target;
}

function ticketText({ id, title, deps = [], description, acceptance }) {
  return `---
id: ${id}
status: open
deps: [${deps.join(", ")}]
links: []
created: ${ticketCreatedAt}
type: task
priority: 2
assignee: acceptance-operator
---
# ${title}

${description}

## Acceptance Criteria

${acceptance}
`;
}

function architectTicketFiles() {
  return {
    ".tickets/tlh-eval-architect-implementation.md": ticketText({
      id: "tlh-eval-architect-implementation",
      title: "Implement formatGreetingList in the disposable fixture",
      description:
        "Read EVAL_REQUEST.md and EXPECTED_BEHAVIOR.md. Implement only the requested helper in src/greeter.mjs and focused tests. The architect must preserve the normal plan and human approval gates before dispatching this ticket to developer.",
      acceptance:
        "The helper follows EXPECTED_BEHAVIOR.md, the focused tests cover the independent examples, and no file outside this fixture is changed.",
    }),
    ".tickets/tlh-eval-architect-final-validation.md": ticketText({
      id: "tlh-eval-architect-final-validation",
      title: "Run exact final validation for the disposable fixture",
      deps: ["tlh-eval-architect-implementation"],
      description: `This is a command-only final-validation ticket. Set TICKETS_DIR="$PWD/.tickets" and run tk show on this ticket first, then only the exact non-mutating commands listed here. It must not edit files, install packages, fix failures, or change tickets.\n\nExact commands:\n1. node --test test/greeter.test.mjs\n2. ${architectIndependentProbe}`,
      acceptance:
        "Run both exact commands above and report each exit status without changing the fixture.",
    }),
  };
}

function subagentTicketFiles() {
  return {
    ".tickets/tlh-eval-subagent-implementation.md": ticketText({
      id: "tlh-eval-subagent-implementation",
      title: "Implement boundedIncrement in the disposable subagent fixture",
      description:
        "Read EXPECTED_BEHAVIOR.md and role-tasks/developer.md. Implement the small boundedIncrement helper in src/value.mjs without invoking another subagent or changing ticket state.",
      acceptance:
        "boundedIncrement follows the independent behavior document and the focused fixture test passes.",
    }),
    ".tickets/tlh-eval-subagent-final-validation.md": ticketText({
      id: "tlh-eval-subagent-final-validation",
      title: "Run exact final validation for the disposable subagent fixture",
      deps: ["tlh-eval-subagent-implementation"],
      description:
        "Read this ticket before running the exact command. The command-only test-runner may only run the listed test command and report its result.",
      acceptance:
        "`node --test test/value.test.mjs` exits successfully after the implementation ticket is complete, with no edits or package operations by test-runner.",
    }),
  };
}

export function createFixtureRepo(ctx, scenarioId, name, files, options = {}, helpers = {}) {
  const repoDir = join(ctx.workspaceDir, name);
  ensureDir(repoDir);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = assertFixturePath(repoDir, relativePath);
    ensureDir(dirname(target));
    writeFileSync(target, content, "utf8");
  }
  const git = fixtureGitEnvironment(ctx, repoDir);
  const fixtureCommands = [
    ["git-init", ["init", "--template", git.templateDir]],
    ["git-config-name", ["config", "user.name", "TLH acceptance fixture"]],
    ["git-config-email", ["config", "user.email", "tlh-acceptance-fixture@example.invalid"]],
    ["git-config-hooks", ["config", "core.hooksPath", "/dev/null"]],
    ["git-config-signing", ["config", "commit.gpgSign", "false"]],
    ["git-config-tag-signing", ["config", "tag.gpgSign", "false"]],
    ["git-add", ["add", "--", "."]],
  ];
  const ticketPaths = Object.keys(files).filter((path) => path.startsWith(".tickets/"));
  if (ticketPaths.length > 0)
    fixtureCommands.push(["git-add-tickets", ["add", "-f", "--", ...ticketPaths]]);
  fixtureCommands.push([
    "git-commit",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgSign=false",
      "commit",
      "--no-verify",
      "-m",
      "Initial fixture",
    ],
  ]);
  for (const [label, args] of fixtureCommands) {
    const result = runScenarioCommand(ctx, helpers, {
      scenarioId,
      label,
      command: "git",
      args,
      cwd: repoDir,
      env: git.environment,
      timeoutMs: defaultGitTimeoutMs,
    });
    requireCommandSuccess(result, label, name);
  }
  const baselineResult = runScenarioCommand(ctx, helpers, {
    scenarioId,
    label: "git-rev-parse",
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repoDir,
    env: git.environment,
    timeoutMs: defaultGitTimeoutMs,
  });
  requireCommandSuccess(baselineResult, "git-rev-parse", name);
  if (options.dirty) {
    const dirtyPath = assertFixturePath(repoDir, options.dirtyFile || "README.md");
    const original = files[options.dirtyFile || "README.md"] || "";
    writeFileSync(dirtyPath, `${original}${options.dirtyAppend || "\nworktree change\n"}`, "utf8");
  }
  const statusResult = runScenarioCommand(ctx, helpers, {
    scenarioId,
    label: "git-status",
    command: "git",
    args: ["status", "--short"],
    cwd: repoDir,
    env: git.environment,
    timeoutMs: defaultGitTimeoutMs,
  });
  requireCommandSuccess(statusResult, "git-status", name);
  return {
    repoDir,
    baselineCommit: String(baselineResult.stdout || "").trim(),
    gitStatus: String(statusResult.stdout || "").trimEnd(),
    gitEnvironment: git.environment,
  };
}

function buildLaunchEnvironment(ctx) {
  if (!ctx.candidate) {
    return {
      HOME: ctx.homeDir,
      PATH: `${ctx.binDir}:${ctx.baseEnv?.PATH || ""}`,
    };
  }
  const candidate = ctx.candidate;
  const environment = {
    HOME: candidate.homeDir,
    USERPROFILE: candidate.homeDir,
    PATH: `${candidate.binDir}:${ctx.baseEnv?.PATH || ""}`,
    TMPDIR: candidate.tempDir,
    TMP: candidate.tempDir,
    TEMP: candidate.tempDir,
    XDG_CONFIG_HOME: candidate.xdgConfigHome,
    XDG_CACHE_HOME: candidate.xdgCacheHome,
    XDG_DATA_HOME: candidate.xdgDataHome,
    XDG_STATE_HOME: candidate.xdgStateHome,
    XDG_RUNTIME_DIR: candidate.xdgRuntimeDir,
    PI_CODING_AGENT_DIR: candidate.agentDir,
    PI_CODING_AGENT_SESSION_DIR: candidate.sessionDir,
    NPM_CONFIG_CACHE: candidate.npmCacheDir,
    NPM_CONFIG_USERCONFIG: candidate.npmUserConfigPath,
    NPM_CONFIG_GLOBALCONFIG: candidate.npmGlobalConfigPath,
    TLH_SKIP_TELEMETRY: "1",
    TLH_TELEMETRY_DISABLED: "1",
    TLH_SKIP_UPDATE_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
  };
  for (const name of ["TERM", "LANG", "LC_ALL", "LC_CTYPE", "COLORTERM"]) {
    if (ctx.baseEnv?.[name]) environment[name] = ctx.baseEnv[name];
  }
  if (candidate.env?.PI_OFFLINE) environment.PI_OFFLINE = candidate.env.PI_OFFLINE;
  return environment;
}

export function manualLaunchCommand(ctx, options = {}) {
  const environment = buildLaunchEnvironment(ctx);
  const model = normalizeModelValue(options.acceptanceModel || ctx.acceptanceModel);
  if (!ctx.candidate && !model) {
    return `HOME=${quoteShellWord(ctx.homeDir)} PATH=${quoteShellWord(`${ctx.binDir}:${ctx.baseEnv?.PATH || ""}`)} ${quoteShellWord(ctx.wrapperPath)}`;
  }
  const assignments = Object.entries(environment).map(
    ([name, value]) => `${name}=${quoteShellWord(value)}`,
  );
  const command = ["env", "-i", ...assignments, quoteShellWord(ctx.wrapperPath)];
  if (model) command.push("--model", quoteShellWord(model.raw));
  return command.join(" ");
}

function quoteShellWord(value) {
  const text = String(value ?? "");
  if (text === "") return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function fixtureRelativePath(ctx, fixture) {
  return normalizeArtifactPath(relative(ctx.rootDir, fixture.repoDir));
}

function candidateManifest(ctx) {
  const metadata = ctx.candidateMetadata || ctx.candidate?.metadata || {};
  return {
    required: true,
    mode: ctx.candidateRef ? "packaged-commit" : "missing",
    candidateRef: ctx.candidateRef || "",
    status: metadata.status || (ctx.candidate ? "ready" : "pending"),
    commit: metadata.commit || ctx.candidate?.commit || "",
    packageName: metadata.packageName || ctx.candidate?.packageName || "",
    packageVersion: metadata.packageVersion || ctx.candidate?.packageVersion || "",
    packageSha256: metadata.packageSha256 || ctx.candidate?.packageSha256 || "",
    observedRuntimeVersion:
      metadata.observedRuntimeVersion || ctx.candidate?.observedRuntimeVersion || "",
    validationKind: metadata.validationKind || "local-packed-commit",
  };
}

function checkManifestEntry(definition, scenarioId, missingPrerequisites = []) {
  const prerequisiteText = unique([...(definition.prerequisites || []), ...missingPrerequisites]);
  const captureLocations = unique(definition.captureLocations);
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind || "manual",
    status: "pending",
    passed: null,
    expectedSignal: definition.expectedSignal,
    expected: definition.expectedSignal,
    captureGuidance: definition.captureGuidance,
    capture: {
      guidance: definition.captureGuidance,
      locations: captureLocations,
    },
    captureLocations,
    captureReference: captureLocations[0] || "",
    humanReviewRequired: definition.humanReviewRequired === true,
    prerequisites: prerequisiteText,
    missingPrerequisite:
      definition.missingPrerequisiteOutcome ||
      "Record the missing prerequisite as blocked; do not substitute another provider, model, or signal.",
    missingPrerequisiteOutcome: {
      status: "blocked",
      detail:
        definition.missingPrerequisiteOutcome ||
        "Record the missing prerequisite as blocked; do not substitute another provider, model, or signal.",
    },
    scenarioId,
  };
}

function createEvidenceManifest(ctx, scenarioId, fixture, definitions, missingPrerequisites = []) {
  const model = normalizeModelValue(ctx.acceptanceModel);
  const status = missingPrerequisites.length > 0 ? "blocked" : "prepared";
  return {
    schemaVersion: 1,
    suiteId: ACCEPTANCE_SUITE_ID,
    suiteVersion: ACCEPTANCE_SUITE_VERSION,
    scenarioId,
    status,
    scoreStatus: "pending",
    acceptanceModel: model ? acceptanceModelMetadata(model) : null,
    candidate: candidateManifest(ctx),
    fixture: {
      workspacePath: fixtureRelativePath(ctx, fixture),
      baselineCommit: fixture.baselineCommit,
      gitStatus: fixture.gitStatus,
      ticketIds: fixture.ticketIds || [],
      expectedBehavior: fixture.expectedBehavior || "EXPECTED_BEHAVIOR.md",
      evidenceDirectory: fixture.evidenceDirectory || "evidence/",
    },
    prerequisites: {
      missing: missingPrerequisites,
      outcome: missingPrerequisites.length > 0 ? "blocked" : "pending-until-human-run",
    },
    checks: definitions.map((definition) =>
      checkManifestEntry(definition, scenarioId, missingPrerequisites),
    ),
    notes: [
      "This is a prepared evidence-manifest template, not a passing result.",
      "The operator must capture parent-visible dispatch and child task evidence separately.",
      "A successful dispatch receipt is not evidence that the task itself completed successfully.",
    ],
  };
}

function renderEvidenceInstructions({
  scenarioId,
  title,
  fixture,
  ctx,
  definitions,
  missingPrerequisites,
  launchNotes,
  workflowNotes,
}) {
  const model = normalizeModelValue(ctx.acceptanceModel);
  const launch = manualLaunchCommand(ctx, { acceptanceModel: model });
  const lines = [
    `# ${scenarioId}`,
    "",
    title,
    "",
    `Fixture repo: ${fixture.repoDir}`,
    `Baseline commit: ${fixture.baselineCommit}`,
    `Evidence manifest: artifacts/${scenarioId}/evidence-manifest.json`,
    `Cleanup: rm -rf ${ctx.rootDir}`,
    "",
    "## Launch contract",
    `- Candidate mode: ${ctx.candidateRef ? `required frozen commit ${ctx.candidateRef}` : "required; not supplied"}`,
    `- Acceptance model: ${model ? model.raw : "required; not supplied"}`,
    "- The requested model/effort is run-local. Do not substitute a provider, model, or thinking level.",
    "- Candidate-mode launch uses env -i with an allowlisted environment; host auth variables and profile files are not inherited. Do not replace env -i with a normal host environment.",
    "- Authenticate only inside the isolated candidate profile using the normal human-controlled login/config flow; never copy host auth files, refresh credentials automatically, or save credentials in artifacts.",
    "- If authentication, model availability, or runtime capability metadata is missing, record the affected check as blocked and stop that check.",
    "",
    "Launch from the fixture root:",
    "",
    `\tcd ${fixture.repoDir}`,
    `\t${launch}`,
    "",
    ...launchNotes,
    "",
    "## Human approval and operator boundaries",
    "- Keep the normal architect plan and ticket approval gates. Ask the human for approval; never script blanket approvals or mark tickets approved in advance.",
    '- Set TICKETS_DIR="$PWD/.tickets" for every fixture tk command so inherited project ticket routing cannot escape this disposable repo.',
    "- All child runs start from this installed parent session. Do not run a nested orchestrator or a second subagent controller.",
    "- Save only redacted, parent-visible evidence in the named artifact locations. Keep raw sessions and credentials private.",
    "",
    "## Per-check capture instructions",
  ];
  if (workflowNotes?.length) lines.push(...workflowNotes, "");
  for (const definition of definitions) {
    lines.push(
      `### ${definition.id}`,
      `**${definition.label}**`,
      "",
      `Expected signal: ${definition.expectedSignal}`,
      `Capture guidance: ${definition.captureGuidance}`,
      `Capture locations: ${unique(definition.captureLocations).join(", ")}`,
      `Missing prerequisite: ${definition.missingPrerequisiteOutcome || "blocked; do not substitute or claim success."}`,
      "",
    );
  }
  if (missingPrerequisites.length > 0) {
    lines.push(
      "## Prepared status",
      "",
      `This scaffold is blocked until: ${missingPrerequisites.join("; ")}. It remains pending and is not a pass.`,
      "",
    );
  }
  return lines.join("\n");
}

const ARCHITECT_EVIDENCE_CHECKS = Object.freeze([
  {
    id: "architect-plan-approval-gate",
    label: "Human approves the architect plan before implementation dispatch",
    expectedSignal:
      "The parent presents the scoped plan and waits for an explicit human approval before starting the implementation ticket.",
    captureGuidance:
      "Capture the parent-visible plan and the human approval turn; do not infer approval from a later child result.",
    captureLocations: ["artifacts/architect-e2e/evidence/plan-approval.jsonl"],
    missingPrerequisiteOutcome: "blocked if the approval turn is unavailable; never self-approve.",
  },
  {
    id: "architect-ticket-approval-gate",
    label: "Human approves the implementation and final-validation tickets",
    expectedSignal:
      "tk show identifies the real fixture tickets and the parent preserves the normal human approval gate before dispatch.",
    captureGuidance:
      "Capture tk show output for both fixture tickets plus the parent approval evidence; ticket files alone do not prove approval.",
    captureLocations: [
      "fixture/.tickets/tlh-eval-architect-implementation.md",
      "fixture/.tickets/tlh-eval-architect-final-validation.md",
      "artifacts/architect-e2e/evidence/ticket-approval.jsonl",
    ],
    missingPrerequisiteOutcome: "blocked if the ticket or approval evidence is missing.",
  },
  {
    id: "architect-developer-dispatch",
    label: "Architect dispatches developer for the approved implementation ticket",
    expectedSignal:
      "A parent-visible subagent call targets developer with the implementation ticket and the fixture cwd, followed by a child result.",
    captureGuidance:
      "Capture the native parent subagent call/result with runId, then reference correlated child status.json, result.json, events.jsonl, and session evidence; a receipt alone is not task completion.",
    captureLocations: ["artifacts/architect-e2e/evidence/developer-dispatch.jsonl"],
    missingPrerequisiteOutcome: "blocked when the developer role or requested model cannot launch.",
  },
  {
    id: "architect-test-runner-dispatch",
    label: "Architect dispatches command-only test-runner for final validation",
    expectedSignal:
      "A parent-visible test-runner call reads the final-validation ticket first and receives only its exact non-mutating commands.",
    captureGuidance:
      "Capture the native test-runner parent call/result, correlated child status/result/events/session artifacts, tk show evidence, and exact command output; do not count edits or fixes.",
    captureLocations: ["artifacts/architect-e2e/evidence/test-runner-dispatch.jsonl"],
    missingPrerequisiteOutcome:
      "blocked when the final ticket, exact command list, or command-only role is unavailable.",
  },
  {
    id: "architect-code-reviewer-dispatch",
    label: "Architect dispatches code-reviewer after implementation and validation",
    expectedSignal:
      "The code-reviewer receives the fixture diff and independent expected behavior after developer and test-runner results.",
    captureGuidance:
      "Capture the ordered native parent call/result, correlated child status/result/events/session artifacts, and the reviewer's read-only finding; do not ask the reviewer to edit.",
    captureLocations: ["artifacts/architect-e2e/evidence/code-reviewer-dispatch.jsonl"],
    missingPrerequisiteOutcome: "blocked when the review role or requested model cannot launch.",
  },
  {
    id: "architect-independent-function-behavior",
    label: "The implementation matches an independent expected-behavior document",
    expectedSignal:
      "The completed fixture function satisfies EXPECTED_BEHAVIOR.md examples and does not merely mirror a model claim.",
    captureGuidance:
      "Capture the fixture diff and a redacted JSON command result at function-behavior.json with command, cwd, exitCode, stdout, stderr, independent:true, and expectedBehaviorChecked:true; keep the expected document independent of the implementation.",
    captureLocations: [
      "fixture/EXPECTED_BEHAVIOR.md",
      "artifacts/architect-e2e/evidence/function-behavior.json",
    ],
    missingPrerequisiteOutcome:
      "blocked if the independent fixture expectation or validation output is missing.",
  },
  {
    id: "architect-orchestration-boundary",
    label: "Architect remains in orchestration mode",
    expectedSignal:
      "The parent does not directly edit fixture source files and delegates the implementation through the normal workflow.",
    captureGuidance:
      "Capture parentSessionId/parentSessionPath/parentEntryId/toolCallId, runId, childSessionId, and the correlated native call/result/job before recording parentEdited:false and childEdited:true; prose or booleans alone are not sufficient.",
    captureLocations: ["artifacts/architect-e2e/evidence/orchestration-boundary.jsonl"],
    missingPrerequisiteOutcome: "blocked when parent/child actor evidence cannot be separated.",
  },
  {
    id: "architect-fixture-repo-contained",
    label: "All implementation and validation changes stay in the disposable fixture",
    expectedSignal:
      "Fixture git status/diff contains the requested change and no source edits occur outside the fixture workspace.",
    captureGuidance:
      "Capture git status and diff from the fixture plus the parent run root; do not treat a clean unrelated checkout as proof.",
    captureLocations: ["artifacts/architect-e2e/evidence/fixture-containment.txt"],
    missingPrerequisiteOutcome: "blocked when fixture path or change records are unavailable.",
  },
]);

export const ARCHITECT_ACCEPTANCE_CHECKS = ARCHITECT_EVIDENCE_CHECKS;

function architectFixtureFiles() {
  return {
    "README.md":
      "# Architect acceptance fixture\n\nThis tiny repository is disposable. Use the real tk tickets and the normal architect -> developer -> test-runner -> code-reviewer workflow.\n",
    "package.json": `${JSON.stringify(
      {
        name: "tlh-architect-acceptance-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "src/greeter.mjs":
      'export function formatGreeting(name) {\n\tif (!name) return "Hello.";\n\treturn `Hello, ${String(name).trim()}!`;\n}\n',
    "test/greeter.test.mjs":
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { formatGreeting, formatGreetingList } from '../src/greeter.mjs';\n\ntest('formatGreeting trims names', () => {\n\tassert.equal(formatGreeting(' TLH '), 'Hello, TLH!');\n});\n\ntest('formatGreetingList follows the independent examples', () => {\n\tassert.equal(formatGreetingList([' Ada ', '', 'TLH']), 'Hello, Ada!\\nHello.\\nHello, TLH!');\n});\n",
    "EVAL_REQUEST.md":
      "Add formatGreetingList(names) to src/greeter.mjs and focused tests. It must preserve input order, delegate each name to the existing formatGreeting behavior, join lines with a single newline, return an empty string for an empty list, and not mutate the input. Use the normal architect ticketed workflow; do not edit source files in the parent session.\n",
    "EXPECTED_BEHAVIOR.md":
      "# Independent expected behavior\n\nThe implementation must satisfy these examples without changing the input array:\n\n- `formatGreetingList([' Ada ', '', 'TLH'])` returns `Hello, Ada!\\nHello.\\nHello, TLH!`.\n- `formatGreetingList([])` returns the empty string.\n- The original names array remains in its original order and values.\n- The helper stays inside `src/greeter.mjs`; focused tests must cover the examples.\n",
    ...architectTicketFiles(),
  };
}

function architectTicketIds() {
  return ["tlh-eval-architect-implementation", "tlh-eval-architect-final-validation"];
}

function baseFixtureMetadata(
  fixture,
  expectedBehavior,
  ticketIds,
  evidenceDirectory = "evidence/",
) {
  fixture.expectedBehavior = expectedBehavior;
  fixture.ticketIds = ticketIds;
  fixture.evidenceDirectory = evidenceDirectory;
  return fixture;
}

function buildLegacyArchitectInstructions(ctx, fixture) {
  return `# architect-e2e\n\nRepo: ${fixture.repoDir}\nLaunch from repo root:\n\n\tcd ${fixture.repoDir}\n\t${manualLaunchCommand(ctx)}\n\nSuggested prompt:\n\n> In this fixture repo, use the normal TLH architect workflow to implement the request in EVAL_REQUEST.md. Keep the work small, create or use the needed tk ticket flow, delegate implementation, and report back with validation.\n\nWhat to verify:\n- architect stays in orchestration mode instead of editing directly\n- ticket/developer flow happens for the small requested change\n- resulting change stays inside this fixture repo\n- cleanup is easy because everything lives under ${ctx.rootDir}\n`;
}

export function prepareArchitectScenario(ctx, helpers = {}) {
  const model = normalizeModelValue(ctx.acceptanceModel);
  const packagedAcceptance = Boolean(ctx.candidateRef || model);
  const missingPrerequisites = [];
  if (packagedAcceptance && !ctx.candidateRef) {
    missingPrerequisites.push("--candidate-ref COMMIT (packaged candidate mode)");
  }
  if (packagedAcceptance && !model) {
    missingPrerequisites.push(`--acceptance-model ${ACCEPTANCE_MODEL_FORMAT}`);
  }
  if (packagedAcceptance && missingPrerequisites.length === 0)
    ensureScenarioInstalled(ctx, helpers);
  if (!packagedAcceptance) ensureScenarioInstalled(ctx, helpers);

  const fixture = baseFixtureMetadata(
    createFixtureRepo(
      ctx,
      "architect-e2e",
      "architect-e2e-repo",
      architectFixtureFiles(),
      {},
      helpers,
    ),
    "EXPECTED_BEHAVIOR.md",
    architectTicketIds(),
  );
  if (!packagedAcceptance) {
    writeScenarioArtifact(
      ctx,
      helpers,
      join("artifacts", "architect-e2e", "README.md"),
      buildLegacyArchitectInstructions(ctx, fixture),
    );
    return {
      status: "prepared",
      detail: `fixture repo: ${fixture.repoDir}`,
    };
  }

  const instructions = renderEvidenceInstructions({
    scenarioId: "architect-e2e",
    title:
      "Prepare a real architect -> developer -> command-only test-runner -> code-reviewer run for one specified function.",
    fixture,
    ctx,
    definitions: ARCHITECT_EVIDENCE_CHECKS,
    missingPrerequisites,
    launchNotes: [
      `Use the exact acceptance model ${model?.raw || "from --acceptance-model"} for the parent and every worker dispatch. The parent launch may use the ` +
        "`--model`" +
        " argument shown above; each `subagent` input must repeat the exact model instead of relying on fallback resolution.",
      "Read EVAL_REQUEST.md, EXPECTED_BEHAVIOR.md, and both fixture tickets before proposing work.",
      "Suggested parent request: present a small plan and wait for human approval; after ticket approval dispatch developer for implementation, then command-only test-runner for the two exact commands, then read-only code-reviewer. Never edit fixture source in the parent.",
    ],
    workflowNotes: [
      "Required order: architect plan + human approval -> implementation ticket + human approval -> developer -> final-validation ticket/test-runner -> code-reviewer.",
      `The test-runner prompt must say \`TICKETS_DIR="$PWD/.tickets" tk show tlh-eval-architect-final-validation\` first and then run only these exact commands: \`node --test test/greeter.test.mjs\` and \`${architectIndependentProbe}\`.`,
      "The code-reviewer is read-only and reviews the fixture diff against EXPECTED_BEHAVIOR.md after the test-runner result.",
    ],
  });
  const manifest = createEvidenceManifest(
    ctx,
    "architect-e2e",
    fixture,
    ARCHITECT_EVIDENCE_CHECKS,
    missingPrerequisites,
  );
  writeScenarioArtifact(
    ctx,
    helpers,
    "artifacts/architect-e2e/evidence-manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeScenarioArtifact(ctx, helpers, "artifacts/architect-e2e/README.md", instructions);
  return {
    status: missingPrerequisites.length > 0 ? "blocked" : "prepared",
    detail:
      missingPrerequisites.length > 0
        ? `acceptance scaffold blocked: ${missingPrerequisites.join("; ")}; fixture repo: ${fixture.repoDir}`
        : `acceptance scaffold prepared for fixture repo: ${fixture.repoDir}`,
  };
}

const roleTaskDescriptions = {
  developer:
    "Read .tickets/tlh-eval-subagent-implementation.md and EXPECTED_BEHAVIOR.md first. Implement only boundedIncrement in src/value.mjs, add focused tests if needed, and run no nested subagent or orchestrator.",
  "test-runner":
    'Set TICKETS_DIR="$PWD/.tickets" and read the fixture with `tk show tlh-eval-subagent-final-validation` first. Then run exactly `node --test test/value.test.mjs`; do not edit, install, fix, or change tickets. Report the command and exit status.',
  "code-reviewer":
    "Read EXPECTED_BEHAVIOR.md and inspect the fixture diff after implementation. Report read-only findings against the specified function; do not edit files or delegate.",
  "repo-scout":
    "Inspect README.md, EXPECTED_BEHAVIOR.md, package.json, src/value.mjs, and test/value.test.mjs. Return a concise path/convention map without editing or delegating.",
  "diff-summarizer":
    "Summarize the fixture diff for src/value.mjs and tests after implementation. Use read-only git inspection; do not edit, install, or delegate.",
  librarian:
    "Read LOCAL_REFERENCE.md and EXPECTED_BEHAVIOR.md, then return the relevant local references for boundedIncrement. Do not browse the network, edit, or delegate.",
  "web-scout":
    "Read RESEARCH_BRIEF.md. If the requested Exa/network capability is unavailable, report this check as blocked; never invent citations or substitute local text for network research. Do not edit or delegate.",
  oracle:
    "BOUNDARIED ACCEPTANCE SMOKE APPROVAL: give a read-only second opinion only on whether boundedIncrement's fixture behavior matches EXPECTED_BEHAVIOR.md. Do not turn this into planning, repository review, or delegation.",
  contrarian:
    "BOUNDARIED ACCEPTANCE SMOKE APPROVAL: stress-test only the boundedIncrement examples in EXPECTED_BEHAVIOR.md and identify one concrete counterexample if present. Do not perform a broad planning review or delegate.",
};

function roleTaskFile(role) {
  const supervisorNote =
    role === "developer"
      ? "\nFor the native-supervisor check, the parent may separately ask this child to call contact_supervisor with a bounded decision request; never spawn another subagent.\n"
      : "\nDo not call subagent or start an orchestrator from this child task.\n";
  return `# ${role} bounded acceptance task\n\n${roleTaskDescriptions[role]}${supervisorNote}\nParent capture target: artifacts/subagent-acceptance/evidence/roles/${role}-result.jsonl\n`;
}

function roleEvidencePlaceholders() {
  return {
    ...Object.fromEntries(
      BUNDLED_MINOR_ROLES.map((role) => [
        `evidence/${role}.md`,
        `# ${role} evidence\n\nParent operator: capture the parent-visible dispatch and the actual child task result here. A dispatch receipt alone is not task-success evidence.\n`,
      ]),
    ),
    "evidence/blocked-target.md":
      '# Blocked target evidence\n\nCapture the active parent session\'s non-allowlisted planner call and its native error result (`isError: true`, `details: { mode: "single", results: [] }`), plus the absence of a child run identity/job. A standalone `blocked: true` claim is incomplete.\n',
    "evidence/lifecycle.md":
      "# Lifecycle evidence\n\nCapture native supervisor pause/resume and async status/resume identities here.\n",
  };
}

function subagentFixtureFiles() {
  const roleTasks = Object.fromEntries(
    BUNDLED_MINOR_ROLES.map((role) => [`role-tasks/${role}.md`, roleTaskFile(role)]),
  );
  return {
    "README.md":
      "# Subagent acceptance fixture\n\nThis disposable repo supplies small named tasks for all nine bundled minor roles. Parent operators must dispatch from the installed TLH session and capture evidence without nested orchestration.\n",
    "package.json": `${JSON.stringify(
      {
        name: "tlh-subagent-acceptance-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "src/value.mjs": "export function identity(value) {\n\treturn value;\n}\n",
    "test/value.test.mjs":
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { boundedIncrement } from '../src/value.mjs';\n\ntest('boundedIncrement follows the acceptance contract', () => {\n\tassert.equal(boundedIncrement(0), 1);\n\tassert.equal(boundedIncrement(4), 5);\n\tassert.equal(boundedIncrement(10), 10);\n\tassert.throws(() => boundedIncrement('4'), TypeError);\n});\n",
    "EVAL_REQUEST.md":
      "Implement boundedIncrement(value) in src/value.mjs. For finite numeric values, return value + 1 up to an inclusive upper bound of 10; return 10 at or above that bound. Throw TypeError for non-numbers and preserve the existing identity helper. Use the implementation ticket, then exact final validation.\n",
    "EXPECTED_BEHAVIOR.md":
      "# Independent expected behavior\n\n- `boundedIncrement(0)` returns `1`.\n- `boundedIncrement(4)` returns `5`.\n- `boundedIncrement(10)` and `boundedIncrement(11)` return `10`.\n- Non-numeric input throws `TypeError`.\n- The existing `identity` helper remains unchanged.\n",
    "LOCAL_REFERENCE.md":
      "# Local reference brief\n\nUse only this fixture's EVAL_REQUEST.md and EXPECTED_BEHAVIOR.md for the librarian smoke. The web-scout task has a separate RESEARCH_BRIEF.md and must report blocked when Exa/network access is absent.\n",
    "RESEARCH_BRIEF.md":
      "# Bounded research brief\n\nIf real web access is explicitly available, find one primary source describing bounded numeric increments or clamping and return a citation. If it is not available, record the missing Exa/network prerequisite; do not use this file as a fake citation.\n",
    "TASK_INDEX.md":
      "# Role task index\n\nEach role reads its named file under role-tasks/ and writes parent-captured evidence to the corresponding evidence/<role>.md placeholder.\n\nThe role list is developer, test-runner, code-reviewer, repo-scout, diff-summarizer, librarian, web-scout, oracle, and contrarian.\n",
    ...roleTasks,
    ...roleEvidencePlaceholders(),
    ...subagentTicketFiles(),
  };
}

function subagentTicketIds() {
  return ["tlh-eval-subagent-implementation", "tlh-eval-subagent-final-validation"];
}

function subagentDefinitions() {
  const roleDefinitions = [];
  for (const role of BUNDLED_MINOR_ROLES) {
    roleDefinitions.push(
      {
        id: `subagent-acceptance-${role}-dispatch`,
        label: `${role} dispatch is accepted by the installed parent`,
        expectedSignal: `The parent-visible subagent call targets ${role} with the fixture cwd, exact requested model, and fresh user-scope execution, and returns a dispatch receipt or terminal result.`,
        captureGuidance: `Capture the ${role} native parent tool call and returned tool result at the named role evidence path, then reference the correlated child status.json, result.json, events.jsonl, and child session. A receipt alone is not task completion.`,
        captureLocations: [
          `artifacts/subagent-acceptance/evidence/roles/${role}-dispatch.jsonl`,
          `fixture/evidence/${role}.md`,
        ],
        missingPrerequisiteOutcome:
          role === "web-scout"
            ? "blocked when Exa/network access is unavailable; do not replace it with local research."
            : "blocked when requested model auth or the role cannot launch; do not use a fallback.",
      },
      {
        id: `subagent-acceptance-${role}-execution`,
        label: `${role} task produces the role-appropriate result`,
        expectedSignal: `The ${role} child returns the expected bounded task result and the parent captures it separately from dispatch success.`,
        captureGuidance: `Compare the child result with role-tasks/${role}.md and EXPECTED_BEHAVIOR.md where applicable; record blocked or failed task execution honestly.`,
        captureLocations: [
          `artifacts/subagent-acceptance/evidence/roles/${role}-result.jsonl`,
          `fixture/evidence/${role}.md`,
        ],
        missingPrerequisiteOutcome:
          role === "web-scout"
            ? "blocked when Exa/network access is unavailable; no fabricated citation or static substitute."
            : "blocked when the child result or required role capability is unavailable.",
      },
    );
  }
  roleDefinitions.push(
    {
      id: "subagent-acceptance-nonallowlisted-block",
      label: "A non-allowlisted target is blocked before launch",
      expectedSignal:
        "A parent-visible request for an unknown target such as planner returns the native error shape (isError:true, details.mode:single, details.results:[]) and no child run identity/job is created.",
      captureGuidance:
        "Capture the active parent session's subagent call/result and the empty native result details; an asserted blocked boolean or an error after launch is incomplete.",
      captureLocations: ["artifacts/subagent-acceptance/evidence/blocked-target.jsonl"],
      missingPrerequisiteOutcome:
        "blocked if the parent tool result and no-launch evidence cannot be captured.",
    },
    {
      id: "subagent-acceptance-user-scope",
      label: "Canonical minor dispatch uses isolated user scope",
      expectedSignal:
        "The correlated native parent call records agentScope:user and the child launch evidence records resolvedScope:user and childScope:user.",
      captureGuidance:
        "Capture the actual parent call/result, status/result job, child session, and scope fields; do not infer scope from a static agent definition or a boolean-only record.",
      captureLocations: ["artifacts/subagent-acceptance/evidence/user-scope.jsonl"],
      missingPrerequisiteOutcome: "blocked when runtime scope metadata is unavailable.",
    },
    {
      id: "subagent-acceptance-fresh-context",
      label: "Each minor starts a fresh context",
      expectedSignal:
        "The child has a new session/context identity and no inherited parent transcript/context input.",
      captureGuidance:
        "Capture parent and child session identifiers plus the dispatch input proving context was not supplied; do not award from child prose.",
      captureLocations: ["artifacts/subagent-acceptance/evidence/fresh-context.jsonl"],
      missingPrerequisiteOutcome:
        "blocked when parent/child identity evidence is missing or mismatched.",
    },
    {
      id: "subagent-acceptance-native-supervisor-pause-resume",
      label: "Native contact_supervisor pauses and guided resume continues the same child",
      expectedSignal:
        "A child request reaches the native supervisor channel, status becomes paused with no child process, and guided resume continues the same logical child.",
      captureGuidance:
        "Capture contact_supervisor request, supervisor pending/status, resume input, and the resumed child identity/result; do not use a synthetic controller.",
      captureLocations: ["artifacts/subagent-acceptance/evidence/supervisor-pause-resume.jsonl"],
      missingPrerequisiteOutcome:
        "blocked when native supervisor or interactive human guidance is unavailable.",
    },
    {
      id: "subagent-acceptance-async-status-resume",
      label: "Async status and resume address the same logical job",
      expectedSignal:
        "An async receipt is followed by status and resume calls retaining the same async/job identity and a terminal child result.",
      captureGuidance:
        "Capture receipt, status, resume request/result, and final status with the same logical id; do not count a new dispatch as resume.",
      captureLocations: ["artifacts/subagent-acceptance/evidence/async-status-resume.jsonl"],
      missingPrerequisiteOutcome:
        "blocked when async lifecycle or same-job identity evidence is unavailable.",
    },
    {
      id: "subagent-acceptance-compact-description",
      humanReviewRequired: true,
      label: "Parent-facing subagent tool description is compact and safety-complete",
      expectedSignal:
        "The installed parent exposes a compact description retaining supported single/parallel/async, fresh-context, scope, and safety guidance without a stale broad contract.",
      captureGuidance:
        "Capture the actual parent tool schema/description from the live installed session for human review; static source text is not proof.",
      captureLocations: ["artifacts/subagent-acceptance/evidence/compact-description.txt"],
      missingPrerequisiteOutcome:
        "blocked when the parent schema cannot be captured; do not infer a rendering pass.",
    },
    {
      id: "subagent-acceptance-max-thinking-badge",
      humanReviewRequired: true,
      label: "Supported max-thinking level renders the max badge",
      expectedSignal:
        "The exact requested model advertises max in live capability metadata and a child TUI/render capture shows the max thinking badge.",
      captureGuidance:
        "Use only the requested model and only when its live metadata supports max; capture capability metadata and the human-reviewed badge. Otherwise record blocked.",
      captureLocations: ["artifacts/subagent-acceptance/evidence/max-thinking-badge.txt"],
      missingPrerequisiteOutcome:
        "blocked when max is unsupported or metadata/rendering evidence is unavailable; no model substitution.",
    },
  );
  return Object.freeze(roleDefinitions);
}

export const SUBAGENT_ACCEPTANCE_CHECKS = subagentDefinitions();

function subagentFixtureMetadata(fixture) {
  return baseFixtureMetadata(fixture, "EXPECTED_BEHAVIOR.md", subagentTicketIds(), "evidence/");
}

function subagentPrerequisites(ctx) {
  const missing = [];
  if (!ctx.candidateRef) missing.push("--candidate-ref COMMIT (packaged candidate mode)");
  if (!normalizeModelValue(ctx.acceptanceModel)) {
    missing.push(`--acceptance-model ${ACCEPTANCE_MODEL_FORMAT}`);
  }
  return missing;
}

function subagentLaunchNotes(model) {
  return [
    `Dispatch every role with the exact model field ${model?.raw || "from --acceptance-model"}; do not rely on bundled fallback resolution.`,
    "Include agentScope=user and omit inherited context for each canonical role; capture the actual parent-visible input and child identity.",
    "Read TASK_INDEX.md and the relevant role-tasks/<role>.md before each bounded dispatch.",
    "Request a non-allowlisted planner target only as the explicit negative check and verify the native isError:true result with details.results:[] before launch, no child run identity/job, and no boolean-only substitute.",
    "The web-scout check needs real Exa/network access; if it is unavailable, leave that check blocked rather than substituting local text.",
    "If a requested source needs GitHub access and that access is unavailable, leave the check blocked rather than fabricating or substituting a citation.",
    "The oracle and contrarian tasks are explicitly approved only for the bounded fixture smoke text in their task files, not for unsolicited planning or repository review.",
  ];
}

export function prepareSubagentAcceptanceScenario(ctx, helpers = {}) {
  const missingPrerequisites = subagentPrerequisites(ctx);
  if (missingPrerequisites.length === 0) ensureScenarioInstalled(ctx, helpers);
  const fixture = subagentFixtureMetadata(
    createFixtureRepo(
      ctx,
      "subagent-acceptance",
      "subagent-acceptance-repo",
      subagentFixtureFiles(),
      {},
      helpers,
    ),
  );
  const model = normalizeModelValue(ctx.acceptanceModel);
  const instructions = renderEvidenceInstructions({
    scenarioId: "subagent-acceptance",
    title:
      "Prepare a guided acceptance run for all nine bundled minor roles and the lifecycle/safety checks.",
    fixture,
    ctx,
    definitions: SUBAGENT_ACCEPTANCE_CHECKS,
    missingPrerequisites,
    launchNotes: subagentLaunchNotes(model),
    workflowNotes: [
      "Run every check from this one installed parent session. For each role, record dispatch acceptance and actual task execution as separate evidence.",
      "Use a human-operated native contact_supervisor pause and guided resume: ask a bounded child decision, wait for supervisor status, then resume the same child after the human answer. Do not write a hidden controller, PTY automation, or model-as-judge.",
      "For async lifecycle, use status and resume on the same receipt id. A second fresh dispatch is not evidence of same-job resume.",
      "Missing Codex auth, Exa access, GitHub access, or supported max metadata is blocked evidence; do not buy access, refresh credentials, fabricate results, or substitute a model.",
      `For the optional max badge, use ${model ? acceptanceModelWithThinking(model, "max") : "the exact requested model with :max"} only if live capability metadata advertises max; otherwise record blocked.`,
    ],
  });
  const manifest = createEvidenceManifest(
    ctx,
    "subagent-acceptance",
    fixture,
    SUBAGENT_ACCEPTANCE_CHECKS,
    missingPrerequisites,
  );
  manifest.roleTasks = Object.fromEntries(
    BUNDLED_MINOR_ROLES.map((role) => [role, `role-tasks/${role}.md`]),
  );
  manifest.dispatchPolicy = {
    allowedRoles: [...BUNDLED_MINOR_ROLES],
    deniedTargetExample: "planner",
    requiredScope: "user",
    freshContext: true,
    nestedSubagents: false,
    fallbackPolicy: "none",
  };
  manifest.blockedCapabilityPolicy = {
    codexAuth: "blocked when unavailable",
    exaAccess: "blocked when unavailable",
    githubAccess: "blocked when unavailable",
    maxThinkingMetadata: "blocked when unsupported or unavailable",
  };
  manifest.negativeFixtures = [
    {
      id: "subagent-acceptance-missing-prerequisites",
      expectedStatus: "blocked",
      evidence: "artifacts/subagent-acceptance/evidence-manifest.json",
    },
    {
      id: "subagent-acceptance-nonallowlisted-target",
      expectedStatus: "blocked-before-launch",
      evidence: "artifacts/subagent-acceptance/evidence/blocked-target.jsonl",
    },
    {
      id: "subagent-acceptance-web-access-unavailable",
      expectedStatus: "blocked",
      evidence: "artifacts/subagent-acceptance/evidence/roles/web-scout-result.jsonl",
    },
  ];
  writeScenarioArtifact(
    ctx,
    helpers,
    "artifacts/subagent-acceptance/evidence-manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeScenarioArtifact(ctx, helpers, "artifacts/subagent-acceptance/README.md", instructions);
  return {
    status: missingPrerequisites.length > 0 ? "blocked" : "prepared",
    detail:
      missingPrerequisites.length > 0
        ? `acceptance scaffold blocked: ${missingPrerequisites.join("; ")}; fixture repo: ${fixture.repoDir}`
        : `acceptance scaffold prepared for fixture repo: ${fixture.repoDir}`,
  };
}

export function preparePrimaryBehaviorScenario(ctx, helpers = {}) {
  ensureScenarioInstalled(ctx, helpers);
  const fixture = createFixtureRepo(
    ctx,
    "rush-product-bug-hunter",
    "primary-behavior-repo",
    {
      "README.md":
        "# Primary behavior live eval fixture\n\nUse this repo to check Rush, product, and bug-hunter behavior boundaries.\n",
      "package.json": `${JSON.stringify(
        {
          name: "primary-behavior-fixture",
          private: true,
          type: "module",
          scripts: { test: "node --test" },
        },
        null,
        2,
      )}\n`,
      "src/cart.mjs":
        "export function totalWithTax(subtotalCents, quantity, taxRate = 0.1) {\n\tif (quantity <= 0) return subtotalCents * quantity;\n\tconst subtotal = subtotalCents * quantity;\n\treturn Math.floor(subtotal + subtotal * taxRate);\n}\n",
      "test/cart.test.mjs":
        "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { totalWithTax } from '../src/cart.mjs';\n\ntest('totalWithTax applies tax', () => {\n\tassert.equal(totalWithTax(500, 2, 0.1), 1100);\n});\n",
      "BUG_REPORT.md":
        "Users report negative totals when quantity is zero or negative, and totals are rounded down instead of to the nearest cent.\n",
      "PRODUCT_BRIEF.md":
        "Draft a ticket for coupon stacking rules without editing source files.\n",
    },
    {},
    helpers,
  );
  const instructions = `# rush-product-bug-hunter\n\nRepo: ${fixture.repoDir}\nLaunch from repo root:\n\n\tcd ${fixture.repoDir}\n\t${manualLaunchCommand(ctx)}\n\nSuggested prompts:\n\nRush\n> Switch to Rush and fix the bug described in BUG_REPORT.md. Edit directly, run narrow validation, and do not start ticket ceremony unless the task clearly outgrows Rush.\n\nProduct\n> Switch to product and turn PRODUCT_BRIEF.md into an implementation-ready tk ticket. Do not edit source files or run implementation loops.\n\nBug-hunter\n> Switch to bug-hunter and investigate the issue in BUG_REPORT.md. Explain the root cause and candidate fix, but do not modify files.\n\nWhat to verify:\n- Rush edits directly and validates narrowly\n- product stays non-implementing and hands back a ticket-shaped artifact\n- bug-hunter remains read-only and investigative\n`;
  writeScenarioArtifact(
    ctx,
    helpers,
    join("artifacts", "rush-product-bug-hunter", "README.md"),
    instructions,
  );
  return { status: "prepared", detail: `fixture repo: ${fixture.repoDir}` };
}

export function prepareWebScoutScenario(ctx, helpers = {}) {
  ensureScenarioInstalled(ctx, helpers);
  const briefDir = join(ctx.workspaceDir, "web-scout-brief");
  ensureDir(briefDir);
  writeFileSync(
    join(briefDir, "RESEARCH_BRIEF.md"),
    "Research the latest upstream Pi release notes and any recent Exa-facing changes relevant to TLH web-scout usage.\n",
    "utf8",
  );
  const instructions = `# web-scout-network-research\n\nWorkspace: ${briefDir}\nLaunch from that directory:\n\n\tcd ${briefDir}\n\t${manualLaunchCommand(ctx)}\n\nPrerequisites:\n- working model auth for the upstream runtime\n- network access\n- EXA_API_KEY in the environment or equivalent isolated pi-web-access config\n\nSuggested prompt:\n\n> Use the architect to delegate a web-scout research task based on RESEARCH_BRIEF.md. Return concise findings with citations, and do not write source files.\n\nWhat to verify:\n- web-scout actually performs network research instead of hallucinating\n- returned answer includes citations/sources\n- no secrets appear in saved artifacts under ${ctx.rootDir}\n`;
  writeScenarioArtifact(
    ctx,
    helpers,
    join("artifacts", "web-scout-network-research", "README.md"),
    instructions,
  );
  return { status: "prepared", detail: `workspace: ${briefDir}` };
}

export function prepareDirtyRepoScenario(ctx, helpers = {}) {
  ensureScenarioInstalled(ctx, helpers);
  const fixture = createFixtureRepo(
    ctx,
    "dirty-repo-guard",
    "dirty-repo-guard-repo",
    {
      "README.md":
        "# Dirty repo guard fixture\n\nThis repo should remain dirty after setup so TLH can warn before session work proceeds.\n",
      "notes.txt": "initial clean content\n",
    },
    { dirty: true, dirtyFile: "notes.txt", dirtyAppend: "uncommitted change\n" },
    helpers,
  );
  const instructions = `# dirty-repo-guard\n\nRepo: ${fixture.repoDir}\nCurrent git status:\n${fixture.gitStatus || "(clean unexpectedly)"}\n\nLaunch from repo root:\n\n\tcd ${fixture.repoDir}\n\t${manualLaunchCommand(ctx)}\n\nWhat to verify:\n- TLH warns or prompts before starting in this dirty worktree\n- the prompt appears before starting/switching/forking work that could hide the change\n- exiting the temp workspace is enough to undo the eval\n`;
  writeScenarioArtifact(
    ctx,
    helpers,
    join("artifacts", "dirty-repo-guard", "README.md"),
    instructions,
  );
  return { status: "prepared", detail: `dirty fixture repo: ${fixture.repoDir}` };
}

export const acceptanceScenarioDefinitions = Object.freeze({
  architect: ARCHITECT_ACCEPTANCE_CHECKS,
  subagent: SUBAGENT_ACCEPTANCE_CHECKS,
});

export const acceptanceScenarioVersion = ACCEPTANCE_SUITE_VERSION;

// Keep this module contributor-only: it prepares disposable files and git fixtures, but never
// invokes the installed wrapper or sends a provider request.
