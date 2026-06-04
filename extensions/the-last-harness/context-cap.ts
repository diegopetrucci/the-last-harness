import { SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatHomePath } from "./common.js";
import { DUMB_ZONE_THRESHOLD_TOKENS } from "./constants.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import type { TlhSettings } from "./types.js";

// Re-exported alias so callers can reference the cap value without coupling to
// the "dumb zone" label used in footer rendering. Both names point to the same
// compile-time constant; 200_000 is defined exactly once in constants.ts.
export const DEFAULT_CONTEXT_CAP_TOKENS = DUMB_ZONE_THRESHOLD_TOKENS;

const TOGGLE_CONTEXT_CAP_COMMAND_HELP = "Usage: /toggle-context-cap";

// Local structural alias derived from ExtensionContext so we never import
// Model/Api directly from the nested @earendil-works/pi-ai transitive dep.
type AnyModel = NonNullable<ExtensionContext["model"]>;

// WeakMap stores the original contextWindow before we capped it.
// Keyed by model object identity so each Pi model instance is tracked
// independently across multiple concurrent sessions.
const originalContextWindows = new WeakMap<AnyModel, number>();

function getOriginalContextWindow(model: AnyModel): number {
	const stored = originalContextWindows.get(model);
	if (typeof stored === "number") return stored;
	originalContextWindows.set(model, model.contextWindow);
	return model.contextWindow;
}

function applyContextCap(model: AnyModel | undefined): boolean {
	if (!model) return false;
	const original = getOriginalContextWindow(model);
	const effective = Math.min(original, DEFAULT_CONTEXT_CAP_TOKENS);
	if (model.contextWindow === effective) return false;
	model.contextWindow = effective;
	return true;
}

function restoreContextWindow(model: AnyModel | undefined): boolean {
	if (!model) return false;
	const original = originalContextWindows.get(model);
	if (typeof original !== "number") return false;
	if (model.contextWindow === original) return false;
	model.contextWindow = original;
	return true;
}

function forEachRegistryModel(ctx: ExtensionContext, callback: (model: AnyModel) => void): void {
	try {
		for (const model of ctx.modelRegistry.getAll()) {
			callback(model);
		}
	} catch {
		// Best effort. The active ctx.model is handled separately.
	}
}

function applyContextCapToSession(ctx: ExtensionContext): number {
	let changed = 0;
	forEachRegistryModel(ctx, (model) => {
		if (applyContextCap(model)) changed++;
	});
	if (applyContextCap(ctx.model)) changed++;
	return changed;
}

function restoreContextCapForSession(ctx: ExtensionContext): number {
	let changed = 0;
	forEachRegistryModel(ctx, (model) => {
		if (restoreContextWindow(model)) changed++;
	});
	if (restoreContextWindow(ctx.model)) changed++;
	return changed;
}

function isContextCapDisabled(cwd: string): boolean {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.contextCap?.disabled === true;
	} catch {
		return false;
	}
}

type ContextCapToggleResult = {
	changed: boolean;
	nowDisabled: boolean;
	settingsPath: string;
	backupPath?: string;
};

function toggleContextCapSetting(cwd: string): ContextCapToggleResult {
	return withLockedTlhSettingsWrite(
		cwd,
		"Refusing to write context-cap settings outside the isolated TLH profile.",
		(current) => {
			const settings: TlhSettings = current ? (JSON.parse(current) as TlhSettings) : {};
			const currentlyDisabled = settings.tlh?.contextCap?.disabled === true;
			const nowDisabled = !currentlyDisabled;
			settings.tlh ??= {};
			settings.tlh.contextCap ??= {};
			settings.tlh.contextCap.disabled = nowDisabled;
			return {
				changed: true,
				nowDisabled,
				nextContent: `${JSON.stringify(settings, null, 2)}\n`,
			};
		},
	);
}

export function registerContextCap(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (isContextCapDisabled(ctx.cwd)) return;
		applyContextCapToSession(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (isContextCapDisabled(ctx.cwd)) return;
		applyContextCap(event.model);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		restoreContextCapForSession(ctx);
	});

	pi.registerCommand("toggle-context-cap", {
		description: "Toggle the 200k effective context-window cap for auto-compaction",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(TOGGLE_CONTEXT_CAP_COMMAND_HELP, "error");
				return;
			}

			try {
				const result = toggleContextCapSetting(ctx.cwd);
				const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
				if (result.nowDisabled) {
					restoreContextCapForSession(ctx);
					ctx.ui.notify(
						`Context cap disabled. Updated TLH settings at ${formatHomePath(result.settingsPath)}.${backupLabel}`,
						"info",
					);
				} else {
					applyContextCapToSession(ctx);
					ctx.ui.notify(
						`Context cap enabled. Updated TLH settings at ${formatHomePath(result.settingsPath)}.${backupLabel}`,
						"info",
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not update context cap setting: ${message}`, "error");
			}
		},
	});
}
