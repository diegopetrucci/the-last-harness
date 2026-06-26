#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants as fsConstants,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderShellWords } from "./lib/tlh-install-utils.mjs";
import { renderWrapper } from "./tlh-wrapper.mjs";

const DEFAULT_BUDGET_MS = 1000;
const DEFAULT_RUNS = 6;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_COMMAND = "tlh";
const CONTROLLED_ENV = {
	PI_OFFLINE: "1",
	TLH_SKIP_UPDATE_CHECK: "1",
	TLH_SKIP_TELEMETRY: "1",
};
const BSD_SCRIPT_PLATFORMS = new Set(["darwin", "freebsd", "openbsd", "netbsd"]);
const MANAGED_WRAPPER_MARKER = "# Managed by The Last Harness installer";
const MANAGED_WRAPPER_FIELDS = [
	["default_agent_dir", "agentDir"],
	["default_tlh_package_root", "packageRoot"],
	["default_bin_dir", "binDir"],
	["default_wrapper_name", "wrapperName"],
	["default_pi_cmd", "piCmd"],
];
const ANSI_PATTERN = new RegExp(
	`${String.raw`\u001B`}(?:\\][^${String.raw`\u0007\u001B`}]*(?:${String.raw`\u0007`}|${String.raw`\u001B\\`})|\\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])`,
	"gu",
);
const HEADER_MARKERS = ["Context:", "Press Ctrl+Shift+E", "Warning: running TLH from"];
const HEADER_LOGO_PATTERN = /(^|\n)\s*tlh(?:\s+v\d[^\n]*)?\s*(?=\n|$)/u;
const FOOTER_MARKER = "agent: ";
let interruptSignal;
const PYTHON_PTY_BRIDGE = String.raw`
import os
import pty
import select
import signal
import subprocess
import sys
import time

READ_TIMEOUT_SECONDS = 0.05
POLL_INTERVAL_SECONDS = 0.05
INTERRUPT_GRACE_SECONDS = 0.4
TERM_GRACE_SECONDS = 0.6
KILL_GRACE_SECONDS = 0.2

if len(sys.argv) < 2:
    print("error: missing command", file=sys.stderr)
    raise SystemExit(2)

master_fd, slave_fd = pty.openpty()
popen_kwargs = {
    "stdin": slave_fd,
    "stdout": slave_fd,
    "stderr": slave_fd,
    "close_fds": True,
}
if hasattr(os, "setsid"):
    popen_kwargs["start_new_session"] = True
try:
    child = subprocess.Popen(sys.argv[1:], **popen_kwargs)
except FileNotFoundError as error:
    os.close(master_fd)
    os.close(slave_fd)
    print(f"error: {error}", file=sys.stderr)
    raise SystemExit(127)

os.close(slave_fd)
stdin_fd = sys.stdin.fileno()
stdout = sys.stdout.buffer
termination_signal = None
child_process_group = child.pid if popen_kwargs.get("start_new_session") and hasattr(os, "killpg") else None


def request_termination(signum, _frame):
    global termination_signal
    if termination_signal is None:
        termination_signal = signum


signal.signal(signal.SIGINT, request_termination)
signal.signal(signal.SIGTERM, request_termination)


def process_group_exists():
    if child_process_group is None:
        return child.poll() is None
    try:
        os.killpg(child_process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for_process_group(timeout_seconds):
    deadline = time.monotonic() + timeout_seconds
    while True:
        if not process_group_exists():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(POLL_INTERVAL_SECONDS)


def wait_for_child_and_group(timeout_seconds):
    deadline = time.monotonic() + timeout_seconds
    while True:
        status = child.poll()
        group_gone = not process_group_exists()
        if status is not None and group_gone:
            return status, True
        if time.monotonic() >= deadline:
            return status, group_gone
        time.sleep(POLL_INTERVAL_SECONDS)


def send_child_signal(signum):
    if child_process_group is not None:
        try:
            os.killpg(child_process_group, signum)
        except ProcessLookupError:
            pass
        return
    if child.poll() is not None:
        return
    try:
        child.send_signal(signum)
    except ProcessLookupError:
        pass


def terminate_child(signum):
    status = child.poll()
    group_gone = not process_group_exists()
    if status is not None and group_gone:
        return status

    send_child_signal(signum)
    status, group_gone = wait_for_child_and_group(
        INTERRUPT_GRACE_SECONDS if signum == signal.SIGINT else TERM_GRACE_SECONDS
    )
    if status is not None and group_gone:
        return status

    if signum != signal.SIGTERM:
        send_child_signal(signal.SIGTERM)
        status, group_gone = wait_for_child_and_group(TERM_GRACE_SECONDS)
        if status is not None and group_gone:
            return status

    send_child_signal(signal.SIGKILL)
    status = child.wait() if child.poll() is None else child.returncode
    wait_for_process_group(KILL_GRACE_SECONDS)
    return status


def bridge_exit_status(returncode):
    if returncode < 0:
        return 128 + abs(returncode)
    return returncode


while True:
    if termination_signal is not None:
        break

    read_fds = [master_fd, stdin_fd]
    try:
        ready, _, _ = select.select(read_fds, [], [], READ_TIMEOUT_SECONDS)
    except InterruptedError:
        ready = []

    if master_fd in ready:
        try:
            data = os.read(master_fd, 4096)
        except OSError:
            data = b""
        if not data:
            break
        stdout.write(data)
        stdout.flush()

    if stdin_fd in ready:
        try:
            incoming = os.read(stdin_fd, 1024)
        except OSError:
            incoming = b""
        if incoming:
            try:
                os.write(master_fd, incoming)
            except OSError:
                pass

    if child.poll() is not None and master_fd not in ready:
        break

status = child.wait() if termination_signal is None else terminate_child(termination_signal)
os.close(master_fd)
raise SystemExit(bridge_exit_status(status))
`;

function usage() {
	return `Usage: check-startup-performance.mjs [options] [-- <command args...>]

Manual TLH startup timing check. Launches an interactive command in a PTY,
measures first output, first TLH header visibility, and first TLH footer
visibility across repeated runs, then checks the warm first-header average
against a budget.

Options:
  --runs N             Number of launches to measure (default: ${DEFAULT_RUNS})
  --budget-ms N        Warm first-header budget in milliseconds (default: ${DEFAULT_BUDGET_MS})
  --timeout-ms N       Per-run timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --command PATH       Command to launch (default: ${DEFAULT_COMMAND})
  --profile-source DIR Copy this isolated TLH profile into a temp workspace first
  -h, --help           Show this help

Notes:
  - Everything after -- is appended as command arguments.
  - The checker always sets PI_OFFLINE=1, TLH_SKIP_UPDATE_CHECK=1,
    and TLH_SKIP_TELEMETRY=1.
  - The default tlh command is resolved on PATH, cloned into a temporary
    managed wrapper, and pointed at the temporary cloned profile.
  - Custom --command launches directly with PI_CODING_AGENT_DIR set to the
    temporary profile; if that command ignores the env var, the temp profile
    may not be used.
  - Writes stay inside a temporary cloned profile that is deleted afterwards.
`;
}

function parseArgs(argv) {
	const options = {
		runs: DEFAULT_RUNS,
		budgetMs: DEFAULT_BUDGET_MS,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		command: DEFAULT_COMMAND,
		commandArgs: [],
		profileSource: defaultProfileSource(),
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") {
			options.commandArgs = argv.slice(index + 1);
			break;
		}
		if (arg === "-h" || arg === "--help") {
			options.help = true;
			continue;
		}
		if (arg === "--runs") {
			options.runs = parseIntegerOption(argv[index + 1], "--runs");
			index += 1;
			continue;
		}
		if (arg === "--budget-ms") {
			options.budgetMs = parseIntegerOption(argv[index + 1], "--budget-ms");
			index += 1;
			continue;
		}
		if (arg === "--timeout-ms") {
			options.timeoutMs = parseIntegerOption(argv[index + 1], "--timeout-ms");
			index += 1;
			continue;
		}
		if (arg === "--command") {
			options.command = requireOptionValue(argv[index + 1], "--command");
			index += 1;
			continue;
		}
		if (arg === "--profile-source") {
			options.profileSource = requireOptionValue(argv[index + 1], "--profile-source");
			index += 1;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	validateArgs(options);
	return options;
}

function requireOptionValue(value, flag) {
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parseIntegerOption(value, flag) {
	const text = requireOptionValue(value, flag);
	const number = Number.parseInt(text, 10);
	if (!Number.isFinite(number) || `${number}` !== text || number <= 0) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return number;
}

function validateArgs(options) {
	if (options.runs < 2) {
		throw new Error("--runs must be at least 2 so the warm summary can exclude the first cold run");
	}
	if (!options.command || options.command.trim().length === 0) {
		throw new Error("--command must not be empty");
	}
}

function defaultProfileSource() {
	const candidates = [];
	if (process.env.PI_CODING_AGENT_DIR) {
		candidates.push(process.env.PI_CODING_AGENT_DIR);
	}
	candidates.push(join(process.env.HOME ?? process.cwd(), ".the-last-harness", "agent"));
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function createWorkspace(profileSource) {
	const root = mkdtempSync(join(tmpdir(), "tlh-startup-performance-"));
	const agentDir = join(root, "agent");
	const wrapperBinDir = join(root, "bin");
	if (profileSource) {
		cpSync(resolve(profileSource), agentDir, { recursive: true });
	} else {
		mkdirSync(agentDir, { recursive: true });
	}
	mkdirSync(wrapperBinDir, { recursive: true });
	return { root, agentDir, wrapperBinDir };
}

function commandExists(command, args) {
	const result = spawnSync(command, args, { stdio: "ignore" });
	return !result.error;
}

function buildPtyCommand(commandParts) {
	if (process.platform === "win32") {
		throw new Error("startup performance checks require a Unix-like PTY environment");
	}
	if (commandExists("python3", ["-c", "pass"])) {
		return {
			command: "python3",
			args: ["-c", PYTHON_PTY_BRIDGE, ...commandParts],
		};
	}
	if (BSD_SCRIPT_PLATFORMS.has(process.platform)) {
		return {
			command: "script",
			args: ["-q", "/dev/null", ...commandParts],
		};
	}
	return {
		command: "script",
		args: ["-q", "-e", "-c", renderShellWords(commandParts), "/dev/null"],
	};
}

function stripControlCharacters(text) {
	let result = "";
	for (const character of text) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) {
			continue;
		}
		if (codePoint === 0x09 || codePoint === 0x0A || codePoint === 0x0D || codePoint >= 0x20) {
			result += character;
		}
	}
	return result;
}

function stripTerminalNoise(text) {
	return stripControlCharacters(text.replace(ANSI_PATTERN, "")).replace(/\r/g, "\n");
}

function hasHeaderMarker(text) {
	return HEADER_MARKERS.some((marker) => text.includes(marker)) || HEADER_LOGO_PATTERN.test(text);
}

function hasFooterMarker(text) {
	return text.includes(FOOTER_MARKER);
}

function delay(ms) {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

function formatMs(value) {
	return `${value.toFixed(1)}ms`;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[middle - 1] + sorted[middle]) / 2;
	}
	return sorted[middle];
}

function summarize(values) {
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	return {
		mean,
		median: median(values),
		min: Math.min(...values),
		max: Math.max(...values),
	};
}

function describeSummary(label, values) {
	const summary = summarize(values);
	return `${label} mean ${formatMs(summary.mean)} median ${formatMs(summary.median)} min ${formatMs(summary.min)} max ${formatMs(summary.max)}`;
}

function excerptOutput(text) {
	const lines = text
		.split(/\n+/u)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	if (lines.length === 0) {
		return "(no output captured)";
	}
	return lines.slice(-12).join("\n");
}

function describeExit(code, signal) {
	if (signal) {
		return `signal ${signal}`;
	}
	if (code === null) {
		return "unknown exit";
	}
	return `exit ${code}`;
}

async function stopChildProcess(child, closePromise) {
	if (child.exitCode !== null || child.signalCode !== null) {
		await closePromise;
		return;
	}

	try {
		child.stdin.write("\u0003");
	} catch {
		// Ignore broken pipe during shutdown.
	}

	if (await exitsWithin(closePromise, 500)) {
		return;
	}

	safeKill(child.pid, "SIGTERM");
	if (await exitsWithin(closePromise, 1000)) {
		return;
	}

	safeKill(child.pid, "SIGKILL");
	await closePromise;
}

function createInterruptCleanup() {
	const activeChildren = new Set();
	const activeWorkspaces = new Set();
	const handlers = new Map();
	let cleanupPromise;
	let terminatingSignal;

	const cleanup = async () => {
		if (!cleanupPromise) {
			cleanupPromise = (async () => {
				await Promise.allSettled(Array.from(activeChildren, (entry) => entry.stop()));
				for (const workspaceRoot of Array.from(activeWorkspaces)) {
					rmSync(workspaceRoot, { recursive: true, force: true });
					activeWorkspaces.delete(workspaceRoot);
				}
			})();
		}
		return cleanupPromise;
	};

	const handleSignal = (signal) => {
		if (terminatingSignal) {
			return;
		}
		terminatingSignal = signal;
		interruptSignal = signal;
		void cleanup().finally(() => {
			for (const [installedSignal, handler] of handlers) {
				process.off(installedSignal, handler);
			}
			handlers.clear();
			try {
				process.kill(process.pid, signal);
			} catch {
				process.exit(signalExitCode(signal));
			}
		});
	};

	return {
		install() {
			if (handlers.size > 0) {
				return;
			}
			for (const signal of ["SIGINT", "SIGTERM"]) {
				const handler = () => {
					handleSignal(signal);
				};
				handlers.set(signal, handler);
				process.on(signal, handler);
			}
		},
		uninstall() {
			for (const [signal, handler] of handlers) {
				process.off(signal, handler);
			}
			handlers.clear();
		},
		registerChildProcess(child, closePromise) {
			let stopPromise;
			const entry = {
				stop() {
					if (!stopPromise) {
						stopPromise = stopChildProcess(child, closePromise).finally(() => {
							activeChildren.delete(entry);
						});
					}
					return stopPromise;
				},
			};
			activeChildren.add(entry);
			void closePromise.finally(() => {
				activeChildren.delete(entry);
			});
			return () => {
				activeChildren.delete(entry);
			};
		},
		registerWorkspace(workspaceRoot) {
			activeWorkspaces.add(workspaceRoot);
			return () => {
				activeWorkspaces.delete(workspaceRoot);
			};
		},
	};
}

async function exitsWithin(closePromise, timeoutMs) {
	const timedOut = Symbol("timeout");
	const result = await Promise.race([closePromise, delay(timeoutMs).then(() => timedOut)]);
	return result !== timedOut;
}

function safeKill(pid, signal) {
	if (!pid) {
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
			return;
		}
		try {
			process.kill(pid, signal);
		} catch (fallbackError) {
			if (fallbackError && typeof fallbackError === "object" && "code" in fallbackError && fallbackError.code === "ESRCH") {
				return;
			}
			throw fallbackError;
		}
	}
}

function signalExitCode(signal) {
	return signal === "SIGINT" ? 130 : 143;
}

function isDefaultCommand(command) {
	return command === DEFAULT_COMMAND;
}

function isExecutableFile(path) {
	try {
		const stats = statSync(path);
		if (!stats.isFile()) {
			return false;
		}
		accessSync(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommandPath(command, env = process.env) {
	if (command.includes("/")) {
		const candidate = resolve(command);
		return isExecutableFile(candidate) ? candidate : undefined;
	}
	for (const entry of (env.PATH ?? "").split(delimiter)) {
		const directory = entry || ".";
		const candidate = join(directory, command);
		if (isExecutableFile(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function unwrapShellQuote(value) {
	if (!value.startsWith("'") || !value.endsWith("'")) {
		throw new Error(`expected a single-quoted shell value, got: ${value}`);
	}
	return value.slice(1, -1).replace(/'\\''/g, "'");
}

function readManagedWrapperConfig(wrapperPath) {
	const source = readFileSync(wrapperPath, "utf8");
	if (!source.includes(MANAGED_WRAPPER_MARKER)) {
		throw new Error(`default command must resolve to a managed tlh wrapper; got: ${wrapperPath}`);
	}

	const config = {};
	for (const [variableName, propertyName] of MANAGED_WRAPPER_FIELDS) {
		const match = source.match(new RegExp(`^${variableName}=(.*)$`, "m"));
		if (!match) {
			throw new Error(`managed tlh wrapper is missing ${variableName}: ${wrapperPath}`);
		}
		config[propertyName] = unwrapShellQuote(match[1]);
	}
	return config;
}

function createTemporaryWrapper(workspace, wrapperPath) {
	const sourceConfig = readManagedWrapperConfig(wrapperPath);
	const wrapperName = sourceConfig.wrapperName || basename(wrapperPath);
	const temporaryWrapperPath = join(workspace.wrapperBinDir, wrapperName);
	writeFileSync(temporaryWrapperPath, renderWrapper({
		agentDir: workspace.agentDir,
		binDir: workspace.wrapperBinDir,
		wrapperName,
		packageRoot: sourceConfig.packageRoot,
		piCmd: sourceConfig.piCmd,
	}), "utf8");
	chmodSync(temporaryWrapperPath, 0o755);
	return {
		sourceConfig,
		temporaryWrapperPath,
		wrapperName,
	};
}

function createLaunchPlan(options, workspace, env = process.env) {
	if (!isDefaultCommand(options.command)) {
		return {
			commandParts: [options.command, ...options.commandArgs],
			requestedCommandParts: [options.command, ...options.commandArgs],
			usesTemporaryWrapper: false,
			modeDescription: "direct custom command",
		};
	}

	const resolvedWrapperPath = resolveCommandPath(options.command, env);
	if (!resolvedWrapperPath) {
		throw new Error(`could not find ${options.command} on PATH to create a temporary tlh wrapper`);
	}
	const temporaryWrapper = createTemporaryWrapper(workspace, resolvedWrapperPath);
	return {
		commandParts: [temporaryWrapper.temporaryWrapperPath, ...options.commandArgs],
		requestedCommandParts: [options.command, ...options.commandArgs],
		usesTemporaryWrapper: true,
		modeDescription: "temporary managed tlh wrapper",
		sourceWrapperPath: resolvedWrapperPath,
		temporaryWrapperPath: temporaryWrapper.temporaryWrapperPath,
		sourceWrapperConfig: temporaryWrapper.sourceConfig,
	};
}

async function measureRun(options, workspace, launchPlan, runNumber, interruptCleanup) {
	const ptyCommand = buildPtyCommand(launchPlan.commandParts);
	const env = {
		...process.env,
		...CONTROLLED_ENV,
		PI_CODING_AGENT_DIR: workspace.agentDir,
	};

	const child = spawn(ptyCommand.command, ptyCommand.args, {
		cwd: process.cwd(),
		env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});

	const startedAt = performance.now();
	let firstOutputMs;
	let firstHeaderMs;
	let firstFooterMs;
	let plainText = "";
	let settled = false;
	let timeoutHandle;

	const closePromise = new Promise((resolvePromise) => {
		child.once("close", (code, signal) => {
			resolvePromise({ code, signal });
		});
	});
	const unregisterChildProcess = interruptCleanup?.registerChildProcess(child, closePromise);

	const observationPromise = new Promise((resolvePromise, rejectPromise) => {
		const settle = (callback, value) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutHandle);
			callback(value);
		};

		const updateFromChunk = (chunk) => {
			const rawText = chunk.toString("utf8");
			if (rawText.length === 0) {
				return;
			}
			const now = performance.now() - startedAt;
			if (firstOutputMs === undefined) {
				firstOutputMs = now;
			}
			plainText += stripTerminalNoise(rawText);
			if (firstHeaderMs === undefined && hasHeaderMarker(plainText)) {
				firstHeaderMs = now;
			}
			if (firstFooterMs === undefined && hasFooterMarker(plainText)) {
				firstFooterMs = now;
			}
			if (firstHeaderMs !== undefined && firstFooterMs !== undefined) {
				settle(resolvePromise, undefined);
			}
		};

		child.stdout.on("data", updateFromChunk);
		child.stderr.on("data", updateFromChunk);
		child.once("error", (error) => {
			settle(rejectPromise, error);
		});
		closePromise.then(({ code, signal }) => {
			if (firstHeaderMs !== undefined && firstFooterMs !== undefined) {
				settle(resolvePromise, undefined);
				return;
			}
			const preview = excerptOutput(plainText);
			settle(
				rejectPromise,
				new Error(
					`run ${runNumber} ended before TLH header/footer became visible (${describeExit(code, signal)})\n${preview}`,
				),
			);
		});
		timeoutHandle = setTimeout(() => {
			const missing = [
				firstHeaderMs === undefined ? "header" : undefined,
				firstFooterMs === undefined ? "footer" : undefined,
			]
				.filter(Boolean)
				.join(" and ");
			const preview = excerptOutput(plainText);
			settle(
				rejectPromise,
				new Error(`run ${runNumber} timed out waiting for ${missing}\n${preview}`),
			);
		}, options.timeoutMs);
	});

	try {
		await observationPromise;
	} finally {
		try {
			await stopChildProcess(child, closePromise);
		} finally {
			unregisterChildProcess?.();
		}
	}

	return {
		firstOutputMs,
		firstHeaderMs,
		firstFooterMs,
	};
}

function printRun(result, runNumber) {
	const label = runNumber === 1 ? "cold" : "warm";
	console.log(
		`run ${String(runNumber).padStart(2, " ")} ${label}  output ${formatMs(result.firstOutputMs)}  header ${formatMs(result.firstHeaderMs)}  footer ${formatMs(result.firstFooterMs)}`,
	);
}

function printSummary(results, budgetMs) {
	const allOutput = results.map((result) => result.firstOutputMs);
	const allHeader = results.map((result) => result.firstHeaderMs);
	const allFooter = results.map((result) => result.firstFooterMs);
	const warmResults = results.slice(1);
	const warmOutput = warmResults.map((result) => result.firstOutputMs);
	const warmHeader = warmResults.map((result) => result.firstHeaderMs);
	const warmFooter = warmResults.map((result) => result.firstFooterMs);

	console.log("");
	console.log("all runs:");
	console.log(`  ${describeSummary("output", allOutput)}`);
	console.log(`  ${describeSummary("header", allHeader)}`);
	console.log(`  ${describeSummary("footer", allFooter)}`);
	console.log("warm runs (excluding first):");
	console.log(`  ${describeSummary("output", warmOutput)}`);
	console.log(`  ${describeSummary("header", warmHeader)}`);
	console.log(`  ${describeSummary("footer", warmFooter)}`);
	console.log("");

	const warmHeaderMean = summarize(warmHeader).mean;
	if (warmHeaderMean >= budgetMs) {
		throw new Error(
			`FAIL warm first-header mean ${formatMs(warmHeaderMean)} is at or above budget ${formatMs(budgetMs)}`,
		);
	}
	console.log(`PASS warm first-header mean ${formatMs(warmHeaderMean)} is below budget ${formatMs(budgetMs)}`);
}

async function run() {
	interruptSignal = undefined;
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}

	const workspace = createWorkspace(options.profileSource);
	const interruptCleanup = createInterruptCleanup();
	const unregisterWorkspace = interruptCleanup.registerWorkspace(workspace.root);
	interruptCleanup.install();
	try {
		const launchPlan = createLaunchPlan(options, workspace);
		console.log("TLH startup performance check");
		console.log(`requested command: ${renderShellWords(launchPlan.requestedCommandParts)}`);
		console.log(`launch mode: ${launchPlan.modeDescription}`);
		if (launchPlan.usesTemporaryWrapper) {
			console.log(`source wrapper: ${launchPlan.sourceWrapperPath}`);
			console.log(`temporary wrapper: ${launchPlan.temporaryWrapperPath}`);
			console.log(`launch command: ${renderShellWords(launchPlan.commandParts)}`);
		} else {
			console.log(`launch command: ${renderShellWords(launchPlan.commandParts)}`);
		}
		console.log(`runs: ${options.runs}`);
		console.log(`budget: ${formatMs(options.budgetMs)} warm first-header mean`);
		console.log(`profile source: ${options.profileSource ? resolve(options.profileSource) : "(empty temporary profile)"}`);
		console.log(`temporary profile: ${workspace.agentDir}`);
		console.log(`controlled env: ${Object.entries(CONTROLLED_ENV).map(([key, value]) => `${key}=${value}`).join(" ")}`);
		console.log("");

		const results = [];
		for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
			const result = await measureRun(options, workspace, launchPlan, runNumber, interruptCleanup);
			results.push(result);
			printRun(result, runNumber);
		}
		printSummary(results, options.budgetMs);
	} finally {
		interruptCleanup.uninstall();
		unregisterWorkspace();
		rmSync(workspace.root, { recursive: true, force: true });
	}
}

function isMainModule() {
	if (!process.argv[1]) return false;
	try {
		const scriptPath = realpathSync.native(resolve(process.argv[1]));
		const modulePath = realpathSync.native(fileURLToPath(import.meta.url));
		return scriptPath === modulePath;
	} catch {
		return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
	}
}

if (isMainModule()) {
	run().catch((error) => {
		if (interruptSignal) {
			return;
		}
		console.error(`error: ${error.message}`);
		process.exitCode = 1;
	});
}

export {
	CONTROLLED_ENV,
	DEFAULT_BUDGET_MS,
	DEFAULT_COMMAND,
	DEFAULT_RUNS,
	DEFAULT_TIMEOUT_MS,
	createLaunchPlan,
	createWorkspace,
	parseArgs,
	readManagedWrapperConfig,
	run,
	usage,
};
