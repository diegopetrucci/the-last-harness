import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { TLH_NAME, TLH_TELEMETRY_EVENT_TYPE, TLH_TELEMETRY_STATE_SCHEMA_VERSION } = await jiti.import("../extensions/the-last-harness/constants.ts");
const { CI_FAILURE_INVESTIGATION_FEATURE, DELTA_FOLLOW_UP_REVIEWS_FEATURE, TLH_CONTRARIAN_FEATURE } = await jiti.import(
	"../extensions/the-last-harness/experimental.ts",
);
const { sendTlhLaunchTelemetry } = await jiti.import("../extensions/the-last-harness/launch-telemetry.ts");

const EXISTING_INSTALL_ID = "11111111-1111-4111-8111-111111111111";

function telemetryStatePath(fixture) {
	return join(fixture.agent, "tlh", "telemetry-state.json");
}

function writeTelemetryState(fixture, installId = EXISTING_INSTALL_ID) {
	mkdirSync(join(fixture.agent, "tlh"), { recursive: true });
	const stateContent = `${JSON.stringify({ schemaVersion: TLH_TELEMETRY_STATE_SCHEMA_VERSION, installId }, null, 2)}\n`;
	writeFileSync(telemetryStatePath(fixture), stateContent);
	return stateContent;
}

test("launch telemetry sends allowlisted experimental feature states and reuses the existing install ID", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
	const originalState = writeTelemetryState(fixture);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify(
			{ tlh: { experimental: { enabledFeatures: [" Contrarian ", "legacy-flag"] } } },
			null,
			2,
		)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace/",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3", modelId: "gpt-4o" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	assert.equal(request.url, "https://telemetry.example.test/namespace/test-namespace/");
	assert.equal(request.options?.method, "POST");
	assert.equal(request.options?.headers?.["User-Agent"], `${TLH_NAME}/1.2.3`);

	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.appID, "test-app-id");
	assert.equal(event.type, TLH_TELEMETRY_EVENT_TYPE);
	assert.equal(event.clientUser, createHash("sha256").update(EXISTING_INSTALL_ID).digest("hex"));
	assert.equal(event.payload["Tlh.App.version"], "1.2.3");
	assert.equal(event.payload["Tlh.Runtime.model"], "gpt-4o");
	assert.equal(event.payload[`Tlh.Experimental.${TLH_CONTRARIAN_FEATURE}`], "on");
	assert.equal(event.payload[`Tlh.Experimental.${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`], "off");
	assert.equal(event.payload[`Tlh.Experimental.${CI_FAILURE_INVESTIGATION_FEATURE}`], "off");
	assert.equal(Object.hasOwn(event.payload, "Tlh.Experimental.legacy-flag"), false);
	assert.equal(readFileSync(telemetryStatePath(fixture), "utf8"), originalState);
});

test("launch telemetry skips when the isolated profile has telemetry opt-out enabled", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
	writeTelemetryState(fixture);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { telemetry: { enabled: false }, experimental: { enabledFeatures: [TLH_CONTRARIAN_FEATURE] } } }, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3", modelId: "gpt-4o" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.equal(fetchCalls, 0);
});

test("launch telemetry skips when telemetry settings are malformed", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
	writeTelemetryState(fixture);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { telemetry: { enabled: "nope" }, experimental: { enabledFeatures: [TLH_CONTRARIAN_FEATURE] } } }, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3", modelId: "gpt-4o" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.equal(fetchCalls, 0);
});
