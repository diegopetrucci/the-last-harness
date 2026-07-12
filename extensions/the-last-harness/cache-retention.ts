import { SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatHomePath, isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import type { TlhPrimaryAgentRuntime } from "./primary-agent-runtime.js";
import type { TlhCacheRetentionConfig, TlhCacheRetentionWriteResult, TlhSettings } from "./types.js";

const TOGGLE_CACHE_RETENTION_COMMAND_HELP = "Usage: /toggle-cache-retention";
export const ANTHROPIC_LONG_CACHE_RETENTION_TTL = "1h";

type CacheRetentionToggleResult = TlhCacheRetentionWriteResult & {
	enabled: boolean;
};

function getAnthropicCacheRetentionConfig(cwd: string): TlhCacheRetentionConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.cacheRetention;
	} catch {
		return undefined;
	}
}

function isAnthropicCacheRetentionEnabled(cwd: string): boolean {
	return getAnthropicCacheRetentionConfig(cwd)?.anthropic === "long";
}

function validateTlhCacheRetentionSettings(settings: unknown): asserts settings is TlhSettings {
	if (!isRecord(settings)) {
		throw new Error("settings.json must contain a JSON object");
	}
	const tlh = settings.tlh;
	if (tlh !== undefined && !isRecord(tlh)) {
		throw new Error("settings field 'tlh' must be an object if present");
	}
	const cacheRetention = isRecord(tlh) ? tlh.cacheRetention : undefined;
	if (cacheRetention !== undefined && !isRecord(cacheRetention)) {
		throw new Error("settings field 'tlh.cacheRetention' must be an object if present");
	}
	const anthropic = isRecord(cacheRetention) ? cacheRetention.anthropic : undefined;
	if (anthropic !== undefined && anthropic !== "long") {
		throw new Error("settings field 'tlh.cacheRetention.anthropic' must be 'long' if present");
	}
}

function ensureMutableCacheRetentionSettings(settings: TlhSettings): asserts settings is TlhSettings & {
	tlh: { cacheRetention: TlhCacheRetentionConfig };
} {
	validateTlhCacheRetentionSettings(settings);
	settings.tlh ??= {};
	settings.tlh.cacheRetention ??= {};
}

function parseTlhSettingsContent(content: string | undefined): TlhSettings {
	if (!content) {
		return {};
	}
	const parsed = JSON.parse(content) as unknown;
	validateTlhCacheRetentionSettings(parsed);
	return parsed;
}

function toggleAnthropicCacheRetention(cwd: string): CacheRetentionToggleResult {
	return withLockedTlhSettingsWrite(cwd, "Refusing to write cache-retention settings outside the isolated TLH profile.", (current) => {
		const settings = parseTlhSettingsContent(current);
		const enabled = settings.tlh?.cacheRetention?.anthropic !== "long";

		ensureMutableCacheRetentionSettings(settings);
		if (enabled) {
			settings.tlh.cacheRetention.anthropic = "long";
		} else {
			delete settings.tlh.cacheRetention.anthropic;
		}
		return {
			changed: true,
			enabled,
			nextContent: `${JSON.stringify(settings, null, 2)}\n`,
		};
	});
}

function isAnthropicDirectMessagesPayload(
	payload: unknown,
	ctx: ExtensionContext,
): payload is Record<string, unknown> & { messages: unknown[] } {
	return ctx.model?.provider === "anthropic"
		&& ctx.model.compat?.supportsLongCacheRetention !== false
		&& isRecord(payload)
		&& Array.isArray(payload.messages);
}

function upgradeDirectCacheControlBlocks(value: unknown): { value: unknown; changed: boolean } {
	if (!Array.isArray(value)) {
		return { value, changed: false };
	}
	let changed = false;
	const next = value.map((block) => {
		if (!isRecord(block) || !isRecord(block.cache_control) || block.cache_control.type !== "ephemeral") {
			return block;
		}
		if (block.cache_control.ttl === ANTHROPIC_LONG_CACHE_RETENTION_TTL) {
			return block;
		}
		changed = true;
		return {
			...block,
			cache_control: { ...block.cache_control, ttl: ANTHROPIC_LONG_CACHE_RETENTION_TTL },
		};
	});
	return changed ? { value: next, changed: true } : { value, changed: false };
}

export function upgradeAnthropicPrimaryRequestCacheRetention(payload: unknown, ctx: ExtensionContext): unknown {
	if (!isAnthropicDirectMessagesPayload(payload, ctx)) {
		return payload;
	}

	let changed = false;
	const next: Record<string, unknown> = { ...payload };
	for (const field of ["system", "tools"] as const) {
		const upgraded = upgradeDirectCacheControlBlocks(payload[field]);
		if (upgraded.changed) {
			next[field] = upgraded.value;
			changed = true;
		}
	}

	const messages = payload.messages.map((message) => {
		if (!isRecord(message)) {
			return message;
		}
		const upgraded = upgradeDirectCacheControlBlocks(message.content);
		if (!upgraded.changed) {
			return message;
		}
		changed = true;
		return { ...message, content: upgraded.value };
	});
	if (changed) {
		next.messages = messages;
	}
	return changed ? next : payload;
}

function isArchitectPrimaryActive(runtime?: TlhPrimaryAgentRuntime): boolean {
	return runtime?.activePrimaryAgentPrompt()?.name === "architect";
}

export function registerAnthropicCacheRetention(pi: ExtensionAPI, runtime?: TlhPrimaryAgentRuntime): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (!isAnthropicCacheRetentionEnabled(ctx.cwd) || !isArchitectPrimaryActive(runtime)) {
			return undefined;
		}
		const upgradedPayload = upgradeAnthropicPrimaryRequestCacheRetention(event.payload, ctx);
		return upgradedPayload === event.payload ? undefined : upgradedPayload;
	});

	pi.registerCommand("toggle-cache-retention", {
		description: "Toggle long Anthropic cache retention for direct primary requests",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(TOGGLE_CACHE_RETENTION_COMMAND_HELP, "error");
				return;
			}

			try {
				const result = toggleAnthropicCacheRetention(ctx.cwd);
				const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
				const status = result.enabled
					? "Anthropic 1-hour cache retention enabled for supported direct architect-primary requests. Cache writes cost 2x input versus 1.25x for 5-minute retention. Toggle again to disable."
					: "Anthropic long cache retention disabled; direct primary requests now use upstream cache retention behavior.";
				ctx.ui.notify(`Updated TLH cache retention at ${formatHomePath(result.settingsPath)}. ${status}${backupLabel}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not update TLH cache retention: ${message}`, "error");
			}
		},
	});
}
