import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { allScenarios, createContext, createScenarioScoreResult, writeWorkspaceOutputs } from "./evals/tlh-live-evals.mjs";
import { createBinaryScoreCheck, createScenarioResult, createSuiteResult } from "./evals/tlh-live-eval-results.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const runnerPath = join(repoRoot, "tests", "evals", "tlh-live-evals.mjs");

function runLiveEval(args = [], env = {}) {
	return spawnSync(process.execPath, [runnerPath, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
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

	assert.equal(Object.hasOwn(pkg.scripts, "eval:live"), false);
	assert.doesNotMatch(pkg.scripts.validate, /eval:live|tlh-live-evals/i);
});

test("packaged local development docs exclude repo-only live eval tooling", () => {
	const docs = readFileSync(join(repoRoot, "docs", "local-development.md"), "utf8");

	assert.doesNotMatch(docs, /eval:live|tlh-live-evals|TLH_RUN_LIVE_EVALS|architect-e2e|install-update-smoke/i);
	assert.match(docs, /npm run validate/);
	assert.match(docs, /node scripts\/tlh-install\.mjs --dry-run/);
});

test("contributing docs describe repo-only eval tiers, boundaries, and score artifacts", () => {
	const docs = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");

	assert.match(docs, /These workflows are contributor tooling for this repository only/i);
	assert.match(docs, /issue #241/i);
	assert.match(docs, /deterministic incident regressions plus contract checks/i);
	assert.match(docs, /node --test tests\/trace-policy-evals\.test\.mjs tests\/trace-policy-incident-matrix\.test\.mjs tests\/agent-prompt-contracts\.test\.mjs tests\/tlh-live-evals\.test\.mjs tests\/tlh-live-eval-results\.test\.mjs/);
	assert.match(docs, /node tests\/evals\/tlh-live-evals\.mjs --list/);
	assert.match(docs, /--results-file \/path\/to\/results\.json/);
	assert.match(docs, /fresh `tlh-live-evals-\*` child workspace under that parent/i);
	assert.match(docs, /tests\/tlh-live-eval-results\.test\.mjs/);
	assert.match(docs, /binary pass\/fail/i);
	assert.match(docs, /top-level `results\.json`/i);
	assert.match(docs, /scenario status \(`passed`, `prepared`, or `failed`\)/i);
	assert.match(docs, /run the same scenario more than once/i);
	assert.match(docs, /Live evals remain opt-in and release-tier\/manual/i);
	assert.match(docs, /No primary-agent auto-switching gate/i);
	assert.match(docs, /No LLM-as-judge gate/i);
	assert.match(docs, /exported TLH or upstream Pi session JSONL files/i);
	assert.match(docs, /normalize volatile fields such as timestamps, IDs, temp roots, and environment-specific command paths/i);
	assert.match(docs, /without introducing model judging/i);
	assert.match(docs, /Never commit `results\.json`, temp workspaces, or per-run score snapshots/i);
	assert.match(docs, /`architect-e2e` \| Manual scaffold \| `interactive terminal`; `model auth`; `bash`; `node`; `npm`; `git`; `network access when install\/default-extension setup needs it`/);
	assert.match(docs, /`install-update-smoke` \| Automated \| `bash`; `node`; `npm`; `git`; `network access when install\/default-extension setup needs it`/);
});

test("release docs keep published-asset install checks separate from default validation", () => {
	const docs = readFileSync(join(repoRoot, "docs", "releasing.md"), "utf8");

	assert.match(docs, /release-tier manual checks/i);
	assert.match(docs, /separate from `npm run validate`/i);
	assert.doesNotMatch(docs, /eval:live|tlh-live-evals/i);
	assert.match(docs, /--dry-run/);
});
