// Vendored from rtk-ai/rtk v0.42.4 (hooks/pi/rtk.ts), Apache-2.0.
// See ./rtk.APACHE-2.0.txt for the upstream license text and provenance.
// See ../docs/upstream-sync-inventory.md for TLH sync/review guidance.
// TLH adaptations:
// - keep native RTK rewrite-only with no /rtk command UI
// - prefer normal PATH lookup, then fall back to the managed <agent>/bin/rtk when needed
// - respect RTK_DISABLED=1 and the isolated-profile setting tlh.rtk.disabled
// - avoid duplicate handler registration when the extension is loaded twice for the same session
//
// RTK Pi extension — rewrites bash commands to use rtk for token savings.
// Requires: rtk >= 0.23.0 in PATH or at the managed isolated fallback path.
//
// This is a thin delegating extension: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry — not this file.
//
// Exit code contract for `rtk rewrite`:
//   0 + stdout  Rewrite found → mutate command
//   1           No RTK equivalent → pass through unchanged
//   3 + stdout  Rewrite (advisory) → mutate command

import { join } from "node:path";

import { SettingsManager, getAgentDir, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { TlhSettings } from "./the-last-harness/types.js";

const REWRITE_TIMEOUT_MS = 2_000;
const MIN_SUPPORTED_RTK_MINOR = 23;
const TLH_RTK_EXTENSION_STATE = Symbol.for("tlh.rtkExtensionState");

type ExtensionMarkerState = "activating" | "active";

type ExtensionApiWithMarker = ExtensionAPI & {
	[TLH_RTK_EXTENSION_STATE]?: ExtensionMarkerState;
};

type RtkCommandProbeResult =
	| {
		ok: true;
		command: string;
		version: string;
	}
	| {
		ok: false;
		command: string;
		reason: "missing" | "too-old";
		version?: string;
	};

type FailedRtkCommandProbeResult = Extract<RtkCommandProbeResult, { ok: false }>;

// Parse "X.Y.Z" semver, return [major, minor, patch] or null.
function parseSemver(raw: string): [number, number, number] | null {
	const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function isRtkSettingDisabled(cwd: string): boolean {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.rtk?.disabled === true;
	} catch {
		return false;
	}
}

function isSupportedRtkVersion(versionOutput: string): boolean {
	const parsed = parseSemver(versionOutput.replace(/^rtk\s+/, ""));
	if (!parsed) return true;
	const [major, minor] = parsed;
	return major !== 0 || minor >= MIN_SUPPORTED_RTK_MINOR;
}

async function probeRtkCommand(pi: ExtensionAPI, command: string): Promise<RtkCommandProbeResult> {
	try {
		const version = await pi.exec(command, ["--version"], { timeout: REWRITE_TIMEOUT_MS });
		if (version.code !== 0) {
			return { ok: false, command, reason: "missing" };
		}
		const versionOutput = version.stdout.trim();
		if (!isSupportedRtkVersion(version.stdout)) {
			return { ok: false, command, reason: "too-old", version: versionOutput };
		}
		return { ok: true, command, version: versionOutput };
	} catch {
		return { ok: false, command, reason: "missing" };
	}
}

function describeUnusableRtk(probe: FailedRtkCommandProbeResult, label: string): string {
	if (probe.reason === "too-old") {
		const versionDetail = probe.version ? ` (${probe.version})` : "";
		return `${label}${versionDetail} is too old (need >= 0.23.0)`;
	}
	return `${label} is unavailable`;
}

function containsNativeFindCommandToken(cmd: string): boolean {
	return /(?:^|[\s;&|])find(?=\s|$)/.test(cmd);
}

function hasUnsupportedNativeFindConstruct(cmd: string): boolean {
	if (!containsNativeFindCommandToken(cmd)) return false;

	return [
		/(?:^|\s)-(?:a|and|not|o|or)(?=\s|$)/,
		/(?:^|\s)!(?=\s|$)/,
		/(?:^|\s),(?=\s|$)/,
		/(?:^|\s)(?:\\\(|\\\)|\(|\))(?=\s|$)/,
		/(?:^|\s)-(?:delete|exec|execdir|fls|fprint|fprint0|fprintf|ls|ok|okdir|print|print0|printf|prune|quit)(?=\s|$)/,
	].some((pattern) => pattern.test(cmd));
}

async function resolveRtkCommand(pi: ExtensionAPI): Promise<string | null> {
	const pathProbe = await probeRtkCommand(pi, "rtk");
	if (pathProbe.ok) {
		return pathProbe.command;
	}

	const managedCommand = join(getAgentDir(), "bin", "rtk");
	const managedProbe = await probeRtkCommand(pi, managedCommand);
	if (managedProbe.ok) {
		return managedProbe.command;
	}

	console.warn(
		`[rtk] ${describeUnusableRtk(pathProbe, "rtk in PATH")} and ${describeUnusableRtk(managedProbe, `managed fallback ${managedCommand}`)} — extension disabled`,
	);
	return null;
}

// Calls `rtk rewrite`; returns the rewritten command or null (pass through).
async function rewriteCommand(
	pi: ExtensionAPI,
	rtkCommand: string,
	cmd: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const result = await pi.exec(rtkCommand, ["rewrite", cmd], {
		timeout: REWRITE_TIMEOUT_MS,
		signal,
	});
	if (result.killed) return null;
	if (result.code !== 0 && result.code !== 3) return null;
	return result.stdout.trim() || null;
}

export default async function rtk(pi: ExtensionAPI): Promise<void> {
	if (process.env.RTK_DISABLED === "1") {
		return;
	}

	const markedPi = pi as ExtensionApiWithMarker;
	if (markedPi[TLH_RTK_EXTENSION_STATE]) {
		return;
	}
	markedPi[TLH_RTK_EXTENSION_STATE] = "activating";

	try {
		const rtkCommand = await resolveRtkCommand(pi);
		if (!rtkCommand) {
			delete markedPi[TLH_RTK_EXTENSION_STATE];
			return;
		}

		markedPi[TLH_RTK_EXTENSION_STATE] = "active";
		pi.on("tool_call", async (event, ctx) => {
			try {
				if (!isToolCallEventType("bash", event)) return;

				const cmd = event.input.command;
				if (typeof cmd !== "string" || cmd.trim() === "") return;

				if (cmd === "rtk" || cmd.startsWith("rtk ")) return;
				if (process.env.RTK_DISABLED === "1") return;
				if (isRtkSettingDisabled(ctx.cwd)) return;

				if (hasUnsupportedNativeFindConstruct(cmd)) return;

				// Delegate to RTK.
				const rewritten = await rewriteCommand(pi, rtkCommand, cmd, ctx.signal);
				if (rewritten && rewritten !== cmd) {
					event.input.command = rewritten;
				}
			} catch (error) {
				// Fail open: never block execution on an unexpected error.
				console.warn("[rtk] unexpected error in tool_call handler; passing through command", error);
				return;
			}
		});
	} catch (error) {
		delete markedPi[TLH_RTK_EXTENSION_STATE];
		throw error;
	}
}
