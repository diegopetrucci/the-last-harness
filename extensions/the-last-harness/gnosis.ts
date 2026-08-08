import { execFileSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GNOSIS_VALIDATION_TIMEOUT_MS } from "./constants.js";

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
			execFileSync(command, args, { stdio: "ignore", timeout: GNOSIS_VALIDATION_TIMEOUT_MS });
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

function findValidGnosisCommand(agentDir: string, options: { prependPath?: boolean } = {}): string | undefined {
	const candidates = uniqueGnosisCandidates([join(agentDir, "bin", "gn"), "gn"]);
	for (const candidate of candidates) {
		if (!validateGnosisCommand(candidate)) continue;
		if (options.prependPath && candidate !== "gn") {
			prependProcessPath(dirname(candidate));
		}
		return candidate;
	}
	return undefined;
}

export function shouldAppendGnosisPrompt(_cwd: string): boolean {
	const agentDir = getAgentDir();
	return Boolean(findValidGnosisCommand(agentDir, { prependPath: true }));
}
