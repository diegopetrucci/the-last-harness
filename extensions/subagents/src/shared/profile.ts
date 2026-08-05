import * as os from "node:os";
import * as path from "node:path";
import { getConfigDirName } from "./config-dir.ts";

function defaultAgentDir(): string {
	return path.join(os.homedir(), getConfigDirName(), "agent");
}

export function expandTildePath(value: string): string {
	if (value === "~") return os.homedir();
	return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function hasCustomPiAgentDir(): boolean {
	return Boolean(process.env.PI_CODING_AGENT_DIR?.trim());
}

export function getPiAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return defaultAgentDir();
	return path.resolve(expandTildePath(configured));
}

export function getGlobalAgentsDir(): string {
	return path.join(os.homedir(), ".agents");
}

export function getLegacyGlobalAgentsDir(): string | undefined {
	return hasCustomPiAgentDir() ? undefined : getGlobalAgentsDir();
}

export function isGlobalAgentsDir(value: string): boolean {
	return path.resolve(value) === path.resolve(getGlobalAgentsDir());
}
