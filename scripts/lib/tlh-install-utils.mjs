import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { pathWithinOrEqual, realpathForCompare } from "./tlh-install-paths.mjs";

export function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

export function assignRequiredEqualsValue(target, key, value, flag) {
	if (!value) throw new Error(`${flag} requires a value`);
	target[key] = value;
}

export function readJsonFile(path, { missingValue, emptyValue = {} } = {}) {
	if (!existsSync(path)) {
		if (missingValue !== undefined) return missingValue;
		throw new Error(`File does not exist: ${path}`);
	}
	const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	if (!raw.trim()) return emptyValue;
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error.message}`);
	}
}

export function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function shellWord(value) {
	const text = String(value);
	if (/^[A-Za-z0-9_/:.,@%+=-]+$/.test(text)) return text;
	return shellQuote(text);
}

export function renderShellWords(values) {
	return values.map(shellWord).join(" ");
}

export function backupTimestampSuffix(date = new Date(), { includeMilliseconds = true } = {}) {
	const iso = date.toISOString();
	if (includeMilliseconds) return iso.replace(/[:.]/g, "-");
	return iso.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export function backupPathWithTimestamp(path, { marker = "", date = new Date(), includeMilliseconds = true } = {}) {
	const markerText = marker ? `-${marker}` : "";
	return `${path}.backup${markerText}-${backupTimestampSuffix(date, { includeMilliseconds })}`;
}

export function pathIsInNormalPiConfig(path, { homeDir = homedir(), alreadyNormalized = false } = {}) {
	const normalPiRoot = realpathForCompare(join(homeDir, ".pi"));
	const normalizedPath = alreadyNormalized ? path : realpathForCompare(path);
	return pathWithinOrEqual(normalPiRoot, normalizedPath);
}

export function assertNotInNormalPiConfig(path, message, options = {}) {
	if (!pathIsInNormalPiConfig(path, options)) return;
	throw new Error(typeof message === "function" ? message(path) : message);
}
