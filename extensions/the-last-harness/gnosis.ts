import { execFileSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GNOSIS_VALIDATION_TIMEOUT_MS } from "./constants.js";

type GnosisHelpRunner = (command: string, args: string[]) => void;
type GnosisCommandCacheEntry = { command?: string; checkedAt: number };

const GNOSIS_NEGATIVE_CACHE_TTL_MS = 30_000;

// Launch estimation and before_agent_start build the same prompt in sequence. Successful
// validation is stable for this process; failures expire so transient spawn/timeouts recover.
const validatedGnosisCommands = new Map<string, GnosisCommandCacheEntry>();
const runGnosisHelpWithSubprocess: GnosisHelpRunner = (command, args) => {
	execFileSync(command, args, { stdio: "ignore", timeout: GNOSIS_VALIDATION_TIMEOUT_MS });
};
let runGnosisHelp = runGnosisHelpWithSubprocess;
let currentTime = Date.now;

function uniqueGnosisCandidates(candidates: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const key = candidate === "gn" ? candidate : resolve(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function validateGnosisCommand(command: string): boolean {
	try {
		for (const args of [
			["help", "plan"],
			["help", "review"],
		]) {
			runGnosisHelp(command, args);
		}
		return true;
	} catch {
		return false;
	}
}

function prependProcessPath(dir: string): void {
	const currentPath = process.env.PATH || "";
	const entries = currentPath.split(delimiter).filter(Boolean);
	if (entries.includes(dir)) {
		return;
	}
	process.env.PATH = [dir, ...entries].join(delimiter);
}

function findValidGnosisCommand(agentDir: string): string | undefined {
	const candidates = uniqueGnosisCandidates([join(agentDir, "bin", "gn"), "gn"]);
	for (const candidate of candidates) {
		if (validateGnosisCommand(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function shouldAppendGnosisPromptForAgentDir(agentDir: string): boolean {
	const resolvedAgentDir = resolve(agentDir);
	const now = currentTime();
	const cached = validatedGnosisCommands.get(resolvedAgentDir);
	let command = cached?.command;
	if (!cached || (!cached.command && now - cached.checkedAt >= GNOSIS_NEGATIVE_CACHE_TTL_MS)) {
		command = findValidGnosisCommand(resolvedAgentDir);
		validatedGnosisCommands.set(resolvedAgentDir, { command, checkedAt: currentTime() });
	}

	if (command && command !== "gn") {
		prependProcessPath(dirname(command));
	}
	return command !== undefined;
}

export function shouldAppendGnosisPrompt(_cwd: string): boolean {
	return shouldAppendGnosisPromptForAgentDir(getAgentDir());
}

/** @internal Exported only for deterministic unit coverage. */
export const __testing = {
	shouldAppendGnosisPromptForAgentDir,
	setGnosisHelpRunnerForTests(runner: GnosisHelpRunner) {
		runGnosisHelp = runner;
		validatedGnosisCommands.clear();
	},
	setClockForTests(clock: () => number) {
		currentTime = clock;
		validatedGnosisCommands.clear();
	},
	resetForTests() {
		runGnosisHelp = runGnosisHelpWithSubprocess;
		currentTime = Date.now;
		validatedGnosisCommands.clear();
	},
};
