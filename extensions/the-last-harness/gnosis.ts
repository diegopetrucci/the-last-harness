import { execFileSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";

import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { expandHomePath } from "./common.js";
import { GNOSIS_VALIDATION_TIMEOUT_MS } from "./constants.js";

type GnosisPromptConfig = {
	enabled?: boolean;
	installPath?: string;
};

type GnosisPromptSettings = {
	tlh?: {
		gnosis?: GnosisPromptConfig;
	};
};

function getTlhGnosisConfig(cwd: string): GnosisPromptConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as GnosisPromptSettings;
		return settings.tlh?.gnosis;
	} catch {
		return undefined;
	}
}

function configuredGnosisPath(config: GnosisPromptConfig | undefined): string | undefined {
	const installPath = config?.installPath;
	if (typeof installPath !== "string" || !installPath.trim()) {
		return undefined;
	}
	return resolve(expandHomePath(installPath.trim()));
}

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
		for (const args of [["help", "plan"], ["help", "review"]]) {
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

function findValidGnosisCommand(
	config: GnosisPromptConfig | undefined,
	agentDir: string,
	options: { prependPath?: boolean } = {},
): string | undefined {
	const candidates = uniqueGnosisCandidates([configuredGnosisPath(config), join(agentDir, "bin", "gn"), "gn"]);
	for (const candidate of candidates) {
		if (!validateGnosisCommand(candidate)) continue;
		if (options.prependPath && candidate !== "gn") {
			prependProcessPath(dirname(candidate));
		}
		return candidate;
	}
	return undefined;
}

function findEnabledGnosisCommand(cwd: string): string | undefined {
	const config = getTlhGnosisConfig(cwd);
	if (config?.enabled !== true) {
		return undefined;
	}

	return findValidGnosisCommand(config, getAgentDir(), { prependPath: true });
}

export function shouldAppendGnosisPrompt(cwd: string): boolean {
	return Boolean(findEnabledGnosisCommand(cwd));
}
