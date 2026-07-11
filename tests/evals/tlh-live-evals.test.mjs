import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { allScenarios, createContext, createScenarioScoreResult, writeWorkspaceOutputs } from "./tlh-live-evals.mjs";
import { createBinaryScoreCheck, createScenarioResult, createSuiteResult } from "./tlh-live-eval-results.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runnerPath = join(repoRoot, "tests", "evals", "tlh-live-evals.mjs");

function runLiveEval(args = [], env = {}) {
	return spawnSync(process.execPath, [runnerPath, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
}

function withEnv(values, callback) {
	const previous = new Map();
	for (const [name, value] of Object.entries(values)) {
		previous.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return callback();
	} finally {
		for (const [name, value] of previous.entries()) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("live eval runner is opt-in and skipped by default", () => {
	const result = runLiveEval();

	assert.equal(result.status, 0);
	assert.match(result.stdout, /opt-in/i);
	assert.match(result.stdout, /architect-e2e/);
	assert.match(result.stdout, /install-update-smoke/);
	assert.match(result.stdout, /Pass --run or set TLH_RUN_LIVE_EVALS=1/i);
	assert.equal(result.stderr, "");
});

test("live eval runner does not write results without explicit run opt-in", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-live-evals-test-"));
	const resultsPath = join(tempDir, "results.json");
	try {
		const result = runLiveEval(["--results-file", resultsPath]);

		assert.equal(result.status, 0);
		assert.equal(existsSync(resultsPath), false);
		assert.match(result.stdout, /skipped: live evals are opt-in/i);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("live eval runner lists the expected scenarios and bootstrap prerequisites", () => {
	const result = runLiveEval(["--list"]);

	assert.equal(result.status, 0);
	for (const scenarioId of [
		"architect-e2e",
		"rush-product-bug-hunter",
		"web-scout-network-research",
		"dirty-repo-guard",
		"install-update-smoke",
	]) {
		assert.match(result.stdout, new RegExp(scenarioId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	for (const expected of [
		/architect-e2e[\s\S]*prerequisites: interactive terminal; model auth; bash; node; npm; git; network access when install\/default-extension setup needs it/,
		/rush-product-bug-hunter[\s\S]*prerequisites: interactive terminal; model auth; bash; node; npm; git; network access when install\/default-extension setup needs it/,
		/web-scout-network-research[\s\S]*prerequisites: interactive terminal; model auth; bash; node; npm; git; network access \(required for research; install\/default-extension setup may also need it\); EXA_API_KEY or equivalent isolated config/,
		/dirty-repo-guard[\s\S]*prerequisites: interactive terminal; bash; node; npm; git; network access when install\/default-extension setup needs it/,
		/install-update-smoke[\s\S]*prerequisites: bash; node; npm; git; network access when install\/default-extension setup needs it/,
	]) {
		assert.match(result.stdout, expected);
	}
});

test("live eval runner rejects unknown scenario ids", () => {
	const result = runLiveEval(["--scenario", "nope"]);
	const combined = `${result.stdout}${result.stderr}`;

	assert.notEqual(result.status, 0);
	assert.match(combined, /Unknown scenario id: nope/);
});

test("manual live eval scenarios define meaningful null-scored rubric checks", () => {
	const scenario = allScenarios.find((entry) => entry.id === "architect-e2e");
	const ctx = {
		artifactsByScenario: new Map([["architect-e2e", new Set(["artifacts/architect-e2e/README.md"] )]]),
	};
	const result = createScenarioScoreResult(ctx, scenario, {
		status: "prepared",
		detail: "fixture repo ready",
	});

	assert.equal(result.score.type, "manual-rubric");
	assert.equal(result.checks.length, 3);
	assert.deepEqual(result.checks.map((check) => check.id), [
		"architect-orchestration-boundary",
		"ticketed-developer-flow",
		"fixture-repo-contained-change",
	]);
	for (const check of result.checks) {
		assert.equal(check.passed, null);
		assert.equal(check.status, null);
		assert.match(check.details, /Review artifacts\/architect-e2e\/README\.md/);
	}
	assert.doesNotMatch(JSON.stringify(result.checks), /manual-review-pending/);
});

test("manual live eval failures no longer masquerade as pending manual reviews", () => {
	const scenario = allScenarios.find((entry) => entry.id === "dirty-repo-guard");
	const result = createScenarioScoreResult({ artifactsByScenario: new Map() }, scenario, {
		status: "failed",
		detail: "bootstrap failed",
	});

	assert.equal(result.score.type, "automated-binary");
	assert.equal(result.checks.length, 1);
	assert.equal(result.checks[0].passed, false);
	assert.equal(result.checks[0].id, "runner-detected-failure");
});

function createPassingSuiteResult() {
	return createSuiteResult({
		selectedScenarios: [{ id: "install-update-smoke", mode: "automated" }],
		scenarioResults: [createScenarioResult({
			scenarioId: "install-update-smoke",
			mode: "automated",
			summary: "Smoke.",
			status: "passed",
			detail: "wrapper ready",
			checks: [createBinaryScoreCheck({
				id: "install-bootstrap",
				label: "Bootstrap isolated install created the tlh wrapper",
				passed: true,
				details: "ok",
			})],
		})],
		startedAt: "2026-05-29T00:00:00.000Z",
		finishedAt: "2026-05-29T00:00:05.000Z",
		keepWorkspace: true,
	});
}

test("workspace outputs write both README.md and results.json", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-live-eval-workspace-"));
	try {
		const suiteResult = createPassingSuiteResult();
		writeWorkspaceOutputs({
			rootDir: tempDir,
			homeDir: join(tempDir, "home"),
			agentDir: join(tempDir, "agent"),
			binDir: join(tempDir, "bin"),
			wrapperPath: join(tempDir, "bin", "tlh"),
			redactions: [],
			artifactsByScenario: new Map(),
			artifactPaths: new Set(),
		}, suiteResult);

		const summary = readFileSync(join(tempDir, "README.md"), "utf8");
		const results = JSON.parse(readFileSync(join(tempDir, "results.json"), "utf8"));
		assert.match(summary, /Structured results: results\.json/);
		assert.equal(results.summary.checks.automated.total, 1);
		assert.equal(results.scenarios[0].id, "install-update-smoke");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("workspace outputs do not globally redact short sensitive-name env flags but still redact longer secrets", () => {
	withEnv({
		CLAUDE_CODE_CHILD_SESSION: "1",
		TLH_TEST_SESSION_TOKEN: "sk-live-eval-secret-1234567890",
	}, () => {
		const ctx = createContext({});
		try {
			const suiteResult = createSuiteResult({
				selectedScenarios: [{ id: "install-update-smoke", mode: "automated" }],
				scenarioResults: [createScenarioResult({
					scenarioId: "install-update-smoke",
					mode: "automated",
					summary: "Smoke.",
					status: "passed",
					detail: "flag=1 secret=sk-live-eval-secret-1234567890",
					checks: [createBinaryScoreCheck({
						id: "install-bootstrap",
						label: "Bootstrap isolated install created the tlh wrapper",
						passed: true,
						details: "flag=1 secret=sk-live-eval-secret-1234567890",
					})],
				})],
				startedAt: "2026-05-29T00:00:00.000Z",
				finishedAt: "2026-05-29T00:00:05.000Z",
				keepWorkspace: true,
			});

			writeWorkspaceOutputs(ctx, suiteResult);

			const resultsPath = join(ctx.rootDir, "results.json");
			const rawResults = readFileSync(resultsPath, "utf8");
			const parsedResults = JSON.parse(rawResults);
			assert.equal(parsedResults.summary.checks.automated.total, 1);
			assert.match(rawResults, /"total": 1/);
			assert.match(rawResults, /flag=1/);
			assert.doesNotMatch(rawResults, /<CLAUDE_CODE_CHILD_SESSION>/);
			assert.doesNotMatch(rawResults, /sk-live-eval-secret-1234567890/);
			assert.match(rawResults, /<TLH_TEST_SESSION_TOKEN>/);
		} finally {
			rmSync(ctx.rootDir, { recursive: true, force: true });
		}
	});
});

test("artifacts-dir uses a fresh child workspace and preserves parent README/results files", () => {
	const artifactsParentDir = mkdtempSync(join(tmpdir(), "tlh-live-eval-parent-"));
	const parentReadmePath = join(artifactsParentDir, "README.md");
	const parentResultsPath = join(artifactsParentDir, "results.json");
	writeFileSync(parentReadmePath, "parent README\n", "utf8");
	writeFileSync(parentResultsPath, '{"parent":true}\n', "utf8");
	const ctx = createContext({ artifactsDir: artifactsParentDir });
	try {
		assert.notEqual(ctx.rootDir, artifactsParentDir);
		assert.equal(relative(artifactsParentDir, ctx.rootDir).startsWith(".."), false);
		assert.match(basename(ctx.rootDir), /^tlh-live-evals-/);

		writeWorkspaceOutputs(ctx, createPassingSuiteResult());

		assert.equal(readFileSync(parentReadmePath, "utf8"), "parent README\n");
		assert.equal(readFileSync(parentResultsPath, "utf8"), '{"parent":true}\n');
		assert.match(readFileSync(join(ctx.rootDir, "README.md"), "utf8"), /Structured results: results\.json/);
		assert.equal(JSON.parse(readFileSync(join(ctx.rootDir, "results.json"), "utf8")).scenarios[0].id, "install-update-smoke");
	} finally {
		rmSync(artifactsParentDir, { recursive: true, force: true });
	}
});

test("package scripts keep live evals out of package command surfaces", () => {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

	assert.equal(pkg.scripts.test, 'node --test --test-reporter=dot "tests/**/*.test.mjs"');
	assert.equal(pkg.scripts["test:verbose"], 'node --test "tests/**/*.test.mjs"');
	assert.equal(Object.hasOwn(pkg.scripts, "eval:live"), false);
	assert.doesNotMatch(pkg.scripts.validate, /eval:live|tlh-live-evals/i);
});

test("packaged local development docs exclude repo-only live eval tooling", () => {
	const docs = readFileSync(join(repoRoot, "docs", "local-development.md"), "utf8");

	assert.doesNotMatch(docs, /eval:live|tlh-live-evals|TLH_RUN_LIVE_EVALS|architect-e2e|install-update-smoke/i);
	assert.match(docs, /npm run validate/);
	assert.match(docs, /node scripts\/tlh-install\.mjs --dry-run/);
});


test("contributing docs link to the dedicated workflow eval guide and keep a concise quick reference", () => {
	const docs = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");

	assert.match(docs, /\[docs\/workflow-evals\.md\]\(docs\/workflow-evals\.md\)/);
	assert.match(docs, /Quick reference:/);
	assert.match(docs, /Default contributor\/CI path: `npm run validate`/);
	assert.match(docs, /Workflow-specific deterministic checks: `node --test tests\/hermetic-core-workflow\.test\.mjs tests\/evals\/trace-policy\/trace-policy-evals\.test\.mjs tests\/evals\/trace-policy\/trace-policy-incident-matrix\.test\.mjs tests\/agent-prompt-contracts\.test\.mjs tests\/evals\/tlh-live-evals\.test\.mjs tests\/evals\/tlh-live-eval-results\.test\.mjs`/);
	assert.match(docs, /The hermetic core-workflow integration test is deterministic and included in normal `npm test` \/ `npm run validate`\./);
	assert.match(docs, /Live evals are opt-in and not part of normal `npm run validate` or default CI\./);
	assert.doesNotMatch(docs, /issue #241/);
	assert.doesNotMatch(docs, /Scenario \| Mode \| Prerequisites \| What it checks|What it prepares or verifies/);
});

test("workflow eval guide owns the detailed contributor-facing eval docs", () => {
	const docs = readFileSync(join(repoRoot, "docs", "workflow-evals.md"), "utf8");

	assert.match(docs, /issue #241/i);
	assert.match(docs, /Deterministic workflow evals \| Yes, through targeted `node --test` commands and the normal `npm test` \/ `npm run validate` path/i);
	assert.match(docs, /node --test tests\/hermetic-core-workflow\.test\.mjs tests\/evals\/trace-policy\/trace-policy-evals\.test\.mjs tests\/evals\/trace-policy\/trace-policy-incident-matrix\.test\.mjs tests\/agent-prompt-contracts\.test\.mjs tests\/evals\/tlh-live-evals\.test\.mjs tests\/evals\/tlh-live-eval-results\.test\.mjs/);
	assert.match(docs, /`tests\/hermetic-core-workflow\.test\.mjs` is the highest-level automated workflow integration check/i);
	assert.match(docs, /It runs as part of the normal `npm test` and `npm run validate` path/i);
	assert.match(docs, /without model credentials, network access, or manual review/i);
	assert.match(docs, /fake provider only; no real model\/provider credentials/i);
	assert.match(docs, /isolated temp HOME, agent profile, wrapper\/bin, and workspace paths/i);
	assert.match(docs, /The hermetic core-workflow integration test is deterministic and part of normal `npm test` \/ `npm run validate`; live evals remain opt-in and release-tier\/manual, not part of normal `npm run validate` or default CI\./i);
	assert.match(docs, /--results-file \/path\/to\/results\.json/);
	assert.match(docs, /fresh `tlh-live-evals-\*` child workspace under `DIR`/i);
	assert.match(docs, /scenario status values such as `passed`, `prepared`, or `failed`/i);
	assert.match(docs, /No primary-agent auto-switching gate/i);
	assert.match(docs, /No LLM-as-judge gate/i);
	assert.match(docs, /Incident-to-fixture loop/i);
	assert.match(docs, /repo-local contributor tooling only; it does not change packaged TLH runtime behavior/i);
	assert.match(docs, /node tests\/evals\/trace-policy\/trace-policy-fixture-importer\.mjs/i);
	assert.match(docs, /normalize volatile IDs, timestamps, temp roots, home-directory paths, and generated request\/session IDs/i);
	assert.match(docs, /stop and clean that up before the fixture enters review/i);
	assert.match(docs, /trace-policy-fixture-importer\.test\.mjs tests\/evals\/trace-policy\/trace-policy-evals\.test\.mjs tests\/evals\/trace-policy\/trace-policy-incident-matrix\.test\.mjs/i);
	assert.match(docs, /`npm run validate` remains the full-repo check documented in \[`VALIDATING\.md`\]\(\.\.\/VALIDATING\.md\)/i);
	assert.match(docs, /Expect it to normalize volatile IDs, timestamps, temp roots, home-directory paths, and generated request\/session IDs/i);
	assert.match(docs, /use the importer-backed incident-to-fixture loop above instead of checking in raw exports/i);
	assert.doesNotMatch(docs, /Until that normalization path exists/i);
	assert.match(docs, /Do not commit `results\.json`, temp workspaces, or per-run score snapshots\./i);
	assert.doesNotMatch(docs, /tests\/trace-policy-evals\.test\.mjs/);
	assert.doesNotMatch(docs, /TLH_SKIP_GNOSIS|internal installer test escape/i);
});

test("release docs keep published-asset install checks separate from default validation", () => {
	const docs = readFileSync(join(repoRoot, "docs", "releasing.md"), "utf8");

	assert.match(docs, /release-tier manual checks/i);
	assert.match(docs, /separate from `npm run validate`/i);
	assert.doesNotMatch(docs, /eval:live|tlh-live-evals/i);
	assert.match(docs, /--dry-run/);
});
