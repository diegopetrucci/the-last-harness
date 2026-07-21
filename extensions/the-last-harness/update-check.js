import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { TLH_LATEST_RELEASE_API_URL, TLH_NAME, TLH_RELEASES_URL, TLH_UPDATE_CHECK_INTERVAL_MS, TLH_UPDATE_CHECK_TIMEOUT_MS, } from "./constants.js";
import { compareTlhVersions, getTlhVersion, isNewerTlhVersion, normalizeTlhVersion } from "./package-version.js";
import { readTlhInstallState, readTlhStartupState, tlhStartupStatePath, updateTlhStartupState, } from "./profile-state.js";
import { isRecord } from "./common.js";
const defaultTlhUpdateCheckHooks = {
    now: () => Date.now(),
    fetchLatestRelease: fetchLatestTlhRelease,
};
let tlhUpdateCheckHooks = defaultTlhUpdateCheckHooks;
let maybeNotifyAvailableTlhUpdateInFlight;
const notifiedTlhUpdateVersions = new Set();
let checkedTlhHeaderUpdate = false;
let cachedTlhHeaderUpdate;
export function getTlhHeaderUpdate() {
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
function getTlhUpdateCheckState(state) {
    return isRecord(state.updateCheck) ? state.updateCheck : {};
}
function normalizeValidTlhVersion(value) {
    if (typeof value !== "string" || !value.trim()) {
        return undefined;
    }
    const version = normalizeTlhVersion(value);
    return compareTlhVersions(version, version) === 0 ? version : undefined;
}
function getCachedTlhLatestRelease(state) {
    const updateCheck = getTlhUpdateCheckState(state);
    const version = normalizeValidTlhVersion(updateCheck.latestVersion);
    if (!version) {
        return undefined;
    }
    if (updateCheck.latestTagName !== undefined) {
        const tagVersion = normalizeValidTlhVersion(updateCheck.latestTagName);
        if (!tagVersion || compareTlhVersions(tagVersion, version) !== 0) {
            return undefined;
        }
    }
    if (updateCheck.latestReleaseUrl !== undefined && (typeof updateCheck.latestReleaseUrl !== "string" || !updateCheck.latestReleaseUrl.trim())) {
        return undefined;
    }
    const tagName = typeof updateCheck.latestTagName === "string" ? updateCheck.latestTagName.trim() : `v${version}`;
    const releaseUrl = typeof updateCheck.latestReleaseUrl === "string"
        ? updateCheck.latestReleaseUrl.trim()
        : `${TLH_RELEASES_URL}/tag/${tagName}`;
    return { version, tagName, releaseUrl };
}
function shouldRefreshTlhLatestRelease(state) {
    const checkedAt = getTlhUpdateCheckState(state).checkedAt;
    const checkedAtMs = typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
    const now = tlhUpdateCheckHooks.now();
    return !Number.isFinite(checkedAtMs) || checkedAtMs > now || now - checkedAtMs >= TLH_UPDATE_CHECK_INTERVAL_MS;
}
function shouldSkipTlhUpdateCheck(cwd) {
    if (!tlhStartupStatePath() || process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK || process.env.TLH_SKIP_UPDATE_CHECK) {
        return true;
    }
    return getTlhUpdateCheckConfig(cwd)?.enabled === false;
}
async function fetchLatestTlhRelease(currentVersion) {
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
    const data = (await response.json());
    const tagName = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
    const version = normalizeValidTlhVersion(tagName);
    if (!tagName || !version) {
        return undefined;
    }
    const releaseUrl = typeof data.html_url === "string" && data.html_url.trim() ? data.html_url.trim() : `${TLH_RELEASES_URL}/tag/${tagName}`;
    return { version, tagName, releaseUrl };
}
function normalizeInstallStateValue(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return normalized ? normalized : undefined;
}
export function buildTlhUpdateNotificationMessage(latestRelease, installState = readTlhInstallState()) {
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
function notifyTlhUpdate(ctx, _currentVersion, latestRelease) {
    ctx.ui.notify(buildTlhUpdateNotificationMessage(latestRelease), "warning");
}
function notifiedTlhUpdateKey(version) {
    return `${tlhStartupStatePath() || "no-startup-state"}:${version}`;
}
function maybeNotifyCachedTlhUpdate(ctx, currentVersion, state) {
    const latestRelease = getCachedTlhLatestRelease(state);
    if (!latestRelease || !isNewerTlhVersion(latestRelease.version, currentVersion)) {
        return false;
    }
    const updateCheck = getTlhUpdateCheckState(state);
    const notificationKey = notifiedTlhUpdateKey(latestRelease.version);
    if (updateCheck.lastNotifiedVersion === latestRelease.version || notifiedTlhUpdateVersions.has(notificationKey)) {
        return false;
    }
    notifyTlhUpdate(ctx, currentVersion, latestRelease);
    notifiedTlhUpdateVersions.add(notificationKey);
    updateTlhStartupState({
        updateCheck: {
            ...updateCheck,
            latestVersion: latestRelease.version,
            latestTagName: latestRelease.tagName,
            latestReleaseUrl: latestRelease.releaseUrl,
            lastNotifiedVersion: latestRelease.version,
        },
    });
    return true;
}
async function runMaybeNotifyAvailableTlhUpdate(ctx) {
    const currentVersion = getTlhVersion();
    let state = readTlhStartupState();
    if (!shouldRefreshTlhLatestRelease(state)) {
        maybeNotifyCachedTlhUpdate(ctx, currentVersion, state);
        return;
    }
    updateTlhStartupState({
        updateCheck: {
            ...getTlhUpdateCheckState(state),
            checkedAt: new Date(tlhUpdateCheckHooks.now()).toISOString(),
        },
    });
    let latestRelease;
    try {
        latestRelease = await tlhUpdateCheckHooks.fetchLatestRelease(currentVersion);
    }
    catch {
        return;
    }
    if (!latestRelease) {
        return;
    }
    state = readTlhStartupState();
    updateTlhStartupState({
        updateCheck: {
            ...getTlhUpdateCheckState(state),
            latestVersion: latestRelease.version,
            latestTagName: latestRelease.tagName,
            latestReleaseUrl: latestRelease.releaseUrl,
        },
    });
    state = readTlhStartupState();
    const updateCheck = getTlhUpdateCheckState(state);
    const notificationKey = notifiedTlhUpdateKey(latestRelease.version);
    if (!isNewerTlhVersion(latestRelease.version, currentVersion) || updateCheck.lastNotifiedVersion === latestRelease.version || notifiedTlhUpdateVersions.has(notificationKey)) {
        return;
    }
    notifyTlhUpdate(ctx, currentVersion, latestRelease);
    notifiedTlhUpdateVersions.add(notificationKey);
    updateTlhStartupState({
        updateCheck: {
            ...updateCheck,
            lastNotifiedVersion: latestRelease.version,
        },
    });
}
export async function maybeNotifyAvailableTlhUpdate(ctx) {
    if (shouldSkipTlhUpdateCheck(ctx.cwd)) {
        return;
    }
    if (maybeNotifyAvailableTlhUpdateInFlight) {
        return maybeNotifyAvailableTlhUpdateInFlight;
    }
    const inFlight = runMaybeNotifyAvailableTlhUpdate(ctx).finally(() => {
        if (maybeNotifyAvailableTlhUpdateInFlight === inFlight) {
            maybeNotifyAvailableTlhUpdateInFlight = undefined;
        }
    });
    maybeNotifyAvailableTlhUpdateInFlight = inFlight;
    return inFlight;
}
export function __setTlhUpdateCheckTestHooks(hooks = {}) {
    tlhUpdateCheckHooks = {
        ...defaultTlhUpdateCheckHooks,
        ...hooks,
    };
}
export function __resetTlhUpdateCheckForTests() {
    __setTlhUpdateCheckTestHooks();
    maybeNotifyAvailableTlhUpdateInFlight = undefined;
    notifiedTlhUpdateVersions.clear();
    checkedTlhHeaderUpdate = false;
    cachedTlhHeaderUpdate = undefined;
}
function getTlhUpdateCheckConfig(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return settings.tlh?.updateCheck;
    }
    catch {
        return undefined;
    }
}
