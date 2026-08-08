import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
	__resetTlhUpdateCheckForTests,
	__setTlhUpdateCheckTestHooks,
	buildTlhUpdateNotificationMessage,
	getTlhHeaderUpdate,
	maybeNotifyAvailableTlhUpdate,
	persistTlhLastSeenVersion,
} = await jiti.import("../extensions/the-last-harness/update-check.ts");
const { TLH_UPDATE_CHECK_INTERVAL_MS } = await jiti.import("../extensions/the-last-harness/constants.ts");
const { getTlhVersion, normalizeTlhVersion } = await jiti.import("../extensions/the-last-harness/package-version.ts");

const LATEST_RELEASE = {
	version: "9.9.9",
	tagName: "v9.9.9",
	releaseUrl: "https://github.com/diegopetrucci/the-last-harness/releases/tag/v9.9.9",
};

function writeSettings(agentDir, updateCheck = {}) {
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ tlh: { updateCheck } }, null, 2)}\n`);
}

function writeStartupState(agentDir, state) {
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	writeFileSync(join(agentDir, "tlh", "startup-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function readStartupState(agentDir) {
	return JSON.parse(readFileSync(join(agentDir, "tlh", "startup-state.json"), "utf8"));
}

function createCtx(cwd, notifications) {
	return {
		cwd,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
	};
}

function installUpdateCheckHooks(t, hooks = {}) {
	__resetTlhUpdateCheckForTests();
	__setTlhUpdateCheckTestHooks(hooks);
	t.after(() => {
		__resetTlhUpdateCheckForTests();
	});
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

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

test("update checks honor every documented skip control without fetching or notifying", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	writeStartupState(fixture.agent, {});

	for (const skipCase of [
		{ name: "outside isolated profile", env: { HOME: fixture.home, PI_CODING_AGENT_DIR: undefined } },
		{ name: "PI_OFFLINE", env: { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, PI_OFFLINE: "1" } },
		{
			name: "PI_SKIP_VERSION_CHECK",
			env: { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, PI_SKIP_VERSION_CHECK: "1" },
		},
		{
			name: "TLH_SKIP_UPDATE_CHECK",
			env: { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TLH_SKIP_UPDATE_CHECK: "1" },
		},
		{
			name: "settings opt-out",
			env: { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
			settings: { enabled: false },
		},
	]) {
		const notifications = [];
		let fetchCalls = 0;
		writeSettings(fixture.agent, skipCase.settings ?? {});
		installUpdateCheckHooks(t, {
			fetchLatestRelease: async () => {
				fetchCalls += 1;
				return LATEST_RELEASE;
			},
		});

		await withEnv(skipCase.env, async () => {
			await maybeNotifyAvailableTlhUpdate(createCtx(fixture.cwd, notifications));
		});

		assert.equal(fetchCalls, 0, `${skipCase.name} must skip the TLH update fetch`);
		assert.deepEqual(notifications, [], `${skipCase.name} must not notify`);
		if (skipCase.name === "outside isolated profile") {
			assert.equal(
				existsSync(join(fixture.home, ".pi", "agent", "tlh", "startup-state.json")),
				false,
				"normal Pi config must not gain TLH startup state",
			);
		}
	}
});

test("malformed updateCheck containers are normalized before writes and stay fail-soft", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	writeStartupState(fixture.agent, { updateCheck: "corrupt-cache" });

	const notifications = [];
	let fetchCalls = 0;
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	installUpdateCheckHooks(t, {
		now: () => now,
		fetchLatestRelease: async () => {
			fetchCalls += 1;
			return undefined;
		},
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		await maybeNotifyAvailableTlhUpdate(createCtx(fixture.cwd, notifications));
	});

	assert.equal(fetchCalls, 1);
	assert.deepEqual(notifications, []);
	assert.deepEqual(readStartupState(fixture.agent), {
		updateCheck: {
			checkedAt: new Date(now).toISOString(),
		},
	});
});

test("syntactically invalid startup state recovers to valid normalized state", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	mkdirSync(join(fixture.agent, "tlh"), { recursive: true });
	writeFileSync(join(fixture.agent, "tlh", "startup-state.json"), "{ invalid json\n");

	const notifications = [];
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	installUpdateCheckHooks(t, {
		now: () => now,
		fetchLatestRelease: async () => undefined,
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		await maybeNotifyAvailableTlhUpdate(createCtx(fixture.cwd, notifications));
	});

	assert.deepEqual(notifications, []);
	assert.deepEqual(readStartupState(fixture.agent), {
		updateCheck: {
			checkedAt: new Date(now).toISOString(),
		},
	});
});

test("malformed cached release fields never notify, throw, or fetch while the cache is fresh", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	const freshCheckedAt = new Date(now - 1).toISOString();

	for (const [field, value] of [
		["latestTagName", { malformed: true }],
		["latestTagName", "garbage"],
		["latestTagName", "v8.0.0"],
		["latestReleaseUrl", 42],
		["latestVersion", "v"],
		["latestVersion", "arbitrary text"],
	]) {
		writeStartupState(fixture.agent, {
			updateCheck: {
				checkedAt: freshCheckedAt,
				latestVersion: LATEST_RELEASE.version,
				latestTagName: LATEST_RELEASE.tagName,
				latestReleaseUrl: LATEST_RELEASE.releaseUrl,
				[field]: value,
			},
		});
		const notifications = [];
		let fetchCalls = 0;
		installUpdateCheckHooks(t, {
			now: () => now,
			fetchLatestRelease: async () => {
				fetchCalls += 1;
				return LATEST_RELEASE;
			},
		});

		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			await maybeNotifyAvailableTlhUpdate(createCtx(fixture.cwd, notifications));
		});

		assert.equal(fetchCalls, 0, `${field} corruption must retain cache freshness`);
		assert.deepEqual(notifications, [], `${field} corruption must not notify`);
	}
});

test("malformed release responses never notify and never persist a release", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	for (const responseCase of [
		{ name: "non-ok response", response: { ok: false, json: async () => ({ tag_name: "v9.9.9" }) } },
		{ name: "missing tag_name", response: { ok: true, json: async () => ({ html_url: LATEST_RELEASE.releaseUrl }) } },
		{ name: "blank tag_name", response: { ok: true, json: async () => ({ tag_name: "   " }) } },
		{ name: "prefix-only tag_name", response: { ok: true, json: async () => ({ tag_name: "v" }) } },
		{ name: "arbitrary tag_name", response: { ok: true, json: async () => ({ tag_name: "not-a-version" }) } },
		{ name: "null JSON result", response: { ok: true, json: async () => null } },
		{
			name: "json rejection",
			response: {
				ok: true,
				json: async () => {
					throw new Error("boom");
				},
			},
		},
	]) {
		writeStartupState(fixture.agent, {});
		const notifications = [];
		installUpdateCheckHooks(t, { now: () => now });
		globalThis.fetch = async () => responseCase.response;

		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			await maybeNotifyAvailableTlhUpdate(createCtx(fixture.cwd, notifications));
		});

		assert.deepEqual(notifications, [], `${responseCase.name} must stay quiet`);
		const updateCheck = readStartupState(fixture.agent).updateCheck;
		assert.equal(
			typeof updateCheck?.checkedAt,
			"string",
			`${responseCase.name} must still record the attempt timestamp`,
		);
		assert.equal(updateCheck?.latestVersion, undefined, `${responseCase.name} must not persist a release`);
	}
});

test("valid older, equal, and latest release responses retain persistence and notification behavior", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	const currentVersion = getTlhVersion();
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	for (const releaseCase of [
		{ name: "older", tagName: "v0.1.0", notifications: 0 },
		{ name: "equal", tagName: `v${currentVersion}`, notifications: 0 },
		{ name: "latest", tagName: LATEST_RELEASE.tagName, notifications: 1 },
	]) {
		writeStartupState(fixture.agent, {});
		const notifications = [];
		installUpdateCheckHooks(t, { now: () => now });
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({
				tag_name: releaseCase.tagName,
				html_url: `${LATEST_RELEASE.releaseUrl}-${releaseCase.name}`,
			}),
		});

		await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
			await maybeNotifyAvailableTlhUpdate(createCtx(fixture.cwd, notifications));
		});

		assert.equal(readStartupState(fixture.agent).updateCheck?.latestVersion, normalizeTlhVersion(releaseCase.tagName));
		assert.equal(notifications.length, releaseCase.notifications);
	}
});

test("startup header keeps the previous-version notice until deferred lastSeen persistence runs", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	writeStartupState(fixture.agent, {
		lastSeenVersion: "0.1.0",
		updateCheck: {
			checkedAt: "2026-07-17T12:00:00.000Z",
			latestVersion: LATEST_RELEASE.version,
			lastNotifiedVersion: "8.8.8",
		},
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		assert.deepEqual(getTlhHeaderUpdate(), {
			version: getTlhVersion(),
			releasesUrl: "https://github.com/diegopetrucci/the-last-harness/releases",
		});
		assert.deepEqual(readStartupState(fixture.agent), {
			lastSeenVersion: "0.1.0",
			updateCheck: {
				checkedAt: "2026-07-17T12:00:00.000Z",
				latestVersion: LATEST_RELEASE.version,
				lastNotifiedVersion: "8.8.8",
			},
		});
		persistTlhLastSeenVersion();
	});

	assert.deepEqual(readStartupState(fixture.agent), {
		lastSeenVersion: getTlhVersion(),
		updateCheck: {
			checkedAt: "2026-07-17T12:00:00.000Z",
			latestVersion: LATEST_RELEASE.version,
			lastNotifiedVersion: "8.8.8",
		},
	});
});

test("future checkedAt timestamps are treated as stale clock skew and force a refresh", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	writeStartupState(fixture.agent, {
		updateCheck: {
			checkedAt: "2026-07-18T12:00:00.000Z",
		},
	});

	const notifications = [];
	let fetchCalls = 0;
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	installUpdateCheckHooks(t, {
		now: () => now,
		fetchLatestRelease: async () => {
			fetchCalls += 1;
			return LATEST_RELEASE;
		},
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		await maybeNotifyAvailableTlhUpdate(createCtx(fixture.cwd, notifications));
	});

	assert.equal(fetchCalls, 1, "future-dated state must not suppress refreshes forever");
	assert.equal(notifications.length, 1);
	assert.equal(readStartupState(fixture.agent).updateCheck?.latestVersion, LATEST_RELEASE.version);
});

test("cache expiry boundary fetches exactly once", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	writeStartupState(fixture.agent, {
		updateCheck: {
			checkedAt: new Date(now - TLH_UPDATE_CHECK_INTERVAL_MS).toISOString(),
		},
	});

	const notifications = [];
	let fetchCalls = 0;
	installUpdateCheckHooks(t, {
		now: () => now,
		fetchLatestRelease: async () => {
			fetchCalls += 1;
			return undefined;
		},
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		await maybeNotifyAvailableTlhUpdate(createCtx(fixture.cwd, notifications));
	});

	assert.equal(fetchCalls, 1, "cache age equal to the interval must refresh");
	assert.deepEqual(notifications, []);
});

test("fresh cached release data is reused without a network fetch", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	writeStartupState(fixture.agent, {
		updateCheck: {
			checkedAt: new Date(now - TLH_UPDATE_CHECK_INTERVAL_MS + 1).toISOString(),
			latestVersion: LATEST_RELEASE.version,
			latestTagName: LATEST_RELEASE.tagName,
			latestReleaseUrl: LATEST_RELEASE.releaseUrl,
		},
	});

	const notifications = [];
	let fetchCalls = 0;
	installUpdateCheckHooks(t, {
		now: () => now,
		fetchLatestRelease: async () => {
			fetchCalls += 1;
			return LATEST_RELEASE;
		},
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		await maybeNotifyAvailableTlhUpdate(createCtx(fixture.cwd, notifications));
	});

	assert.equal(fetchCalls, 0);
	assert.deepEqual(notifications, [
		{
			message: "The Last Harness update available. Run `tlh update` to get on version v9.9.9.",
			type: "warning",
		},
	]);
	assert.equal(readStartupState(fixture.agent).updateCheck?.lastNotifiedVersion, LATEST_RELEASE.version);
});

test("in-process dedupe suppresses repeat notifications for the same version even if persisted state regresses", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	const freshCheckedAt = new Date(now - TLH_UPDATE_CHECK_INTERVAL_MS + 1).toISOString();
	writeStartupState(fixture.agent, {
		updateCheck: {
			checkedAt: freshCheckedAt,
			latestVersion: LATEST_RELEASE.version,
			latestTagName: LATEST_RELEASE.tagName,
			latestReleaseUrl: LATEST_RELEASE.releaseUrl,
		},
	});

	const notifications = [];
	installUpdateCheckHooks(t, { now: () => now, fetchLatestRelease: async () => LATEST_RELEASE });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const ctx = createCtx(fixture.cwd, notifications);
		await maybeNotifyAvailableTlhUpdate(ctx);
		writeStartupState(fixture.agent, {
			updateCheck: {
				checkedAt: freshCheckedAt,
				latestVersion: LATEST_RELEASE.version,
				latestTagName: LATEST_RELEASE.tagName,
				latestReleaseUrl: LATEST_RELEASE.releaseUrl,
			},
		});
		await maybeNotifyAvailableTlhUpdate(ctx);
	});

	assert.equal(notifications.length, 1);
});

test("stale callers skip notification while a replacement caller reuses the shared in-flight fetch", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	writeStartupState(fixture.agent, {});

	const staleNotifications = [];
	const currentNotifications = [];
	let fetchCalls = 0;
	const deferred = createDeferred();
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	installUpdateCheckHooks(t, {
		now: () => now,
		fetchLatestRelease: async () => {
			fetchCalls += 1;
			return deferred.promise;
		},
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const staleCtx = createCtx(fixture.cwd, staleNotifications);
		const currentCtx = createCtx(fixture.cwd, currentNotifications);
		const staleCheck = maybeNotifyAvailableTlhUpdate(staleCtx, { canNotify: () => false });
		const currentCheck = maybeNotifyAvailableTlhUpdate(currentCtx, { canNotify: () => true });
		assert.equal(fetchCalls, 1, "replacement callers must reuse the in-flight fetch");
		deferred.resolve(LATEST_RELEASE);
		await Promise.all([staleCheck, currentCheck]);
	});

	assert.deepEqual(staleNotifications, []);
	assert.equal(currentNotifications.length, 1);
	assert.equal(fetchCalls, 1);
	assert.equal(readStartupState(fixture.agent).updateCheck?.lastNotifiedVersion, LATEST_RELEASE.version);
});

test("concurrent update checks share one fetch and one notification", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-update-check-test-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	writeStartupState(fixture.agent, {});

	const notifications = [];
	let fetchCalls = 0;
	const deferred = createDeferred();
	const now = Date.parse("2026-07-17T12:00:00.000Z");
	installUpdateCheckHooks(t, {
		now: () => now,
		fetchLatestRelease: async () => {
			fetchCalls += 1;
			return deferred.promise;
		},
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const ctx = createCtx(fixture.cwd, notifications);
		const first = maybeNotifyAvailableTlhUpdate(ctx);
		const second = maybeNotifyAvailableTlhUpdate(ctx);
		assert.equal(fetchCalls, 1, "concurrent callers must reuse one in-flight fetch");
		deferred.resolve(LATEST_RELEASE);
		await Promise.all([first, second]);
	});

	assert.equal(fetchCalls, 1);
	assert.equal(notifications.length, 1);
	assert.equal(readStartupState(fixture.agent).updateCheck?.lastNotifiedVersion, LATEST_RELEASE.version);
});
