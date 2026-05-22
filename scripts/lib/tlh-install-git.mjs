import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

import { criticalGitSourceSpec } from "./tlh-install-package-source.mjs";
import {
	assertProfilePathWithinAgent,
	isSymlink,
	realpathForCompare,
} from "./tlh-install-paths.mjs";

const COMMAND_MAX_BUFFER = 20 * 1024 * 1024;

function commandDisplay(commandArgs) {
	return commandArgs.map(String).join(" ");
}

function inheritedCommandEnv(config, extraEnv = {}) {
	return { ...(config?.env || process.env), ...extraEnv };
}

function defaultSpawnCapture(config, commandArgs, { cwd, env = {}, allowFailure = false } = {}) {
	const [command, ...args] = commandArgs;
	const result = spawnSync(command, args, {
		cwd,
		env: inheritedCommandEnv(config, env),
		encoding: "utf8",
		maxBuffer: COMMAND_MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (!allowFailure && (result.error || result.status !== 0)) {
		const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
		throw new Error(output || result.error?.message || `command failed: ${commandDisplay(commandArgs)}`);
	}
	return result;
}

function requireRunCommand(io) {
	if (typeof io.runCommand !== "function") {
		throw new Error("runCommand callback is required to refresh git checkouts");
	}
	return io.runCommand;
}

function runGitCommand(config, commandArgs, io, options = {}) {
	requireRunCommand(io)(config, commandArgs, options);
}

function runGitCommandInDir(config, dir, commandArgs, io) {
	if (typeof io.runInDir === "function") {
		io.runInDir(config, dir, commandArgs);
		return;
	}
	runGitCommand(config, commandArgs, io, { cwd: dir });
}

function printDryRunCommand(commandArgs, io) {
	if (typeof io.printCommand === "function") io.printCommand(commandArgs);
}

function logDryRun(config, message, io) {
	if (typeof io.log === "function") io.log(config, message);
}

function warn(message, io) {
	if (typeof io.warn === "function") io.warn(message);
	else console.error(`warning: ${message}`);
}

export function gitOutput(config, targetDir, args, io = {}) {
	const spawnCapture = io.spawnCapture || defaultSpawnCapture;
	return spawnCapture(config, ["git", "-C", targetDir, ...args]).stdout.trim();
}

export function gitSucceeds(config, targetDir, args, io = {}) {
	const spawnCapture = io.spawnCapture || defaultSpawnCapture;
	const result = spawnCapture(config, ["git", "-C", targetDir, ...args], { allowFailure: true });
	return !result.error && result.status === 0;
}

export function assertGitRepositoryConfined(config, targetDir, label = "git package checkout", io = {}) {
	const topLevel = gitOutput(config, targetDir, ["rev-parse", "--show-toplevel"], io);
	const gitDir = gitOutput(config, targetDir, ["rev-parse", "--absolute-git-dir"], io);
	let commonGitDir = gitOutput(config, targetDir, ["rev-parse", "--git-common-dir"], io);
	if (!commonGitDir.startsWith("/")) commonGitDir = join(targetDir, commonGitDir);

	const normalizedTarget = realpathForCompare(targetDir);
	const normalizedTop = realpathForCompare(topLevel);
	if (normalizedTop !== normalizedTarget) {
		throw new Error(`refusing to use ${label} with worktree outside the package path: ${targetDir}`);
	}
	assertProfilePathWithinAgent(config, gitDir, `${label} git metadata`);
	assertProfilePathWithinAgent(config, commonGitDir, `${label} common git metadata`);
}

export function assertGitSourceTargetSafe(config, source, label = "git package checkout", io = {}) {
	const spec = criticalGitSourceSpec(source, { agentDir: config.agentDir });
	if (!spec) return;
	const targetDir = spec.targetDir;
	const gitMetadata = join(targetDir, ".git");
	assertProfilePathWithinAgent(config, targetDir, label);
	if (isSymlink(targetDir)) throw new Error(`refusing to use symlinked ${label}: ${targetDir}`);
	if (existsSync(targetDir) && !lstatSync(targetDir).isDirectory()) {
		throw new Error(`refusing to use non-directory ${label}: ${targetDir}`);
	}
	if (existsSync(targetDir) && !existsSync(gitMetadata)) {
		throw new Error(`refusing to use existing non-git ${label}: ${targetDir}`);
	}
	if (isSymlink(gitMetadata)) throw new Error(`refusing to use ${label} with symlinked git metadata: ${gitMetadata}`);
	if (existsSync(gitMetadata) && !lstatSync(gitMetadata).isDirectory() && !lstatSync(gitMetadata).isFile()) {
		throw new Error(`refusing to use ${label} with unsupported git metadata: ${gitMetadata}`);
	}
	if (existsSync(gitMetadata)) {
		assertProfilePathWithinAgent(config, gitMetadata, `${label} git metadata`);
		assertGitRepositoryConfined(config, targetDir, label, io);
	}
}

export function safeGitCheckoutDirForMutation(config, targetDir, label = "git package checkout", io = {}) {
	assertProfilePathWithinAgent(config, targetDir, label);
	if (isSymlink(targetDir)) throw new Error(`refusing to mutate symlinked ${label}: ${targetDir}`);
	if (!existsSync(targetDir) || !lstatSync(targetDir).isDirectory()) return false;
	const gitMetadata = join(targetDir, ".git");
	if (isSymlink(gitMetadata)) throw new Error(`refusing to mutate ${label} with symlinked git metadata: ${gitMetadata}`);
	if (!existsSync(gitMetadata)) return false;
	if (!lstatSync(gitMetadata).isDirectory() && !lstatSync(gitMetadata).isFile()) return false;
	assertProfilePathWithinAgent(config, gitMetadata, `${label} git metadata`);
	assertGitRepositoryConfined(config, targetDir, label, io);
	return true;
}

export function refreshGitCheckout(config, { targetDir, repo, ref, label, missingMessage, warnOnMissing = false }, io = {}) {
	if (config.dryRun) {
		if (repo) printDryRunCommand(["git", "-C", targetDir, "remote", "set-url", "origin", repo], io);
		printDryRunCommand(["git", "-C", targetDir, "fetch", "--prune", "--tags", "origin"], io);
		logDryRun(config, `Would prefer tag ${ref}, then origin/${ref}, then ${ref}.`, io);
		printDryRunCommand(["git", "-C", targetDir, "checkout", "--detach", "<resolved-ref>"], io);
		printDryRunCommand(["git", "-C", targetDir, "reset", "--hard", "<resolved-ref>"], io);
		printDryRunCommand(["git", "-C", targetDir, "clean", "-fd"], io);
		logDryRun(config, "Would run npm install --omit=dev --legacy-peer-deps --package-lock=false if package.json is present.", io);
		return true;
	}

	if (!safeGitCheckoutDirForMutation(config, targetDir, label, io)) {
		if (warnOnMissing) {
			warn(missingMessage, io);
			return false;
		}
		throw new Error(missingMessage);
	}

	if (repo) {
		if (gitSucceeds(config, targetDir, ["remote", "get-url", "origin"], io)) {
			runGitCommand(config, ["git", "-C", targetDir, "remote", "set-url", "origin", repo], io);
		} else {
			runGitCommand(config, ["git", "-C", targetDir, "remote", "add", "origin", repo], io);
		}
	}
	runGitCommand(config, ["git", "-C", targetDir, "fetch", "--prune", "--tags", "origin"], io);

	// Detect a dirty tree and back it up before any destructive operations.
	const statusOutput = gitOutput(config, targetDir, ["status", "--porcelain"], io);
	if (statusOutput !== "") {
		const timestamp = new Date().toISOString();
		const refTimestamp = timestamp.replace(/:/g, "-");
		const backupRef = `refs/tlh-backup/${refTimestamp}`;

		// Stage everything that is not gitignored (no -f so node_modules etc. stay out).
		runGitCommand(config, ["git", "-C", targetDir, "add", "-A"], io);

		// Capture tree and (optional) parent objects.
		const tree = gitOutput(config, targetDir, ["write-tree"], io);
		let parent = null;
		if (gitSucceeds(config, targetDir, ["rev-parse", "HEAD"], io)) {
			parent = gitOutput(config, targetDir, ["rev-parse", "HEAD"], io);
		}

		// Build the backup commit.
		const commitTreeArgs = ["commit-tree", tree];
		if (parent) commitTreeArgs.push("-p", parent);
		commitTreeArgs.push("-m", `tlh backup ${timestamp}`);
		const commit = gitOutput(config, targetDir, commitTreeArgs, io);

		// Store behind a private ref. The working tree stays dirty for now; the
		// forced checkout below discards it safely because the backup ref holds
		// the user's changes.
		runGitCommand(config, ["git", "-C", targetDir, "update-ref", backupRef, commit], io);

		// Report the backup so the user knows how to recover.
		const parentOrEmpty = parent ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
		warn(`dirty checkout at ${targetDir} — local changes backed up to ${backupRef}`, io);
		warn(`  git -C ${targetDir} show ${backupRef}`, io);
		warn(`  git -C ${targetDir} diff ${parentOrEmpty} ${backupRef}`, io);

		// Emit the diff body, capped at 200 lines.
		const diffBody = gitOutput(config, targetDir, ["diff", parentOrEmpty, backupRef], io);
		const diffLines = diffBody.split("\n");
		const truncated = diffLines.length > 200;
		warn(diffLines.slice(0, 200).join("\n"), io);
		if (truncated) {
			warn("... truncated, use the diff command above for full content", io);
		}
	}

	let targetRef = ref;
	if (gitSucceeds(config, targetDir, ["rev-parse", "--verify", "--quiet", `refs/tags/${ref}^{commit}`], io)) {
		targetRef = `refs/tags/${ref}^{commit}`;
	} else if (gitSucceeds(config, targetDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ref}^{commit}`], io)) {
		targetRef = `refs/remotes/origin/${ref}`;
	}

	runGitCommand(config, ["git", "-C", targetDir, "checkout", "-f", "--detach", targetRef], io);
	runGitCommand(config, ["git", "-C", targetDir, "reset", "--hard", targetRef], io);
	runGitCommand(config, ["git", "-C", targetDir, "clean", "-fd"], io);
	if (existsSync(join(targetDir, "package.json"))) {
		runGitCommandInDir(config, targetDir, ["npm", "install", "--omit=dev", "--legacy-peer-deps", "--package-lock=false"], io);
	}
	return true;
}
