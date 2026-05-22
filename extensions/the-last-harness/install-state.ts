import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TLH_PACKAGE_NAME, TLH_RELEASES_URL, TLH_REPO } from "./constants.js";
import { readTlhInstallState } from "./profile-state.js";
import type { TlhInstallNotice, TlhInstallState } from "./types.js";

const STABLE_TRACK = "latest-release";
const VALID_TRACKS = new Set([STABLE_TRACK, "pinned-tag", "ref", "custom"]);

function normalizedString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized ? normalized : undefined;
}

function isDefaultPackageSource(state: TlhInstallState | undefined): boolean | undefined {
	if (state?.packageSourceIsDefault === true) {
		return true;
	}
	if (state?.packageSourceIsDefault === false) {
		return false;
	}
	return undefined;
}

export function classifyTlhInstallState(state: TlhInstallState | undefined): TlhInstallNotice | undefined {
	const repo = normalizedString(state?.repo);
	const track = normalizedString(state?.track);
	const ref = normalizedString(state?.ref);
	const packageSource = normalizedString(state?.packageSource);

	if (!repo || !track || !VALID_TRACKS.has(track)) {
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

	const defaultPackageSource = isDefaultPackageSource(state);
	if (defaultPackageSource === false) {
		return {
			kind: "custom-package-source",
			summary: "TLH uses a custom package source.",
			detail: packageSource,
		};
	}
	if (defaultPackageSource !== true) {
		return {
			kind: "unknown",
			summary: "TLH install metadata is missing or invalid.",
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

export function readTlhInstallNotice(): TlhInstallNotice | undefined {
	return classifyTlhInstallState(readTlhInstallState());
}

function formatTlhInstallNoticeAction(notice: TlhInstallNotice): string {
	switch (notice.kind) {
		case "pinned-tag":
		case "ref":
		case "custom-track":
			return "To switch to the latest stable release track, run: tlh update --track latest-release.";
		case "custom-package-source":
		case "non-default-repo":
		case "unknown":
		default:
			return "To get back to the official latest stable release install path, rerun the official latest-release installer.";
	}
}

export function formatTlhInstallNoticeMessage(notice: TlhInstallNotice): string {
	const detail = notice.detail ? ` Detail: ${notice.detail}.` : "";
	return `${TLH_PACKAGE_NAME} install warning: ${notice.summary}${detail} ${formatTlhInstallNoticeAction(notice)} Releases: ${TLH_RELEASES_URL}`;
}

export function maybeNotifyTlhInstallNotice(ctx: ExtensionContext): void {
	const notice = readTlhInstallNotice();
	if (!notice) {
		return;
	}
	ctx.ui.notify(formatTlhInstallNoticeMessage(notice), "warning");
}
