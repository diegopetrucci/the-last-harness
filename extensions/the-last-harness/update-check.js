import { SettingsManager, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { TLH_LATEST_RELEASE_API_URL, TLH_MAIN_COMPARE_API_URL, TLH_NAME, TLH_RELEASES_URL, TLH_UPDATE_CHECK_INTERVAL_MS, TLH_UPDATE_CHECK_TIMEOUT_MS, } from "./constants.js";
import { compareTlhVersions, getTlhVersion, isNewerTlhVersion, normalizeTlhVersion, } from "./package-version.js";
import { readTlhInstallNotice } from "./install-state.js";
import { readTlhInstallState, readTlhStartupState, tlhStartupStatePath, updateTlhStartupState, } from "./profile-state.js";
import { isRecord } from "./common.js";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAIN_TRACK_COMPARISON_STATUSES = new Set([
    "behind",
    "ahead",
    "identical",
    "diverged",
    "unavailable",
]);
const defaultTlhUpdateCheckHooks = {
    now: () => Date.now(),
    fetchLatestRelease: fetchLatestTlhRelease,
    fetchMainTrackComparison: fetchMainTrackComparison,
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
    if (typeof lastSeenVersion === "string" &&
        lastSeenVersion.length > 0 &&
        lastSeenVersion !== currentVersion) {
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
    if (updateCheck.latestReleaseUrl !== undefined &&
        (typeof updateCheck.latestReleaseUrl !== "string" || !updateCheck.latestReleaseUrl.trim())) {
        return undefined;
    }
    const tagName = typeof updateCheck.latestTagName === "string"
        ? updateCheck.latestTagName.trim()
        : `v${version}`;
    const releaseUrl = typeof updateCheck.latestReleaseUrl === "string"
        ? updateCheck.latestReleaseUrl.trim()
        : `${TLH_RELEASES_URL}/tag/${tagName}`;
    return { version, tagName, releaseUrl };
}
function normalizedCommitSha(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    return COMMIT_SHA_PATTERN.test(normalized) ? normalized : undefined;
}
function getMainTrackCommitSha(notice) {
    if (notice?.kind !== "ref" || notice.detail !== "main") {
        return undefined;
    }
    return normalizedCommitSha(notice.commitSha);
}
function isValidMainTrackComparisonStatus(value) {
    return (typeof value === "string" &&
        MAIN_TRACK_COMPARISON_STATUSES.has(value));
}
function normalizeMainTrackComparison(value) {
    if (!isRecord(value)) {
        return { status: "unavailable" };
    }
    const status = value.status;
    if (!isValidMainTrackComparisonStatus(status) || status === "unavailable") {
        return { status: "unavailable" };
    }
    if (status !== "behind") {
        return { status };
    }
    const behindBy = value.behindBy;
    if (typeof behindBy !== "number" || !Number.isSafeInteger(behindBy) || behindBy <= 0) {
        return { status: "unavailable" };
    }
    return { status, behindBy };
}
function getCachedTlhMainTrackComparison(state, commitSha) {
    const updateCheck = getTlhUpdateCheckState(state);
    if (normalizedCommitSha(updateCheck.mainTrackCommitSha) !== commitSha) {
        return undefined;
    }
    const status = updateCheck.mainTrackStatus;
    if (!isValidMainTrackComparisonStatus(status)) {
        return undefined;
    }
    if (status === "unavailable") {
        return "unavailable";
    }
    if (status !== "behind") {
        return { status };
    }
    const behindBy = updateCheck.mainTrackBehindBy;
    if (typeof behindBy !== "number" || !Number.isSafeInteger(behindBy) || behindBy <= 0) {
        return "unavailable";
    }
    return { status, behindBy };
}
function shouldRefreshTlhLatestRelease(state) {
    const checkedAt = getTlhUpdateCheckState(state).checkedAt;
    const checkedAtMs = typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
    const now = tlhUpdateCheckHooks.now();
    return (!Number.isFinite(checkedAtMs) ||
        checkedAtMs > now ||
        now - checkedAtMs >= TLH_UPDATE_CHECK_INTERVAL_MS);
}
function shouldSkipTlhUpdateCheck(cwd) {
    if (!tlhStartupStatePath() ||
        process.env.PI_OFFLINE ||
        process.env.PI_SKIP_VERSION_CHECK ||
        process.env.TLH_SKIP_UPDATE_CHECK) {
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
    const releaseUrl = typeof data.html_url === "string" && data.html_url.trim()
        ? data.html_url.trim()
        : `${TLH_RELEASES_URL}/tag/${tagName}`;
    return { version, tagName, releaseUrl };
}
async function fetchMainTrackComparison(commitSha) {
    const normalizedSha = normalizedCommitSha(commitSha);
    if (!normalizedSha) {
        return undefined;
    }
    const response = await fetch(`${TLH_MAIN_COMPARE_API_URL}/main...${normalizedSha}`, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `${TLH_NAME}/${getTlhVersion()}`,
        },
        signal: AbortSignal.timeout(TLH_UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
        return undefined;
    }
    const data = (await response.json());
    const status = data.status;
    if (status !== "behind" &&
        status !== "ahead" &&
        status !== "identical" &&
        status !== "diverged") {
        return undefined;
    }
    if (status !== "behind") {
        return { status };
    }
    const behindBy = data.behind_by;
    if (typeof behindBy !== "number" || !Number.isSafeInteger(behindBy) || behindBy <= 0) {
        return undefined;
    }
    return { status, behindBy };
}
export function getTlhMainTrackBehindCount(cwd, installNotice = readTlhInstallNotice()) {
    if (shouldSkipTlhUpdateCheck(cwd)) {
        return undefined;
    }
    const commitSha = getMainTrackCommitSha(installNotice);
    if (!commitSha) {
        return undefined;
    }
    const state = readTlhStartupState();
    if (shouldRefreshTlhLatestRelease(state)) {
        return undefined;
    }
    const comparison = getCachedTlhMainTrackComparison(state, commitSha);
    return typeof comparison === "object" && comparison.status === "behind"
        ? comparison.behindBy
        : undefined;
}
function normalizeInstallStateValue(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return normalized ? normalized : undefined;
}
export function buildTlhUpdateNotificationMessage(latestRelease, installState = readTlhInstallState()) {
    const latestLabel = latestRelease.tagName.startsWith("v")
        ? latestRelease.tagName
        : `v${latestRelease.version}`;
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
function canNotifyTlhUpdate(options) {
    return options.canNotify?.() ?? true;
}
function notifyTlhUpdate(ctx, latestRelease) {
    ctx.ui.notify(buildTlhUpdateNotificationMessage(latestRelease), "warning");
}
function notifiedTlhUpdateKey(version) {
    return `${tlhStartupStatePath() || "no-startup-state"}:${version}`;
}
function maybeNotifyCachedTlhUpdate(ctx, currentVersion, state, options = {}) {
    const latestRelease = getCachedTlhLatestRelease(state);
    if (!latestRelease || !isNewerTlhVersion(latestRelease.version, currentVersion)) {
        return false;
    }
    const updateCheck = getTlhUpdateCheckState(state);
    const notificationKey = notifiedTlhUpdateKey(latestRelease.version);
    if (notifiedTlhUpdateVersions.has(notificationKey) || !canNotifyTlhUpdate(options)) {
        return false;
    }
    notifyTlhUpdate(ctx, latestRelease);
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
function safelyRunTlhUpdateCheck(operation) {
    try {
        return Promise.resolve(operation()).catch(() => undefined);
    }
    catch {
        return Promise.resolve(undefined);
    }
}
async function runMaybeNotifyAvailableTlhUpdate(installNotice) {
    const currentVersion = getTlhVersion();
    const mainTrackCommitSha = getMainTrackCommitSha(installNotice);
    let state = readTlhStartupState();
    if (!shouldRefreshTlhLatestRelease(state)) {
        return {
            currentVersion,
            latestRelease: getCachedTlhLatestRelease(state),
        };
    }
    updateTlhStartupState({
        updateCheck: {
            ...getTlhUpdateCheckState(state),
            checkedAt: new Date(tlhUpdateCheckHooks.now()).toISOString(),
        },
    });
    const latestReleasePromise = safelyRunTlhUpdateCheck(() => tlhUpdateCheckHooks.fetchLatestRelease(currentVersion));
    const mainTrackComparisonPromise = mainTrackCommitSha
        ? safelyRunTlhUpdateCheck(() => tlhUpdateCheckHooks.fetchMainTrackComparison(mainTrackCommitSha))
        : Promise.resolve(undefined);
    const [latestRelease, mainTrackComparison] = await Promise.all([
        latestReleasePromise,
        mainTrackComparisonPromise,
    ]);
    state = readTlhStartupState();
    const updateCheck = getTlhUpdateCheckState(state);
    const normalizedComparison = mainTrackCommitSha
        ? (normalizeMainTrackComparison(mainTrackComparison) ?? { status: "unavailable" })
        : undefined;
    updateTlhStartupState({
        updateCheck: {
            ...updateCheck,
            ...(latestRelease
                ? {
                    latestVersion: latestRelease.version,
                    latestTagName: latestRelease.tagName,
                    latestReleaseUrl: latestRelease.releaseUrl,
                }
                : {}),
            ...(mainTrackCommitSha && normalizedComparison
                ? {
                    mainTrackCommitSha,
                    mainTrackStatus: normalizedComparison.status,
                    ...(normalizedComparison.status === "behind"
                        ? { mainTrackBehindBy: normalizedComparison.behindBy }
                        : { mainTrackBehindBy: undefined }),
                }
                : {}),
        },
    });
    return { currentVersion, latestRelease };
}
export function persistTlhLastSeenVersion() {
    const currentVersion = getTlhVersion();
    if (readTlhStartupState().lastSeenVersion !== currentVersion) {
        updateTlhStartupState({ lastSeenVersion: currentVersion });
    }
}
export async function maybeNotifyAvailableTlhUpdate(ctx, options = {}) {
    if (shouldSkipTlhUpdateCheck(ctx.cwd)) {
        return;
    }
    const installNotice = options.installNotice ?? readTlhInstallNotice();
    const inFlight = maybeNotifyAvailableTlhUpdateInFlight ??
        runMaybeNotifyAvailableTlhUpdate(installNotice).finally(() => {
            if (maybeNotifyAvailableTlhUpdateInFlight === inFlight) {
                maybeNotifyAvailableTlhUpdateInFlight = undefined;
            }
        });
    maybeNotifyAvailableTlhUpdateInFlight = inFlight;
    const result = await inFlight;
    const state = readTlhStartupState();
    maybeNotifyCachedTlhUpdate(ctx, result.currentVersion, state, options);
    if (options.onMainTrackBehindCountChange) {
        options.onMainTrackBehindCountChange(getTlhMainTrackBehindCount(ctx.cwd, installNotice));
    }
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
