import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	ASYNC_DIR,
	CHAIN_RUNS_DIR,
	RESULTS_DIR,
	TEMP_ARTIFACTS_DIR,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveTempRootDir,
	resolveTempScopeId,
} from "../../src/shared/types.ts";

describe("resolveTempScopeId", () => {
	it("prefers uid when available", () => {
		const scope = resolveTempScopeId({
			getuid: () => 501,
			env: { USER: "alice" },
			userInfo: () => ({ username: "alice" }),
		});
		assert.equal(scope, "uid-501");
	});

	it("falls back to environment usernames when uid is unavailable", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: { USERNAME: "Alice Example" },
			userInfo: () => ({ username: "ignored" }),
		});
		assert.equal(scope, "user-Alice-Example");
	});

	it("falls back to os.userInfo when environment is missing", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => ({ username: "svc_account" }),
		});
		assert.equal(scope, "user-svc_account");
	});

	it("falls back to home path when os.userInfo throws", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => {
				throw new Error("uv_os_get_passwd returned ENOENT");
			},
			homedir: () => "/home/12345/app user",
		});
		assert.equal(scope, "home-home-12345-app-user");
	});
});

describe("resolveTempRootDir (PI_SUBAGENTS_TEMP_ROOT override)", () => {
	// Fork delta for GitHub issue #45: integration tests previously shared the
	// uid-scoped async runs dir with live sessions, causing ghost
	// notifications. PI_SUBAGENTS_TEMP_ROOT lets callers (e.g. integration
	// test setup) redirect the temp root away from that shared location.
	it("uses the override when PI_SUBAGENTS_TEMP_ROOT is set", () => {
		const root = resolveTempRootDir({
			env: { PI_SUBAGENTS_TEMP_ROOT: "/tmp/pi-subagents-test-override" },
			getuid: () => 501,
		});
		assert.equal(root, "/tmp/pi-subagents-test-override");
	});

	it("trims surrounding whitespace from the override value", () => {
		const root = resolveTempRootDir({
			env: { PI_SUBAGENTS_TEMP_ROOT: "  /tmp/pi-subagents-test-override  " },
			getuid: () => 501,
		});
		assert.equal(root, "/tmp/pi-subagents-test-override");
	});

	it("falls back to the uid-scoped root when the override is unset", () => {
		const root = resolveTempRootDir({
			env: {},
			getuid: () => 501,
		});
		assert.equal(path.basename(root), "pi-subagents-uid-501");
	});

	it("treats an empty or whitespace-only override as unset", () => {
		const emptyRoot = resolveTempRootDir({
			env: { PI_SUBAGENTS_TEMP_ROOT: "" },
			getuid: () => 501,
		});
		assert.equal(path.basename(emptyRoot), "pi-subagents-uid-501");

		const blankRoot = resolveTempRootDir({
			env: { PI_SUBAGENTS_TEMP_ROOT: "   " },
			getuid: () => 501,
		});
		assert.equal(path.basename(blankRoot), "pi-subagents-uid-501");
	});
});

describe("shared temp paths", () => {
	it("anchors shared temp directories under one scoped root", () => {
		assert.equal(path.dirname(RESULTS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(ASYNC_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(CHAIN_RUNS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(TEMP_ARTIFACTS_DIR), TEMP_ROOT_DIR);
		assert.match(path.basename(TEMP_ROOT_DIR), /^pi-subagents-/);
		assert.equal(path.basename(RESULTS_DIR), "async-subagent-results");
		assert.equal(path.basename(ASYNC_DIR), "async-subagent-runs");
		assert.equal(path.basename(CHAIN_RUNS_DIR), "chain-runs");
		assert.equal(path.basename(TEMP_ARTIFACTS_DIR), "artifacts");
	});

	it("writes async config files under the same scoped temp root", () => {
		assert.equal(path.dirname(getAsyncConfigPath("abc123")), TEMP_ROOT_DIR);
		assert.equal(path.basename(getAsyncConfigPath("abc123")), "async-cfg-abc123.json");
	});
});
