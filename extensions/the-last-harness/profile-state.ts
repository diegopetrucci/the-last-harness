// TLH-private settings/state write guards layered on top of Pi settings storage.
// See ../../docs/upstream-sync-inventory.md for sync/review guidance.
import { closeSync, constants, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatHomePath, isRecord, pathWithinOrEqual, readText, realpathForCompare } from "./common.js";
import type { SettingsStorageLike, TlhInstallState, TlhStartupState } from "./types.js";

export function isDefaultPiAgentDir(agentDir: string): boolean {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return false;
	try {
		return realpathForCompare(agentDir) === realpathForCompare(join(home, ".pi", "agent"));
	} catch {
		return resolve(agentDir) === resolve(home, ".pi", "agent");
	}
}

export function isNormalPiConfigPath(resolvedPath: string): boolean {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) {
		return false;
	}
	const normalPiRoot = realpathForCompare(join(home, ".pi"));
	return pathWithinOrEqual(normalPiRoot, resolvedPath);
}

export function safeTlhProfileFilePath(relativePath: string): string | undefined {
	const agentDir = getAgentDir();
	if (!process.env.PI_CODING_AGENT_DIR || isDefaultPiAgentDir(agentDir)) {
		return undefined;
	}

	const targetPath = join(agentDir, relativePath);
	try {
		const resolvedAgentDir = realpathForCompare(agentDir);
		const resolvedTargetPath = realpathForCompare(targetPath);
		if (!pathWithinOrEqual(resolvedAgentDir, resolvedTargetPath) || isNormalPiConfigPath(resolvedTargetPath)) {
			return undefined;
		}
		return targetPath;
	} catch {
		return undefined;
	}
}

export function tlhStateDir(): string | undefined {
	return safeTlhProfileFilePath("tlh");
}

export function tlhStatePath(fileName: string): string | undefined {
	return safeTlhProfileFilePath(join("tlh", fileName));
}

export function tlhStartupStatePath(): string | undefined {
	// Only persist state when the wrapper has selected an isolated profile and
	// the TLH support path resolves inside that profile. This avoids mutating
	// normal Pi config through a symlinked `${AGENT_DIR}/tlh` directory.
	return tlhStatePath("startup-state.json");
}

export function tlhTelemetryStatePath(): string | undefined {
	return tlhStatePath("telemetry-state.json");
}

export function readTlhStartupState(): TlhStartupState {
	const statePath = tlhStartupStatePath();
	const content = statePath ? readText(statePath) : undefined;
	if (!content) {
		return {};
	}
	try {
		const parsed = JSON.parse(content) as TlhStartupState;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function tlhInstallStatePath(): string | undefined {
	return safeTlhProfileFilePath(join("tlh", "install-state.json"));
}

export function readTlhInstallState(): TlhInstallState {
	const statePath = tlhInstallStatePath();
	const content = statePath ? readText(statePath) : undefined;
	if (!content) {
		return {};
	}
	try {
		const parsed = JSON.parse(content) as TlhInstallState;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export async function readTlhInstallStateAsync(): Promise<TlhInstallState> {
	const statePath = tlhInstallStatePath();
	if (!statePath) {
		return {};
	}
	try {
		const content = await readFile(statePath, "utf8");
		if (!content) {
			return {};
		}
		const parsed = JSON.parse(content) as TlhInstallState;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Guard the TLH state directory before writing `statePath`.
 *
 * `resolveExpectedPath` re-resolves the caller's managed state path so the guard
 * can confirm the target is still exactly the path this writer owns. Passing the
 * resolver (rather than a precomputed string) keeps the check honest: it re-runs
 * the profile-isolation resolution after `mkdirSync`, so a directory that only
 * became unsafe mid-write is still rejected.
 */
function canUseTlhStateDir(statePath: string, resolveExpectedPath: () => string | undefined): boolean {
	const stateDir = dirname(statePath);
	try {
		const dirStat = lstatSync(stateDir);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
			return false;
		}
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") {
			return false;
		}
	}

	try {
		mkdirSync(stateDir, { recursive: true });
		const dirStat = lstatSync(stateDir);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
			return false;
		}
		return resolveExpectedPath() === statePath;
	} catch {
		return false;
	}
}

function canReplaceTlhStateFile(statePath: string): boolean {
	try {
		const stateStat = lstatSync(statePath);
		return !stateStat.isSymbolicLink() && stateStat.isFile();
	} catch (error) {
		return isRecord(error) && error.code === "ENOENT";
	}
}

/**
 * Core atomic write implementation. Accepts `nofollowFlag` explicitly so the
 * O_NOFOLLOW-unavailable path can be exercised in tests without mocking the
 * native `fs` module. Production callers must always pass `constants.O_NOFOLLOW`.
 */
function writeTlhStateFileAtomicallyCore(statePath: string, content: string, nofollowFlag: unknown): boolean {
	// TLH profile state is best-effort. If this platform cannot protect the temp
	// file's final component from symlinks, fail closed instead of weakening the
	// atomic replacement by silently dropping O_NOFOLLOW.
	if (typeof nofollowFlag !== "number" || nofollowFlag === 0) {
		return false;
	}

	const stateDir = dirname(statePath);
	const stateBase = basename(statePath);
	const tempPath = join(
		stateDir,
		`.${stateBase}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
	);
	let fd: number | undefined;
	let cleanupError: unknown;
	try {
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollowFlag, 0o600);
		writeFileSync(fd, content, { encoding: "utf8" });
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, statePath);
	} finally {
		if (fd !== undefined) {
			closeSync(fd);
		}
		try {
			unlinkSync(tempPath);
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") {
				cleanupError = error;
			}
		}
	}
	if (cleanupError !== undefined) {
		throw cleanupError;
	}
	return true;
}

function writeTlhStateFileAtomically(statePath: string, content: string): boolean {
	return writeTlhStateFileAtomicallyCore(statePath, content, constants.O_NOFOLLOW);
}

/**
 * Write a file under the isolated TLH profile state directory (`${AGENT_DIR}/tlh`)
 * behind the shared symlink/atomic-replacement guards.
 *
 * This is the single audited implementation of those guards; every TLH profile
 * state writer must go through it rather than reimplementing the checks:
 *  - `statePath` must resolve within the managed TLH state dir (`tlhStateDir()`),
 *    validated independently without relying on caller-supplied `resolveExpectedPath`,
 *  - the state directory must not be a symlink,
 *  - `resolveExpectedPath()` must still resolve to `statePath` after the directory
 *    is created (re-confirming isolated-profile containment),
 *  - an existing target must be a regular, non-symlinked file,
 *  - the replacement is written via an O_EXCL + O_NOFOLLOW temp file and renamed.
 *
 * Returns `true` when the file is written successfully, `false` when any guard
 * rejects. Callers own "best-effort" error swallowing so a failed state write
 * never blocks launch.
 */
export function writeGuardedTlhStateFile(
	statePath: string,
	content: string,
	resolveExpectedPath: () => string | undefined,
): boolean {
	// Independent containment check: validate that statePath is within the managed
	// TLH state dir (${AGENT_DIR}/tlh) without trusting resolveExpectedPath alone.
	const managedDir = tlhStateDir();
	if (!managedDir) {
		return false;
	}
	try {
		if (!pathWithinOrEqual(realpathForCompare(managedDir), realpathForCompare(statePath))) {
			return false;
		}
	} catch {
		return false;
	}
	if (!canUseTlhStateDir(statePath, resolveExpectedPath) || !canReplaceTlhStateFile(statePath)) {
		return false;
	}
	return writeTlhStateFileAtomically(statePath, content);
}

export function writeTlhStartupState(state: TlhStartupState): void {
	try {
		const statePath = tlhStartupStatePath();
		if (!statePath) {
			return;
		}
		writeGuardedTlhStateFile(statePath, `${JSON.stringify(state, null, 2)}\n`, tlhStartupStatePath);
	} catch {
		// Startup state is best-effort; never block launch.
	}
}

export function updateTlhStartupState(updates: Partial<TlhStartupState>): void {
	writeTlhStartupState({ ...readTlhStartupState(), ...updates });
}

export function tlhSettingsPathForWrite(): string | undefined {
	const agentDir = getAgentDir();
	if (!process.env.PI_CODING_AGENT_DIR || isDefaultPiAgentDir(agentDir)) {
		return undefined;
	}
	return join(agentDir, "settings.json");
}

const SETTINGS_BACKUP_SUFFIX_RETRY_LIMIT = 32;

function settingsBackupTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeCollisionSafeSettingsBackup(settingsPath: string, current: string): string {
	const timestamp = settingsBackupTimestamp();
	for (let suffix = 0; suffix <= SETTINGS_BACKUP_SUFFIX_RETRY_LIMIT; suffix += 1) {
		const backupPath = suffix === 0 ? `${settingsPath}.bak-${timestamp}` : `${settingsPath}.bak-${timestamp}-${suffix}`;
		try {
			writeFileSync(backupPath, current, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return backupPath;
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") {
				throw error;
			}
		}
	}
	throw new Error(
		`Could not create a unique TLH settings backup after ${SETTINGS_BACKUP_SUFFIX_RETRY_LIMIT + 1} attempts: ${settingsPath}.bak-${timestamp}`,
	);
}

function getSettingsStorageForWrite(cwd: string): SettingsStorageLike {
	const manager = SettingsManager.create(cwd, getAgentDir()) as unknown as { storage?: SettingsStorageLike };
	if (!manager.storage || typeof manager.storage.withLock !== "function") {
		throw new Error("Pi settings storage is unavailable.");
	}
	return manager.storage;
}

export function withLockedTlhSettingsWrite<TResult extends { changed: boolean; nextContent?: string | undefined }>(
	cwd: string,
	outsideProfileError: string,
	update: (current: string | undefined) => TResult,
): Omit<TResult, "nextContent"> & { settingsPath: string; backupPath?: string } {
	const settingsPath = tlhSettingsPathForWrite();
	if (!settingsPath) {
		throw new Error(outsideProfileError);
	}
	assertSafeTlhSettingsPath(settingsPath);

	let result: (Omit<TResult, "nextContent"> & { settingsPath: string; backupPath?: string }) | undefined;
	getSettingsStorageForWrite(cwd).withLock("global", (current) => {
		const outcome = update(current);
		const { nextContent, ...baseResult } = outcome;
		if (!baseResult.changed) {
			result = { ...baseResult, settingsPath };
			return undefined;
		}
		if (typeof nextContent !== "string") {
			throw new Error("TLH settings write must provide replacement content when changed.");
		}
		if (current) {
			const backupPath = writeCollisionSafeSettingsBackup(settingsPath, current);
			result = { ...baseResult, settingsPath, backupPath };
			return nextContent;
		}
		result = { ...baseResult, settingsPath };
		return nextContent;
	});

	if (!result) {
		throw new Error("Pi settings storage did not return a write result.");
	}
	return result;
}

export function assertSafeTlhSettingsPath(settingsPath: string): void {
	try {
		const settingsStat = lstatSync(settingsPath);
		if (settingsStat.isSymbolicLink()) {
			throw new Error(`Refusing to write symlinked TLH settings file: ${settingsPath}`);
		}
		if (!settingsStat.isFile()) {
			throw new Error(`Refusing to write non-file TLH settings path: ${settingsPath}`);
		}
		if (settingsStat.nlink > 1) {
			throw new Error(`Refusing to write hardlinked TLH settings file: ${settingsPath}`);
		}
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") {
			throw error;
		}
	}

	const agentDir = realpathForCompare(getAgentDir());
	const resolvedSettingsPath = realpathForCompare(settingsPath);
	if (!pathWithinOrEqual(agentDir, resolvedSettingsPath)) {
		throw new Error(`Refusing to write settings outside the isolated TLH profile: ${settingsPath}`);
	}

	if (isNormalPiConfigPath(resolvedSettingsPath)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness: ${settingsPath}`);
	}
}

export function assertNotNormalPiSettings(settingsPath: string): void {
	const normalPiRoot = realpathForCompare(join(homedir(), ".pi"));
	const resolvedSettingsPath = realpathForCompare(settingsPath);
	if (resolvedSettingsPath === normalPiRoot || resolvedSettingsPath.startsWith(`${normalPiRoot}${sep}`)) {
		throw new Error(`Refusing to modify normal Pi config from tlh: ${formatHomePath(settingsPath)}`);
	}
}

/** @internal Exported only for tests; do not use outside this module. */
export const __testing = {
	/**
	 * The O_NOFOLLOW-parameterised core of `writeTlhStateFileAtomically`.
	 * Pass `0` or `undefined` to simulate a platform where `O_NOFOLLOW` is
	 * unavailable and verify the fail-closed path returns `false`.
	 */
	writeTlhStateFileAtomicallyCore,
};
