#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
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
const gitTimeoutMs = 15 * 1000;
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

function runCommand(ctx, {
	scenarioId,
	label,
	command,
	args = [],
	cwd = repoRoot,
	env = ctx.baseEnv,
	timeoutMs = commandTimeoutMs,
}) {
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
		wrapperPath: join(binDir, "tlh"),
		redactions: [],
		artifactsByScenario: new Map(),
		artifactPaths: new Set(),
		installed: false,
		installBootstrapCheck: null,
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
		console.log("");
	}
	console.log("Model/TUI scenarios are prepared as manual scaffolds on purpose so TLH avoids brittle model-coupled automation in default CI.");
	console.log("To run them, use: node tests/evals/tlh-live-evals.mjs --run [--scenario <id>] or TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs");
}

function bootstrapCheckArtifacts() {
	return ["artifacts/install-bootstrap/install.log"];
}

function createFailureOutcome(details, artifacts = [], checks = []) {
	return {
		status: "failed",
		detail: details,
		checks: checks.length > 0
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

function ensureInstalled(ctx) {
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
		args: ["install.sh", "--track", "custom", "--agent-dir", ctx.agentDir, "--bin-dir", ctx.binDir],
		cwd: repoRoot,
		env: installEnv,
		timeoutMs: installTimeoutMs,
	});
	if (result.status !== 0) {
		const detail = `bootstrap install failed with status ${result.status ?? "null"}; see ${join(ctx.rootDir, "artifacts", "install-bootstrap", "install.log")}`;
		throwOutcomeError(detail, createFailureOutcome(detail, bootstrapCheckArtifacts(), [
			createBinaryScoreCheck({
				id: "install-bootstrap",
				label: "Bootstrap isolated install created the tlh wrapper",
				passed: false,
				details: detail,
				artifacts: bootstrapCheckArtifacts(),
			}),
		]));
	}
	if (!existsSync(ctx.wrapperPath)) {
		const detail = `bootstrap install finished without creating wrapper: ${ctx.wrapperPath}`;
		throwOutcomeError(detail, createFailureOutcome(detail, bootstrapCheckArtifacts(), [
			createBinaryScoreCheck({
				id: "install-bootstrap",
				label: "Bootstrap isolated install created the tlh wrapper",
				passed: false,
				details: detail,
				artifacts: bootstrapCheckArtifacts(),
			}),
		]));
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

function gitConfigEnv(ctx) {
	return {
		...ctx.baseEnv,
		GIT_AUTHOR_NAME: "TLH Live Eval",
		GIT_AUTHOR_EMAIL: "live-evals@example.invalid",
		GIT_COMMITTER_NAME: "TLH Live Eval",
		GIT_COMMITTER_EMAIL: "live-evals@example.invalid",
	};
}

function createFixtureRepo(ctx, scenarioId, name, files, { dirty = false, dirtyFile = "README.md", dirtyAppend = "\nworktree change\n" } = {}) {
	const repoDir = join(ctx.workspaceDir, name);
	ensureDir(repoDir);
	for (const [relativePath, content] of Object.entries(files)) {
		const target = join(repoDir, relativePath);
		ensureDir(dirname(target));
		writeFileSync(target, content, "utf8");
	}
	const env = gitConfigEnv(ctx);
	for (const [label, args] of [
		["git-init", ["init"]],
		["git-config-name", ["config", "user.name", "TLH Live Eval"]],
		["git-config-email", ["config", "user.email", "live-evals@example.invalid"]],
		["git-add", ["add", "."]],
		["git-commit", ["commit", "-m", "Initial fixture"]],
	]) {
		const result = runCommand(ctx, {
			scenarioId,
			label,
			command: "git",
			args,
			cwd: repoDir,
			env,
			timeoutMs: gitTimeoutMs,
		});
		if (result.status !== 0) {
			throw new Error(`failed to prepare fixture repo '${name}' during ${label}`);
		}
	}
	if (dirty) {
		const dirtyPath = join(repoDir, dirtyFile);
		writeFileSync(dirtyPath, `${files[dirtyFile] || ""}${dirtyAppend}`, "utf8");
	}
	const statusResult = runCommand(ctx, {
		scenarioId,
		label: "git-status",
		command: "git",
		args: ["status", "--short"],
		cwd: repoDir,
		env,
		timeoutMs: gitTimeoutMs,
	});
	if (statusResult.status !== 0) throw new Error(`failed to read git status for fixture repo '${name}'`);
	return { repoDir, gitStatus: statusResult.stdout.trimEnd() };
}

function manualLaunchCommand(ctx) {
	return `HOME=${quoteShellWord(ctx.homeDir)} PATH=${quoteShellWord(`${ctx.binDir}:${ctx.baseEnv.PATH || ""}`)} ${quoteShellWord(ctx.wrapperPath)}`;
}

function prepareArchitectScenario(ctx) {
	ensureInstalled(ctx);
	const fixture = createFixtureRepo(ctx, "architect-e2e", "architect-e2e-repo", {
		"README.md": "# Architect live eval fixture\n\nTiny repo for validating the TLH architect -> ticket -> developer flow.\n",
		"package.json": JSON.stringify({
			name: "architect-e2e-fixture",
			private: true,
			type: "module",
			scripts: { test: "node --test" },
		}, null, 2) + "\n",
		"src/greeter.mjs": "export function formatGreeting(name) {\n\tif (!name) return \"Hello.\";\n\treturn `Hello, ${String(name).trim()}!`;\n}\n",
		"test/greeter.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { formatGreeting } from '../src/greeter.mjs';\n\ntest('formatGreeting trims names', () => {\n\tassert.equal(formatGreeting(' TLH '), 'Hello, TLH!');\n});\n",
		"EVAL_REQUEST.md": "Add a new formatGreetingList(names) helper in src/greeter.mjs and targeted tests. Use the normal architect ticketed workflow instead of editing directly in the primary session.\n",
	});
	const instructions = `# architect-e2e\n\nRepo: ${fixture.repoDir}\nLaunch from repo root:\n\n\tcd ${fixture.repoDir}\n\t${manualLaunchCommand(ctx)}\n\nSuggested prompt:\n\n> In this fixture repo, use the normal TLH architect workflow to implement the request in EVAL_REQUEST.md. Keep the work small, create or use the needed tk ticket flow, delegate implementation, and report back with validation.\n\nWhat to verify:\n- architect stays in orchestration mode instead of editing directly\n- ticket/developer flow happens for the small requested change\n- resulting change stays inside this fixture repo\n- cleanup is easy because everything lives under ${ctx.rootDir}\n`;
	writeArtifact(ctx, join("artifacts", "architect-e2e", "README.md"), instructions);
	return {
		status: "prepared",
		detail: `fixture repo: ${fixture.repoDir}`,
	};
}

function preparePrimaryBehaviorScenario(ctx) {
	ensureInstalled(ctx);
	const fixture = createFixtureRepo(ctx, "rush-product-bug-hunter", "primary-behavior-repo", {
		"README.md": "# Primary behavior live eval fixture\n\nUse this repo to check Rush, product, and bug-hunter behavior boundaries.\n",
		"package.json": JSON.stringify({
			name: "primary-behavior-fixture",
			private: true,
			type: "module",
			scripts: { test: "node --test" },
		}, null, 2) + "\n",
		"src/cart.mjs": "export function totalWithTax(subtotalCents, quantity, taxRate = 0.1) {\n\tif (quantity <= 0) return subtotalCents * quantity;\n\tconst subtotal = subtotalCents * quantity;\n\treturn Math.floor(subtotal + subtotal * taxRate);\n}\n",
		"test/cart.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { totalWithTax } from '../src/cart.mjs';\n\ntest('totalWithTax applies tax', () => {\n\tassert.equal(totalWithTax(500, 2, 0.1), 1100);\n});\n",
		"BUG_REPORT.md": "Users report negative totals when quantity is zero or negative, and totals are rounded down instead of to the nearest cent.\n",
		"PRODUCT_BRIEF.md": "Draft a ticket for coupon stacking rules without editing source files.\n",
	});
	const instructions = `# rush-product-bug-hunter\n\nRepo: ${fixture.repoDir}\nLaunch from repo root:\n\n\tcd ${fixture.repoDir}\n\t${manualLaunchCommand(ctx)}\n\nSuggested prompts:\n\nRush\n> Switch to Rush and fix the bug described in BUG_REPORT.md. Edit directly, run narrow validation, and do not start ticket ceremony unless the task clearly outgrows Rush.\n\nProduct\n> Switch to product and turn PRODUCT_BRIEF.md into an implementation-ready tk ticket. Do not edit source files or run implementation loops.\n\nBug-hunter\n> Switch to bug-hunter and investigate the issue in BUG_REPORT.md. Explain the root cause and candidate fix, but do not modify files.\n\nWhat to verify:\n- Rush edits directly and validates narrowly\n- product stays non-implementing and hands back a ticket-shaped artifact\n- bug-hunter remains read-only and investigative\n`;
	writeArtifact(ctx, join("artifacts", "rush-product-bug-hunter", "README.md"), instructions);
	return {
		status: "prepared",
		detail: `fixture repo: ${fixture.repoDir}`,
	};
}

function prepareWebScoutScenario(ctx) {
	ensureInstalled(ctx);
	const briefDir = join(ctx.workspaceDir, "web-scout-brief");
	ensureDir(briefDir);
	writeFileSync(join(briefDir, "RESEARCH_BRIEF.md"), "Research the latest upstream Pi release notes and any recent Exa-facing changes relevant to TLH web-scout usage.\n", "utf8");
	const instructions = `# web-scout-network-research\n\nWorkspace: ${briefDir}\nLaunch from that directory:\n\n\tcd ${briefDir}\n\t${manualLaunchCommand(ctx)}\n\nPrerequisites:\n- working model auth for the upstream runtime\n- network access\n- EXA_API_KEY in the environment or equivalent isolated pi-web-access config\n\nSuggested prompt:\n\n> Use the architect to delegate a web-scout research task based on RESEARCH_BRIEF.md. Return concise findings with citations, and do not write source files.\n\nWhat to verify:\n- web-scout actually performs network research instead of hallucinating\n- returned answer includes citations/sources\n- no secrets appear in saved artifacts under ${ctx.rootDir}\n`;
	writeArtifact(ctx, join("artifacts", "web-scout-network-research", "README.md"), instructions);
	return {
		status: "prepared",
		detail: `workspace: ${briefDir}`,
	};
}

function prepareDirtyRepoScenario(ctx) {
	ensureInstalled(ctx);
	const fixture = createFixtureRepo(
		ctx,
		"dirty-repo-guard",
		"dirty-repo-guard-repo",
		{
			"README.md": "# Dirty repo guard fixture\n\nThis repo should remain dirty after setup so TLH can warn before session work proceeds.\n",
			"notes.txt": "initial clean content\n",
		},
		{ dirty: true, dirtyFile: "notes.txt", dirtyAppend: "uncommitted change\n" },
	);
	const instructions = `# dirty-repo-guard\n\nRepo: ${fixture.repoDir}\nCurrent git status:\n${fixture.gitStatus || "(clean unexpectedly)"}\n\nLaunch from repo root:\n\n\tcd ${fixture.repoDir}\n\t${manualLaunchCommand(ctx)}\n\nWhat to verify:\n- TLH warns or prompts before starting in this dirty worktree\n- the prompt appears before starting/switching/forking work that could hide the change\n- exiting the temp workspace is enough to undo the eval\n`;
	writeArtifact(ctx, join("artifacts", "dirty-repo-guard", "README.md"), instructions);
	return {
		status: "prepared",
		detail: `dirty fixture repo: ${fixture.repoDir}`,
	};
}

function runInstallUpdateSmoke(ctx) {
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
	checks.push(createBinaryScoreCheck({
		id: "defaults-list",
		label: "Installed wrapper lists bundled default extensions",
		passed: defaultsPassed,
		details: defaultsPassed
			? "tlh defaults list exited 0 in the isolated workspace."
			: `installed wrapper failed before update; see ${join(ctx.rootDir, "artifacts", "install-update-smoke", "defaults-list.log")}`,
		artifacts: [defaultsArtifact],
	}));
	if (!defaultsPassed) {
		return createFailureOutcome(`installed wrapper failed before update; see ${join(ctx.rootDir, "artifacts", "install-update-smoke", "defaults-list.log")}`, [defaultsArtifact], checks);
	}
	const updateArtifact = "artifacts/install-update-smoke/update.log";
	const updateResult = runCommand(ctx, {
		scenarioId: "install-update-smoke",
		label: "update",
		command: ctx.wrapperPath,
		args: ["update", "--track", "custom", "--package-source", `file:${repoRoot}`],
		cwd: ctx.workspaceDir,
		env: ctx.baseEnv,
		timeoutMs: installTimeoutMs,
	});
	const updatePassed = updateResult.status === 0;
	checks.push(createBinaryScoreCheck({
		id: "update",
		label: "Installed wrapper updates against the current checkout",
		passed: updatePassed,
		details: updatePassed
			? "tlh update exited 0 with the custom file: package source."
			: `tlh update failed with status ${updateResult.status ?? "null"}; see ${join(ctx.rootDir, "artifacts", "install-update-smoke", "update.log")}`,
		artifacts: [updateArtifact],
	}));
	if (!updatePassed) {
		return createFailureOutcome(`tlh update failed with status ${updateResult.status ?? "null"}; see ${join(ctx.rootDir, "artifacts", "install-update-smoke", "update.log")}`, [updateArtifact], checks);
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
			statePassed = state.track === "custom" && state.packageSource === `file:${repoRoot}` && state.wrapperName === "tlh";
			stateDetail = statePassed
				? "install-state.json recorded the custom track, file: package source, and tlh wrapper name."
				: "install-state.json did not preserve the expected custom track, file: package source, and tlh wrapper name.";
		} catch (error) {
			writeArtifact(ctx, stateArtifact, readFileSync(statePath, "utf8"));
			stateDetail = `install-state.json was unreadable: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	checks.push(createBinaryScoreCheck({
		id: "install-state",
		label: "Install state reflects the custom update source",
		passed: statePassed,
		details: stateDetail,
		artifacts: stateExists ? [stateArtifact] : [],
	}));
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
		prerequisites: ["interactive terminal", "model auth", ...bootstrapCommandPrerequisites, bootstrapNetworkPrerequisite],
		rubrics: [
			{
				id: "architect-orchestration-boundary",
				label: "Architect stays in orchestration mode",
				details: "Confirm the primary session scopes the work, manages ticket/developer flow, and does not edit the fixture files directly.",
			},
			{
				id: "ticketed-developer-flow",
				label: "Approved ticket and developer implementation flow occurs",
				details: "Verify the run uses the normal ticket/developer workflow instead of bypassing delegation for the requested change.",
			},
			{
				id: "fixture-repo-contained-change",
				label: "All edits and validation stay inside the fixture repo",
				details: "Check that any code changes and validation are contained to the prepared fixture repo so cleanup remains trivial.",
			},
		],
		run: prepareArchitectScenario,
	},
	{
		id: "rush-product-bug-hunter",
		mode: "manual",
		summary: "Prepare one fixture repo with prompts for Rush, product, and bug-hunter behavior checks.",
		prerequisites: ["interactive terminal", "model auth", ...bootstrapCommandPrerequisites, bootstrapNetworkPrerequisite],
		rubrics: [
			{
				id: "rush-direct-edit-boundary",
				label: "Rush edits directly and validates narrowly",
				details: "Confirm Rush fixes the bug directly in the fixture repo and reports narrow validation instead of starting ticket ceremony for this bounded task.",
			},
			{
				id: "product-non-implementing-boundary",
				label: "Product stays non-implementing and returns a ticket-shaped artifact",
				details: "Verify product mode clarifies requirements and hands back a tk-ready artifact without editing source files or running implementation loops.",
			},
			{
				id: "bug-hunter-read-only-boundary",
				label: "Bug-hunter remains investigative and read-only",
				details: "Check that bug-hunter explains root cause and candidate fixes without modifying files.",
			},
		],
		run: preparePrimaryBehaviorScenario,
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
				details: "Confirm the delegated research uses actual web/network access rather than unsupported guesses.",
			},
			{
				id: "cited-findings",
				label: "Returned findings include citations or sources",
				details: "Verify the final response includes concrete citations or linked sources for the reported findings.",
			},
			{
				id: "artifact-secret-hygiene",
				label: "Saved artifacts stay free of secrets",
				details: "Review the saved artifacts for accidental secret leakage before sharing them outside the temp workspace.",
			},
		],
		run: prepareWebScoutScenario,
	},
	{
		id: "dirty-repo-guard",
		mode: "manual",
		summary: "Prepare a dirty git fixture repo for verifying the dirty-repo startup guard.",
		prerequisites: ["interactive terminal", ...bootstrapCommandPrerequisites, bootstrapNetworkPrerequisite],
		rubrics: [
			{
				id: "dirty-warning-before-work",
				label: "Dirty worktree warning appears before work begins",
				details: "Confirm TLH warns or prompts before the session starts working in the intentionally dirty fixture repo.",
			},
			{
				id: "dirty-warning-covers-risky-actions",
				label: "Warning appears before work that could hide the change",
				details: "Verify the guard triggers before starting, switching, or forking work that could obscure the uncommitted change.",
			},
			{
				id: "dirty-fixture-cleanup",
				label: "Cleanup remains trivial after the warning check",
				details: "Make sure leaving or removing the temp workspace is enough to undo the live eval fixture state.",
			},
		],
		run: prepareDirtyRepoScenario,
	},
	{
		id: "install-update-smoke",
		mode: "automated",
		summary: "Run a real isolated install + tlh update smoke against this checkout with temp HOME/agent/bin.",
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
			throw new Error(`Unknown scenario id: ${id}. Available ids: ${allScenarios.map((entry) => entry.id).join(", ")}`);
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
		.filter((artifactPath) => !scenarioIds.some((scenarioId) => artifactPath.startsWith(`artifacts/${scenarioId}/`)))
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
		checks = (scenario.rubrics || []).map((rubric) => createManualRubricCheck({
			id: rubric.id,
			label: rubric.label,
			details: `${rubric.details} ${guidance}`.trim(),
			artifacts,
		}));
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
		`Scenarios: ${suiteResult.summary.scenarios.total} total; ${suiteResult.summary.scenarios.passed} passed; ${suiteResult.summary.scenarios.prepared} prepared; ${suiteResult.summary.scenarios.failed} failed`,
		`Automated checks: ${suiteResult.summary.checks.automated.passed}/${suiteResult.summary.checks.automated.total} passed`,
		`Manual rubrics pending: ${suiteResult.summary.checks.manual.pending}/${suiteResult.summary.checks.manual.total}`,
		"",
		"## Scenario results",
		...suiteResult.scenarios.map((result) => `- ${result.id}: ${result.status} (${formatScenarioScore(result)})${result.detail ? ` — ${result.detail}` : ""}`),
	];
	if (suiteResult.artifacts.shared.length > 0) {
		summary.push("", "## Shared artifacts", ...suiteResult.artifacts.shared.map((artifactPath) => `- ${artifactPath}`));
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
		const prefix = result.status === "passed" ? "PASS" : result.status === "prepared" ? "PREP" : "FAIL";
		console.log(`- [${prefix}] ${result.id} — ${formatScenarioScore(result)}${result.detail ? ` (${result.detail})` : ""}`);
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
		console.log("\nskipped: live evals are opt-in. Pass --run or set TLH_RUN_LIVE_EVALS=1 to execute them.");
		return;
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
			const outcome = error && typeof error === "object" && "liveEvalOutcome" in error && error.liveEvalOutcome
				? { ...error.liveEvalOutcome, detail: error.liveEvalOutcome.detail || message }
				: { status: "failed", detail: message };
			scenarioResults.push(createScenarioScoreResult(ctx, scenario, outcome));
		}
	}
	const keepWorkspace = failed || args.keepArtifacts || args.artifactsDir || selectedScenarios.some((scenario) => scenario.mode === "manual");
	const finishedAt = new Date().toISOString();
	const suiteResult = createSuiteResult({
		selectedScenarios,
		scenarioResults,
		startedAt,
		finishedAt,
		keepWorkspace,
		failed,
		requestedResultsFile: Boolean(args.resultsFile),
		sharedArtifacts: sharedArtifactPaths(ctx, selectedScenarios.map((scenario) => scenario.id)),
	});
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
