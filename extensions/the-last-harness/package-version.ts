import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

let cachedTlhVersion: string | undefined;

export function getTlhVersion(): string {
	if (cachedTlhVersion) {
		return cachedTlhVersion;
	}
	try {
		const packageJson = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
		cachedTlhVersion = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
	} catch {
		cachedTlhVersion = "0.0.0";
	}
	return cachedTlhVersion ?? "0.0.0";
}

export function normalizeTlhVersion(version: string): string {
	return version.trim().replace(/^v/i, "");
}

type ParsedTlhVersion = {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
};

function parseTlhVersion(version: string): ParsedTlhVersion | undefined {
	const match = normalizeTlhVersion(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function compareTlhVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parseTlhVersion(leftVersion);
	const right = parseTlhVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}
	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

export function isNewerTlhVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = compareTlhVersions(candidateVersion, currentVersion);
	return comparison !== undefined && comparison > 0;
}
