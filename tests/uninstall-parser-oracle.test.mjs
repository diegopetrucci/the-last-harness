/**
 * Oracle test: validates uninstall.sh's bash JSON parsers against JSON.parse.
 *
 * Two parsers under test:
 *  1. Runtime ownership-marker parser (sed-based): reads
 *     <profile-root>/runtime/.tlh-runtime-owned — fields schemaVersion,
 *     packageName, runtimeAbsPath, origin.  Decides:
 *       origin=created  → "would remove private runtime: rm -rf"
 *       origin=migrated → "would remove migrated TLH pi from shared runtime (npm)"
 *       invalid/missing → "would skip pi/runtime removal"
 *
 *  2. Install-state parser (grep-based): reads
 *     <agent-dir>/tlh/install-state.json — field piInstalledByTlh.
 *     Returns "true" | "false" | "absent".
 *
 * For each matrix entry we:
 *   (a) Write fixtures into a fresh temp dir.
 *   (b) Run `bash uninstall.sh --dry-run --agent-dir … --bin-dir …`
 *       with a scrubbed HOME (no ~/.local/bin/pi) and minimal PATH.
 *   (c) Assert the emitted plan matches the JSON.parse-based oracle prediction.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const RUNTIME_MARKER_FILENAME = ".tlh-runtime-owned";

// ── Oracle ─────────────────────────────────────────────────────────────────────

/**
 * JSON.parse-based oracle for the runtime ownership marker.
 *
 * Returns one of three plan-class strings that must appear in the dry-run
 * output:
 *   "runtime"          → would remove private runtime: rm -rf
 *   "runtime-package"  → would remove migrated TLH pi from shared runtime (npm)
 *   "skip"             → would skip pi/runtime removal
 *
 * @param {string|null} markerContent  Raw file content, or null if file absent.
 * @param {string}      realRuntimeDir Resolved (physical) absolute path to the
 *                                     runtime dir — used to verify runtimeAbsPath.
 * @param {boolean}     hasPiLayout    Whether bin/pi and lib/node_modules/<pkg>
 *                                     are present inside the runtime dir.
 */
function oracleRuntimePlanClass(markerContent, realRuntimeDir, hasPiLayout) {
	if (markerContent === null) return "skip";
	let obj;
	try {
		obj = JSON.parse(markerContent);
	} catch {
		return "skip";
	}
	if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return "skip";
	if (obj.schemaVersion !== 1) return "skip";
	if (obj.packageName !== PI_PACKAGE_NAME) return "skip";
	if (obj.origin !== "created" && obj.origin !== "migrated") return "skip";
	if (!obj.runtimeAbsPath) return "skip";
	if (obj.runtimeAbsPath !== realRuntimeDir) return "skip";
	if (!hasPiLayout) return "skip";
	return obj.origin === "created" ? "runtime" : "runtime-package";
}

/**
 * JSON.parse-based oracle for the install-state piInstalledByTlh field.
 *
 * Returns "true" | "false" | "absent".
 * CRLF is stripped (mirrors uninstall.sh's `tr -d '\\r'`).
 *
 * @param {string|null} stateContent  Raw file content, or null if file absent.
 */
function oracleInstallState(stateContent) {
	if (stateContent === null) return "absent";
	// Strip CRLF exactly as the bash parser does.
	const stripped = stateContent.replace(/\r/g, "");
	let obj;
	try {
		obj = JSON.parse(stripped);
	} catch {
		return "absent";
	}
	if (typeof obj !== "object" || obj === null) return "absent";
	if (obj.piInstalledByTlh === true) return "true";
	if (obj.piInstalledByTlh === false) return "false";
	return "absent";
}

// ── Fixture builders ───────────────────────────────────────────────────────────

/**
 * Build a minimal TLH fixture in a fresh temp dir.
 *
 * Layout:
 *   <root>/home/               — scrubbed HOME (no .local/bin/pi)
 *   <root>/profile/agent/      — agent dir (--agent-dir)
 *   <root>/profile/agent/tlh/install-state.json  — install-state (if provided)
 *   <root>/profile/runtime/    — runtime dir (if withRuntime)
 *   <root>/profile/runtime/.tlh-runtime-owned    — marker (if markerContent given)
 *   <root>/profile/runtime/bin/pi                — pi binary (if hasPiLayout)
 *   <root>/profile/runtime/lib/node_modules/<pkg>/  — pkg dir (if hasPiLayout)
 *   <root>/bin/                — empty bin dir (--bin-dir)
 *
 * Returns { root, agentDir, binDir, homeDir, runtimeDir, realRuntimeDir }.
 */
function buildFixture({
	installStateContent = JSON.stringify({ piInstalledByTlh: true }),
	markerContent = undefined, // undefined → skip writing marker; null → no marker file
	withRuntime = false,
	hasPiLayout = true,
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "tlh-uninstall-oracle-"));

	const homeDir = join(root, "home");
	const profileDir = join(root, "profile");
	const agentDir = join(profileDir, "agent");
	const runtimeDir = join(profileDir, "runtime");
	const binDir = join(root, "bin");

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(binDir, { recursive: true });

	// Always write install-state so uninstall.sh doesn't die on missing marker.
	writeFileSync(join(agentDir, "tlh", "install-state.json"), installStateContent, "utf8");

	if (withRuntime) {
		mkdirSync(runtimeDir, { recursive: true });
		if (hasPiLayout) {
			mkdirSync(join(runtimeDir, "bin"), { recursive: true });
			writeFileSync(join(runtimeDir, "bin", "pi"), "#!/usr/bin/env bash\necho pi\n", "utf8");
			mkdirSync(join(runtimeDir, "lib", "node_modules", PI_PACKAGE_NAME), { recursive: true });
		}
		if (markerContent !== null && markerContent !== undefined) {
			writeFileSync(join(runtimeDir, RUNTIME_MARKER_FILENAME), markerContent, "utf8");
		}
		// markerContent === null → no marker file (absent)
	}

	// Resolve physical path (handles /tmp → /private/tmp on macOS).
	const realRuntimeDir = withRuntime ? realpathSync(runtimeDir) : null;

	return { root, agentDir, binDir, homeDir, runtimeDir, realRuntimeDir };
}

/** Clean up a fixture. */
function cleanFixture(root) {
	rmSync(root, { recursive: true, force: true });
}

// ── Runner ─────────────────────────────────────────────────────────────────────

/**
 * Run `bash uninstall.sh --dry-run` against a fixture.
 * Scrubs HOME (no ~/.local/bin/pi), strips TLH_* vars, uses minimal PATH.
 */
function runDryRun(agentDir, binDir, homeDir) {
	const minimalPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
	const env = { HOME: homeDir, PATH: minimalPath };

	return spawnSync("bash", ["uninstall.sh", "--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir], {
		cwd: repoRoot,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

// ── Plan-class matchers ────────────────────────────────────────────────────────

const PLAN_STRINGS = {
	runtime: "would remove private runtime: rm -rf",
	"runtime-package": "would remove migrated TLH pi from shared runtime (npm)",
	skip: "would skip pi/runtime removal",
};

function assertPlanClass(stdout, expectedClass, label) {
	const expected = PLAN_STRINGS[expectedClass];
	// Assert the expected plan-class string IS present.
	assert.ok(
		stdout.includes(expected),
		`[${label}] expected plan class "${expectedClass}" (string: "${expected}")\nActual stdout:\n${stdout}`,
	);
	// Assert MUTUAL EXCLUSIVITY: none of the other plan-class strings may appear.
	for (const [cls, str] of Object.entries(PLAN_STRINGS)) {
		if (cls === expectedClass) continue;
		assert.ok(
			!stdout.includes(str),
			`[${label}] unexpected plan class "${cls}" (string: "${str}") found alongside expected "${expectedClass}"\nActual stdout:\n${stdout}`,
		);
	}
}

// ── Matrix helpers ─────────────────────────────────────────────────────────────

/**
 * Build a valid compact marker JSON string.
 *
 * @param {string} realRuntimeDir  Physical absolute path to runtime dir.
 * @param {object} overrides       Fields to override in the default valid marker.
 */
function validMarker(realRuntimeDir, overrides = {}) {
	return JSON.stringify({
		schemaVersion: 1,
		packageName: PI_PACKAGE_NAME,
		runtimeAbsPath: realRuntimeDir,
		origin: "created",
		...overrides,
	});
}

// ── Tests: runtime marker parser ───────────────────────────────────────────────

test("uninstall-oracle: origin=created → runtime removal", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
		markerContent: undefined, // we write it after we have realRuntimeDir
	});
	// Re-write marker now that we have realRuntimeDir.
	const markerContent = validMarker(realRuntimeDir, { origin: "created" });
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "runtime", "oracle sanity check");
	assertPlanClass(result.stdout, "runtime", "origin=created");
});

test("uninstall-oracle: origin=migrated → runtime-package removal", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const markerContent = validMarker(realRuntimeDir, { origin: "migrated" });
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "runtime-package", "oracle sanity check");
	assertPlanClass(result.stdout, "runtime-package", "origin=migrated");
});

test("uninstall-oracle: missing marker file → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
		markerContent: null, // null → do not write the marker file
	});
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(null, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "missing marker");
});

test("uninstall-oracle: empty marker file → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const markerContent = "";
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "empty marker");
});

test("uninstall-oracle: marker is plain text (not JSON) → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const markerContent = "not json at all";
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "non-JSON marker");
});

test("uninstall-oracle: truncated JSON marker → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const markerContent = `{"schemaVersion":1,"packageName":"${PI_PACKAGE_NAME}"`;
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "truncated marker");
});

test("uninstall-oracle: wrong schemaVersion (2) → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const markerContent = validMarker(realRuntimeDir, { schemaVersion: 2 });
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "wrong schemaVersion");
});

test("uninstall-oracle: schemaVersion as string '1' → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	// Manually serialize so schemaVersion is a quoted string.
	const markerContent = `{"schemaVersion":"1","packageName":"${PI_PACKAGE_NAME}","runtimeAbsPath":"${realRuntimeDir}","origin":"created"}`;
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "schemaVersion as string");
});

test("uninstall-oracle: wrong packageName → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const markerContent = validMarker(realRuntimeDir, { packageName: "@other/package" });
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "wrong packageName");
});

test("uninstall-oracle: unrecognised origin 'other' → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const markerContent = validMarker(realRuntimeDir, { origin: "other" });
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "unknown origin");
});

test("uninstall-oracle: origin null → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	// JSON.stringify({origin:null}) → "null" value, not a string
	const markerContent = `{"schemaVersion":1,"packageName":"${PI_PACKAGE_NAME}","runtimeAbsPath":"${realRuntimeDir}","origin":null}`;
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "origin=null");
});

test("uninstall-oracle: runtimeAbsPath mismatch → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const wrongPath = "/some/other/runtime/path";
	const markerContent = validMarker(realRuntimeDir, { runtimeAbsPath: wrongPath });
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "path mismatch");
});

test("uninstall-oracle: empty runtimeAbsPath → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const markerContent = validMarker(realRuntimeDir, { runtimeAbsPath: "" });
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "empty runtimeAbsPath");
});

test("uninstall-oracle: valid marker but missing pi layout → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: false, // no bin/pi, no node_modules
	});
	const markerContent = validMarker(realRuntimeDir, { origin: "created" });
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, false);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "missing pi layout");
});

test("uninstall-oracle: CRLF in compact marker (single-line) → parsed correctly by bash sed", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	// Compact JSON with CRLF at end of line — sed [[:space:]] covers \r, .* covers rest.
	const markerJson = validMarker(realRuntimeDir, { origin: "created" });
	const markerContent = markerJson + "\r\n";
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	// Oracle strips CRLF before JSON.parse to mirror what sed effectively handles.
	const normalized = markerContent.replace(/\r/g, "");
	const expected = oracleRuntimePlanClass(normalized, realRuntimeDir, true);
	assert.equal(expected, "runtime", "oracle sanity check: CRLF should not prevent valid parse");
	assertPlanClass(result.stdout, "runtime", "CRLF in marker");
});

test("uninstall-oracle: missing all fields → skip", (t) => {
	const { root, agentDir, binDir, homeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	const markerContent = "{}";
	writeFileSync(join(root, "profile", "runtime", RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const expected = oracleRuntimePlanClass(markerContent, realRuntimeDir, true);
	assert.equal(expected, "skip", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "empty object marker");
});

// ── Tests: install-state parser ────────────────────────────────────────────────

test("uninstall-oracle: install-state piInstalledByTlh=true (no runtime) → oracle=true, skip due to no runtime/legacy", (t) => {
	const installStateContent = JSON.stringify({ piInstalledByTlh: true });
	const { root, agentDir, binDir, homeDir } = buildFixture({
		installStateContent,
		withRuntime: false,
	});
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	// Oracle for install-state field.
	const oracleValue = oracleInstallState(installStateContent);
	assert.equal(oracleValue, "true", "oracle sanity check");

	// With no runtime and no legacy ~/.local/bin/pi, uninstall always skips.
	assertPlanClass(result.stdout, "skip", "piInstalledByTlh=true no runtime");
});

test("uninstall-oracle: install-state piInstalledByTlh=false → oracle=false, skip", (t) => {
	const installStateContent = JSON.stringify({ piInstalledByTlh: false });
	const { root, agentDir, binDir, homeDir } = buildFixture({
		installStateContent,
		withRuntime: false,
	});
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const oracleValue = oracleInstallState(installStateContent);
	assert.equal(oracleValue, "false", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "piInstalledByTlh=false");
	assert.ok(
		result.stdout.includes("piInstalledByTlh=false"),
		`expected skip reason 'piInstalledByTlh=false'\nstdout:\n${result.stdout}`,
	);
});

test("uninstall-oracle: install-state piInstalledByTlh absent (no field) → oracle=absent, skip", (t) => {
	const installStateContent = JSON.stringify({ someOtherField: true });
	const { root, agentDir, binDir, homeDir } = buildFixture({
		installStateContent,
		withRuntime: false,
	});
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const oracleValue = oracleInstallState(installStateContent);
	assert.equal(oracleValue, "absent", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "piInstalledByTlh absent");
	assert.ok(result.stdout.includes("absent"), `expected skip reason to mention 'absent'\nstdout:\n${result.stdout}`);
});

test("uninstall-oracle: malformed install-state JSON → oracle=absent, skip", (t) => {
	const installStateContent = "{ malformed json ";
	const { root, agentDir, binDir, homeDir } = buildFixture({
		installStateContent,
		withRuntime: false,
	});
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const oracleValue = oracleInstallState(installStateContent);
	assert.equal(oracleValue, "absent", "oracle sanity check");
	assertPlanClass(result.stdout, "skip", "malformed install-state");
});

test("uninstall-oracle: install-state with CRLF line endings, piInstalledByTlh=false → oracle=false, skip", (t) => {
	// bash parser uses `tr -d '\\r'` before grep; oracle also strips CRLF.
	const installStateContent = '{\r\n  "piInstalledByTlh": false\r\n}\r\n';
	const { root, agentDir, binDir, homeDir } = buildFixture({
		installStateContent,
		withRuntime: false,
	});
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const oracleValue = oracleInstallState(installStateContent);
	assert.equal(oracleValue, "false", "oracle sanity check: CRLF should not prevent valid parse");
	assertPlanClass(result.stdout, "skip", "CRLF install-state false");
	assert.ok(
		result.stdout.includes("piInstalledByTlh=false"),
		`expected skip reason 'piInstalledByTlh=false'\nstdout:\n${result.stdout}`,
	);
});

test("uninstall-oracle: install-state with CRLF line endings, piInstalledByTlh=true (no runtime) → oracle=true, skip no runtime", (t) => {
	const installStateContent = '{\r\n  "piInstalledByTlh": true\r\n}\r\n';
	const { root, agentDir, binDir, homeDir } = buildFixture({
		installStateContent,
		withRuntime: false,
	});
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const oracleValue = oracleInstallState(installStateContent);
	assert.equal(oracleValue, "true", "oracle sanity check: CRLF stripped");
	// No runtime and no legacy ~/.local/bin/pi → skip
	assertPlanClass(result.stdout, "skip", "CRLF install-state true no runtime");
});

test("uninstall-oracle: install-state missing (file absent) → oracle=absent, skip", (t) => {
	// Build fixture but then manually delete install-state.json — note this
	// also means agent dir won't have the TLH ownership marker, so uninstall.sh
	// will refuse to operate on it.  Use withRuntime=false and verify exit code
	// is non-zero (die), or just skip agent dir creation entirely.
	// Easier: just verify oracle when file is absent.
	// Drive a scenario where agent dir doesn't exist either → "Nothing to remove."
	const root = mkdtempSync(join(tmpdir(), "tlh-uninstall-oracle-absent-"));
	const homeDir = join(root, "home");
	const profileDir = join(root, "profile");
	const agentDir = join(profileDir, "agent"); // does NOT exist
	const binDir = join(root, "bin");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	// Do NOT create agentDir — install-state.json is absent.
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	const oracleValue = oracleInstallState(null);
	assert.equal(oracleValue, "absent", "oracle sanity check");
	// When nothing exists, uninstall says "Nothing to remove."
	assert.ok(result.stdout.includes("Nothing to remove"), `expected "Nothing to remove"\nstdout:\n${result.stdout}`);
});

// ── Grammar-only-malformed marker: intentional lenient behavior ────────────────
//
// The bash sed-based parser extracts field VALUES only; it does not validate JSON
// grammar.  A marker whose JSON is syntactically invalid (e.g. a trailing comma
// after the last field) but whose ownership field VALUES are all correct
// (schemaVersion=1, packageName=matching, runtimeAbsPath=matching, origin=created)
// is treated as TLH-owned, and removal IS planned.
//
// The JS oracle (oracleRuntimePlanClass) uses JSON.parse, which rejects such
// grammar-only-malformed inputs and would predict "skip".  That prediction is
// WRONG for this class of inputs; oracle and bash diverge ONLY here.  We therefore
// do NOT call oracleRuntimePlanClass for this test — the JSON.parse oracle is
// explicitly excluded from grammar-only-malformed inputs.  Instead we document and
// directly assert the known correct bash behavior.
test("uninstall-oracle: grammar-only-malformed marker (trailing comma after origin=created, all ownership fields valid) → runtime removal [intentional lenient value-extraction]", (t) => {
	const { root, agentDir, binDir, homeDir, runtimeDir, realRuntimeDir } = buildFixture({
		withRuntime: true,
		hasPiLayout: true,
	});
	// Trailing comma after the last field makes this invalid JSON (JSON.parse throws).
	// The bash sed-based parser extracts field VALUES only and sees:
	//   schemaVersion=1, packageName=@earendil-works/pi-coding-agent,
	//   runtimeAbsPath=<matching>, origin=created
	// All ownership field values are valid → bash PLANS REMOVAL.
	const markerContent = `{"schemaVersion":1,"packageName":"${PI_PACKAGE_NAME}","runtimeAbsPath":"${realRuntimeDir}","origin":"created",}`;
	writeFileSync(join(runtimeDir, RUNTIME_MARKER_FILENAME), markerContent, "utf8");
	t.after(() => cleanFixture(root));

	const result = runDryRun(agentDir, binDir, homeDir);
	assert.equal(result.status, 0, `uninstall.sh failed:\n${result.stderr}`);

	// Confirm JSON.parse rejects this input (oracle would incorrectly predict "skip").
	assert.throws(() => JSON.parse(markerContent), "sanity: markerContent is not valid JSON");

	// Assert the ACTUAL bash behavior: grammar-only-malformed but all ownership fields
	// valid → intentional lenient removal.
	assertPlanClass(result.stdout, "runtime", "grammar-only-malformed trailing comma");
});
