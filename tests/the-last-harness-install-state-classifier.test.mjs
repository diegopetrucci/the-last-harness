import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { classifyTlhInstallState, formatTlhInstallNoticeMessage } = await jiti.import("../extensions/the-last-harness/install-state.ts");

const OFFICIAL_LATEST_STABLE = {
	repo: "diegopetrucci/the-last-harness",
	track: "latest-release",
	ref: "v0.10.0",
	packageSource: "git:github.com/diegopetrucci/the-last-harness@v0.10.0",
	packageSourceIsDefault: true,
};

test("classifier returns no notice for official latest-stable installs", () => {
	assert.equal(classifyTlhInstallState(OFFICIAL_LATEST_STABLE), undefined);
});

test("classifier flags pinned-tag installs", () => {
	assert.deepEqual(classifyTlhInstallState({
		...OFFICIAL_LATEST_STABLE,
		track: "pinned-tag",
	}), {
		kind: "pinned-tag",
		summary: "TLH is pinned to a specific release tag.",
		detail: "v0.10.0",
	});
});

test("classifier flags ref installs", () => {
	assert.deepEqual(classifyTlhInstallState({
		...OFFICIAL_LATEST_STABLE,
		track: "ref",
		ref: "main",
		packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
	}), {
		kind: "ref",
		summary: "TLH follows a non-stable git ref.",
		detail: "main",
	});
});

test("classifier flags custom tracks", () => {
	assert.deepEqual(classifyTlhInstallState({
		...OFFICIAL_LATEST_STABLE,
		track: "custom",
	}), {
		kind: "custom-track",
		summary: "TLH uses a custom update track.",
		detail: "custom",
	});
});

test("classifier flags custom package sources even on latest-release", () => {
	const notice = classifyTlhInstallState({
		...OFFICIAL_LATEST_STABLE,
		packageSource: "git:github.com/custom/pkg@main",
		packageSourceIsDefault: false,
	});
	assert.deepEqual(notice, {
		kind: "custom-package-source",
		summary: "TLH uses a custom package source.",
		detail: "git:github.com/custom/pkg@main",
	});
	assert.ok(notice);
	const message = formatTlhInstallNoticeMessage(notice);
	assert.match(message, /rerun the official latest-release installer/i);
	assert.doesNotMatch(message, /tlh update --track latest-release/);
});

test("classifier flags non-default repositories", () => {
	const notice = classifyTlhInstallState({
		...OFFICIAL_LATEST_STABLE,
		repo: "someone-else/the-last-harness",
	});
	assert.deepEqual(notice, {
		kind: "non-default-repo",
		summary: "TLH is installed from a non-default repository.",
		detail: "someone-else/the-last-harness",
	});
	assert.ok(notice);
	const message = formatTlhInstallNoticeMessage(notice);
	assert.match(message, /rerun the official latest-release installer/i);
	assert.doesNotMatch(message, /tlh update --track latest-release/);
});

test("classifier flags missing install-state as unknown", () => {
	const notice = classifyTlhInstallState(undefined);
	assert.deepEqual(notice, {
		kind: "unknown",
		summary: "TLH install metadata is missing or invalid.",
	});
	assert.ok(notice);
	const message = formatTlhInstallNoticeMessage(notice);
	assert.match(message, /rerun the official latest-release installer/i);
	assert.doesNotMatch(message, /tlh update --track latest-release/);
});

test("classifier flags invalid install-state as unknown", () => {
	assert.deepEqual(classifyTlhInstallState({
		...OFFICIAL_LATEST_STABLE,
		track: "latest-release",
		packageSourceIsDefault: undefined,
	}), {
		kind: "unknown",
		summary: "TLH install metadata is missing or invalid.",
	});
});
