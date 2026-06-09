import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildTlhUpdateNotificationMessage } = await jiti.import("../extensions/the-last-harness/update-check.ts");

const LATEST_RELEASE = {
	version: "9.9.9",
	tagName: "v9.9.9",
	releaseUrl: "https://github.com/diegopetrucci/the-last-harness/releases/tag/v9.9.9",
};

test("latest-release notifications keep the plain update command and release notes", () => {
	assert.equal(
		buildTlhUpdateNotificationMessage(LATEST_RELEASE, { track: "latest-release" }),
		"The Last Harness update available. Run `tlh update` to get on version v9.9.9.\nRelease notes: https://github.com/diegopetrucci/the-last-harness/releases/tag/v9.9.9",
	);
});

test("pinned-tag notifications direct users back to the latest-release track", () => {
	assert.equal(
		buildTlhUpdateNotificationMessage(LATEST_RELEASE, { track: "pinned-tag" }),
		"The Last Harness update available. Run `tlh update --track latest-release` to get on version v9.9.9.",
	);
});

test("ref notifications explain that plain update stays on the saved ref", () => {
	assert.equal(
		buildTlhUpdateNotificationMessage(LATEST_RELEASE, { track: "ref", ref: "main" }),
		"The Last Harness update available. Run `tlh update` to update your `main` install, or `tlh update --track latest-release` to switch to version v9.9.9.",
	);
});

test("custom-track notifications no longer imply that plain update reaches the latest release", () => {
	assert.equal(
		buildTlhUpdateNotificationMessage(LATEST_RELEASE, { track: "custom" }),
		"The Last Harness update available. This install uses a custom update track, so plain `tlh update` is not enough to move to version v9.9.9. Re-run the appropriate installer command manually, or run `tlh update` with explicit update-target overrides such as `--track`, `--ref`, and `--package-source`.",
	);
});
