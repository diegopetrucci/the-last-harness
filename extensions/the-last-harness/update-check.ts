import { SettingsManager, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	TLH_LATEST_RELEASE_API_URL,
	TLH_NAME,
	TLH_RELEASES_URL,
	TLH_UPDATE_CHECK_INTERVAL_MS,
	TLH_UPDATE_CHECK_TIMEOUT_MS,
} from "./constants.js";
import { getTlhVersion, isNewerTlhVersion, normalizeTlhVersion } from "./package-version.js";
import {
	readTlhInstallState,
	readTlhStartupState,
	tlhStartupStatePath,
	updateTlhStartupState,
} from "./profile-state.js";
import type {
	TlhHeaderUpdate,
	TlhInstallState,
	TlhLatestRelease,
	TlhSettings,
	TlhStartupState,
	TlhUpdateCheckConfig,
} from "./types.js";

let checkedTlhHeaderUpdate = false;
let cachedTlhHeaderUpdate: TlhHeaderUpdate | undefined;

export function getTlhHeaderUpdate(): TlhHeaderUpdate | undefined {
	if (checkedTlhHeaderUpdate) {
		return cachedTlhHeaderUpdate;
	}

	checkedTlhHeaderUpdate = true;
	const currentVersion = getTlhVersion();
	const lastSeenVersion = readTlhStartupState().lastSeenVersion;

	if (lastSeenVersion !== currentVersion) {
		updateTlhStartupState({ lastSeenVersion: currentVersion });
	}
	if (typeof lastSeenVersion === "string" && lastSeenVersion.length > 0 && lastSeenVersion !== currentVersion) {
		cachedTlhHeaderUpdate = { version: currentVersion, releasesUrl: TLH_RELEASES_URL };
	}

	return cachedTlhHeaderUpdate;
}

function getCachedTlhLatestRelease(state: TlhStartupState): TlhLatestRelease | undefined {
	const latestVersion = state.updateCheck?.latestVersion;
	if (typeof latestVersion !== "string" || !latestVersion.trim()) {
		return undefined;
	}
	const version = normalizeTlhVersion(latestVersion);
	const tagName = state.updateCheck?.latestTagName || `v${version}`;
	return {
		version,
		tagName,
		releaseUrl: state.updateCheck?.latestReleaseUrl || `${TLH_RELEASES_URL}/tag/${tagName}`,
	};
}

function shouldRefreshTlhLatestRelease(state: TlhStartupState): boolean {
	const checkedAt = state.updateCheck?.checkedAt;
	const checkedAtMs = typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
	return !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs >= TLH_UPDATE_CHECK_INTERVAL_MS;
}

function shouldSkipTlhUpdateCheck(cwd: string): boolean {
	if (!tlhStartupStatePath() || process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK || process.env.TLH_SKIP_UPDATE_CHECK) {
		return true;
	}
	return getTlhUpdateCheckConfig(cwd)?.enabled === false;
}

async function fetchLatestTlhRelease(currentVersion: string): Promise<TlhLatestRelease | undefined> {
	const response = await fetch(TLH_LATEST_RELEASE_API_URL, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": `${TLH_NAME}/${currentVersion}`,
		},
		signal: AbortSignal.timeout(TLH_UPDATE_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) {
		return undefined;
	}

	const data = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
	if (typeof data.tag_name !== "string" || !data.tag_name.trim()) {
		return undefined;
	}
	const tagName = data.tag_name.trim();
	const version = normalizeTlhVersion(tagName);
	const releaseUrl = typeof data.html_url === "string" && data.html_url.trim() ? data.html_url.trim() : `${TLH_RELEASES_URL}/tag/${tagName}`;
	return { version, tagName, releaseUrl };
}

function normalizeInstallStateValue(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized ? normalized : undefined;
}

export function buildTlhUpdateNotificationMessage(
	latestRelease: TlhLatestRelease,
	installState: TlhInstallState = readTlhInstallState(),
): string {
	const latestLabel = latestRelease.tagName.startsWith("v") ? latestRelease.tagName : `v${latestRelease.version}`;
	const installTrack = normalizeInstallStateValue(installState.track);

	if (installTrack === "latest-release") {
		return `The Last Harness update available. Run \`tlh update\` to get on version ${latestLabel}.\nRelease notes: ${latestRelease.releaseUrl}`;
	}
	if (installTrack === "pinned-tag") {
		return `The Last Harness update available. Run \`tlh update --track latest-release\` to get on version ${latestLabel}.`;
	}
	if (installTrack === "ref") {
		const refLabel = normalizeInstallStateValue(installState.ref);
		const currentInstall = refLabel ? `your \`${refLabel}\` install` : "your current ref install";
		return `The Last Harness update available. Run \`tlh update\` to update ${currentInstall}, or \`tlh update --track latest-release\` to switch to version ${latestLabel}.`;
	}
	if (installTrack === "custom") {
		return `The Last Harness update available. This install uses a custom update track, so plain \`tlh update\` is not enough to move to version ${latestLabel}. Re-run the appropriate installer command manually, or run \`tlh update\` with explicit update-target overrides such as \`--track\`, \`--ref\`, and \`--package-source\`.`;
	}
	return `The Last Harness update available. Run \`tlh update\` to get on version ${latestLabel}.`;
}

function notifyTlhUpdate(ctx: ExtensionContext, _currentVersion: string, latestRelease: TlhLatestRelease): void {
	ctx.ui.notify(buildTlhUpdateNotificationMessage(latestRelease), "warning");
}

function maybeNotifyCachedTlhUpdate(ctx: ExtensionContext, currentVersion: string, state: TlhStartupState): boolean {
	const latestRelease = getCachedTlhLatestRelease(state);
	if (!latestRelease || !isNewerTlhVersion(latestRelease.version, currentVersion)) {
		return false;
	}
	if (state.updateCheck?.lastNotifiedVersion === latestRelease.version) {
		return false;
	}
	notifyTlhUpdate(ctx, currentVersion, latestRelease);
	updateTlhStartupState({
		updateCheck: {
			...state.updateCheck,
			latestVersion: latestRelease.version,
			latestTagName: latestRelease.tagName,
			latestReleaseUrl: latestRelease.releaseUrl,
			lastNotifiedVersion: latestRelease.version,
		},
	});
	return true;
}

export async function maybeNotifyAvailableTlhUpdate(ctx: ExtensionContext): Promise<void> {
	if (shouldSkipTlhUpdateCheck(ctx.cwd)) {
		return;
	}

	const currentVersion = getTlhVersion();
	let state = readTlhStartupState();
	if (!shouldRefreshTlhLatestRelease(state)) {
		maybeNotifyCachedTlhUpdate(ctx, currentVersion, state);
		return;
	}

	updateTlhStartupState({
		updateCheck: {
			...state.updateCheck,
			checkedAt: new Date().toISOString(),
		},
	});

	let latestRelease: TlhLatestRelease | undefined;
	try {
		latestRelease = await fetchLatestTlhRelease(currentVersion);
	} catch {
		return;
	}
	if (!latestRelease) {
		return;
	}

	state = readTlhStartupState();
	updateTlhStartupState({
		updateCheck: {
			...state.updateCheck,
			latestVersion: latestRelease.version,
			latestTagName: latestRelease.tagName,
			latestReleaseUrl: latestRelease.releaseUrl,
		},
	});

	state = readTlhStartupState();
	if (!isNewerTlhVersion(latestRelease.version, currentVersion) || state.updateCheck?.lastNotifiedVersion === latestRelease.version) {
		return;
	}

	notifyTlhUpdate(ctx, currentVersion, latestRelease);
	updateTlhStartupState({
		updateCheck: {
			...state.updateCheck,
			lastNotifiedVersion: latestRelease.version,
		},
	});
}

function getTlhUpdateCheckConfig(cwd: string): TlhUpdateCheckConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.updateCheck;
	} catch {
		return undefined;
	}
}
