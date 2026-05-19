import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { arch as osArch, platform as osPlatform, release as osRelease, type as osType } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	TLH_NAME,
	TLH_TELEMETRY_APP_ID,
	TLH_TELEMETRY_EVENT_TYPE,
	TLH_TELEMETRY_INGEST_BASE_URL,
	TLH_TELEMETRY_NAMESPACE,
	TLH_TELEMETRY_STATE_SCHEMA_VERSION,
	TLH_TELEMETRY_TIMEOUT_MS,
} from "./constants.js";
import { isFalseyEnvFlag, isPlainObject, isTruthyEnvFlag, readText } from "./common.js";
import { getTlhVersion } from "./package-version.js";
import { tlhStateDir, tlhTelemetryStatePath } from "./profile-state.js";
import type { TlhOsMetadata, TlhTelemetryConfig, TlhTelemetrySnapshot, TlhTelemetryState } from "./types.js";

const execFileAsync = promisify(execFile);

let sentTlhLaunchTelemetry = false;

function configuredTlhTelemetryNamespace(): string {
	return (process.env.TLH_TELEMETRY_NAMESPACE || TLH_TELEMETRY_NAMESPACE).trim();
}

function configuredTlhTelemetryAppId(): string {
	return (process.env.TLH_TELEMETRY_APP_ID || TLH_TELEMETRY_APP_ID).trim();
}

function configuredTlhTelemetryIngestBaseUrl(): string {
	return (process.env.TLH_TELEMETRY_INGEST_BASE_URL || TLH_TELEMETRY_INGEST_BASE_URL).trim().replace(/\/+$/, "");
}

function readTlhTelemetrySettings(): { ok: true; config?: TlhTelemetryConfig } | { ok: false } {
	const stateDir = tlhStateDir();
	if (!stateDir) {
		return { ok: false };
	}

	const settingsPath = join(dirname(stateDir), "settings.json");
	if (!existsSync(settingsPath)) {
		return { ok: true };
	}
	const settingsContent = readText(settingsPath);
	if (settingsContent === undefined) {
		return { ok: false };
	}
	if (!settingsContent.trim()) {
		return { ok: true };
	}

	let settings: unknown;
	try {
		settings = JSON.parse(settingsContent);
	} catch {
		return { ok: false };
	}
	if (!isPlainObject(settings)) {
		return { ok: false };
	}

	const tlh = settings.tlh;
	if (tlh !== undefined && !isPlainObject(tlh)) {
		return { ok: false };
	}
	const telemetry = isPlainObject(tlh) ? tlh.telemetry : undefined;
	if (telemetry !== undefined && !isPlainObject(telemetry)) {
		return { ok: false };
	}
	const enabled = isPlainObject(telemetry) ? telemetry.enabled : undefined;
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { ok: false };
	}
	return { ok: true, config: telemetry as TlhTelemetryConfig | undefined };
}

function shouldSkipTlhLaunchTelemetry(): boolean {
	if (!tlhTelemetryStatePath()) return true;
	if (!configuredTlhTelemetryNamespace() || !configuredTlhTelemetryAppId() || !configuredTlhTelemetryIngestBaseUrl()) return true;
	if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return true;
	if (isTruthyEnvFlag(process.env.TLH_SKIP_TELEMETRY)) return true;
	if (isTruthyEnvFlag(process.env.TLH_TELEMETRY_DISABLED)) return true;
	if (isFalseyEnvFlag(process.env.PI_TELEMETRY)) return true;

	const telemetrySettings = readTlhTelemetrySettings();
	if (!telemetrySettings.ok) return true;
	return telemetrySettings.config?.enabled === false;
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readTlhTelemetryState(): TlhTelemetryState | undefined {
	const statePath = tlhTelemetryStatePath();
	const content = statePath ? readText(statePath) : undefined;
	if (!content) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(content) as TlhTelemetryState;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function writeTlhTelemetryState(state: TlhTelemetryState): boolean {
	try {
		const statePath = tlhTelemetryStatePath();
		if (!statePath) return false;
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

function getOrCreateTlhTelemetryInstallId(): string | undefined {
	const existing = readTlhTelemetryState();
	if (existing?.schemaVersion === TLH_TELEMETRY_STATE_SCHEMA_VERSION && isUuid(existing.installId)) {
		return existing.installId;
	}

	const installId = randomUUID();
	return writeTlhTelemetryState({ schemaVersion: TLH_TELEMETRY_STATE_SCHEMA_VERSION, installId }) ? installId : undefined;
}

function hashTlhTelemetryClientUser(installId: string): string {
	return createHash("sha256").update(installId).digest("hex");
}

const PUBLIC_MODEL_ID_PATTERNS: RegExp[] = [
	/^gpt-[a-z0-9._-]+$/,
	/^o[0-9][a-z0-9._-]*$/,
	/^chatgpt-[a-z0-9._-]+$/,
	/^claude-[a-z0-9._-]+$/,
	/^gemini-[a-z0-9._-]+$/,
	/^grok-[a-z0-9._-]+$/,
	/^deepseek-[a-z0-9._-]+$/,
	/^qwen[a-z0-9._-]*$/,
	/^kimi-[a-z0-9._-]+$/,
	/^mistral-[a-z0-9._-]+$/,
	/^codestral-[a-z0-9._-]+$/,
	/^devstral-[a-z0-9._-]+$/,
	/^llama-[a-z0-9._-]+$/,
	/^command-[a-z0-9._-]+$/,
	/^nova-[a-z0-9._-]+$/,
	/^mimo-[a-z0-9._-]+$/,
];

function privacySafeTlhTelemetryModelId(modelId: string | undefined): string {
	if (typeof modelId !== "string" || !modelId.trim()) {
		return "unknown";
	}
	const lastSegment = modelId.trim().split("/").pop()?.trim() || "";
	const normalized = lastSegment.toLowerCase();
	if (!normalized || normalized.length > 80 || !/^[a-z0-9._-]+$/.test(normalized)) {
		return "custom";
	}
	return PUBLIC_MODEL_ID_PATTERNS.some((pattern) => pattern.test(normalized)) ? normalized : "custom";
}

function unknownIfEmpty(value: string | undefined): string {
	return value && value.trim() ? value.trim() : "unknown";
}

function majorMinorVersion(version: string): string {
	const match = version.trim().match(/^(\d+)(?:\.(\d+))?/);
	if (!match) return unknownIfEmpty(version);
	return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

function parseOsRelease(content: string | undefined): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of (content || "").split(/\r?\n/)) {
		const match = line.match(/^([A-Z][A-Z0-9_]+)=(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields[match[1]] = value.replace(/\\(["'`$\\])/g, "$1");
	}
	return fields;
}

async function getMacOsVersion(): Promise<string> {
	try {
		const { stdout } = await execFileAsync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 750 });
		return majorMinorVersion(stdout.trim());
	} catch {
		return majorMinorVersion(osRelease());
	}
}

async function getTlhOsMetadata(): Promise<TlhOsMetadata> {
	const architecture = unknownIfEmpty(osArch());
	try {
		const platform = osPlatform();
		if (platform === "darwin") {
			return { osName: "macOS", osVersion: await getMacOsVersion(), osArch: architecture };
		}
		if (platform === "linux") {
			const osReleaseFields = parseOsRelease(readText("/etc/os-release"));
			return {
				osName: unknownIfEmpty(osReleaseFields.NAME || osReleaseFields.ID || "Linux"),
				osVersion: unknownIfEmpty(osReleaseFields.VERSION_ID || majorMinorVersion(osRelease())),
				osArch: architecture,
			};
		}
		if (platform === "win32") {
			return { osName: "Windows", osVersion: majorMinorVersion(osRelease()), osArch: architecture };
		}
		return { osName: unknownIfEmpty(osType()), osVersion: majorMinorVersion(osRelease()), osArch: architecture };
	} catch {
		return { osName: "unknown", osVersion: "unknown", osArch: architecture };
	}
}

async function maybeSendTlhLaunchTelemetry(snapshot: TlhTelemetrySnapshot): Promise<void> {
	if (shouldSkipTlhLaunchTelemetry()) return;

	const namespace = configuredTlhTelemetryNamespace();
	const appID = configuredTlhTelemetryAppId();
	const installId = getOrCreateTlhTelemetryInstallId();
	if (!namespace || !appID || !installId) return;

	const osMetadata = await getTlhOsMetadata();
	const body = [
		{
			appID,
			clientUser: hashTlhTelemetryClientUser(installId),
			type: TLH_TELEMETRY_EVENT_TYPE,
			payload: {
				"Tlh.App.version": snapshot.version,
				"Tlh.Runtime.model": privacySafeTlhTelemetryModelId(snapshot.modelId),
				"Tlh.Device.osName": osMetadata.osName,
				"Tlh.Device.osVersion": osMetadata.osVersion,
				"Tlh.Device.osArch": osMetadata.osArch,
			},
		},
	];

	try {
		await fetch(`${configuredTlhTelemetryIngestBaseUrl()}/${encodeURIComponent(namespace)}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"User-Agent": `${TLH_NAME}/${snapshot.version}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TLH_TELEMETRY_TIMEOUT_MS),
		});
	} catch {
		// Launch telemetry is best-effort; never block or notify during startup.
	}
}

export function scheduleTlhLaunchTelemetry(ctx: ExtensionContext): void {
	if (sentTlhLaunchTelemetry) {
		return;
	}
	sentTlhLaunchTelemetry = true;
	const telemetrySnapshot: TlhTelemetrySnapshot = {
		version: getTlhVersion(),
		modelId: ctx.model?.id,
	};
	const timer = setTimeout(() => {
		void maybeSendTlhLaunchTelemetry(telemetrySnapshot).catch(() => undefined);
	}, 0) as ReturnType<typeof setTimeout> & { unref?: () => void };
	timer.unref?.();
}
