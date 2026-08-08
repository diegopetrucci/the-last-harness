import { TLH_REPO } from "./constants.js";
import { readTlhInstallState, readTlhInstallStateAsync } from "./profile-state.js";
const STABLE_TRACK = "latest-release";
const VALID_TRACKS = new Set([STABLE_TRACK, "pinned-tag", "ref", "custom"]);
const REF_REQUIRED_TRACKS = new Set([STABLE_TRACK, "pinned-tag", "ref"]);
function normalizedString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return normalized ? normalized : undefined;
}
function isLocalPackageSource(value) {
    const source = normalizedString(value);
    if (!source) {
        return false;
    }
    const normalized = source.toLowerCase();
    return (normalized === "." ||
        normalized === ".." ||
        normalized === "~" ||
        source.startsWith("./") ||
        source.startsWith("../") ||
        source.startsWith("~/") ||
        source.startsWith("/") ||
        source.startsWith("\\\\") ||
        /^[A-Za-z]:[\\/]/.test(source) ||
        normalized.startsWith("file:"));
}
function isDefaultPackageSource(state) {
    if (state?.packageSourceIsDefault === true) {
        return true;
    }
    if (state?.packageSourceIsDefault === false) {
        return false;
    }
    return undefined;
}
export function classifyTlhInstallState(state) {
    const repo = normalizedString(state?.repo);
    const track = normalizedString(state?.track);
    const ref = normalizedString(state?.ref);
    const packageSource = normalizedString(state?.packageSource);
    const defaultPackageSource = isDefaultPackageSource(state);
    if (!repo || !track || !VALID_TRACKS.has(track) || !packageSource || defaultPackageSource === undefined) {
        return {
            kind: "unknown",
            summary: "TLH install metadata is missing or invalid.",
        };
    }
    if (REF_REQUIRED_TRACKS.has(track) && !ref) {
        return {
            kind: "unknown",
            summary: "TLH install metadata is missing or invalid.",
        };
    }
    if (repo !== TLH_REPO) {
        return {
            kind: "non-default-repo",
            summary: "TLH is installed from a non-default repository.",
            detail: repo,
        };
    }
    if (track === "pinned-tag" && ref) {
        return {
            kind: "pinned-tag",
            summary: "TLH is pinned to a specific release tag.",
            detail: ref,
        };
    }
    if (track === "ref" && ref) {
        return {
            kind: "ref",
            summary: "TLH follows a non-stable git ref.",
            detail: ref,
        };
    }
    if (defaultPackageSource === false) {
        return {
            kind: "custom-package-source",
            summary: "TLH uses a custom package source.",
            detail: packageSource,
        };
    }
    if (track === STABLE_TRACK) {
        return undefined;
    }
    if (track === "pinned-tag") {
        return {
            kind: "pinned-tag",
            summary: "TLH is pinned to a specific release tag.",
            detail: ref,
        };
    }
    if (track === "ref") {
        return {
            kind: "ref",
            summary: "TLH follows a non-stable git ref.",
            detail: ref,
        };
    }
    return {
        kind: "custom-track",
        summary: "TLH uses a custom update track.",
        detail: track,
    };
}
export function readTlhInstallNotice() {
    return classifyTlhInstallState(readTlhInstallState());
}
export async function readTlhInstallNoticeAsync() {
    return classifyTlhInstallState(await readTlhInstallStateAsync());
}
export function formatTlhInstallNoticeTrackLabel(notice) {
    if (notice.kind === "unknown") {
        return "unknown";
    }
    if (notice.kind === "custom-package-source" && isLocalPackageSource(normalizedString(notice.detail))) {
        return "local";
    }
    if ((notice.kind === "pinned-tag" || notice.kind === "ref") && normalizedString(notice.detail)) {
        return normalizedString(notice.detail) || "custom";
    }
    return "custom";
}
