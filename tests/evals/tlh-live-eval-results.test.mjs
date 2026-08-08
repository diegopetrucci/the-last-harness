import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	createBinaryScoreCheck,
	createManualRubricCheck,
	createScenarioResult,
	createSuiteResult,
	writeResultsFile,
} from "./tlh-live-eval-results.mjs";

test("live eval results schema aggregates detailed automated checks and manual rubrics", () => {
	const automatedScenario = createScenarioResult({
		scenarioId: "install-update-smoke",
		mode: "automated",
		summary: "Run isolated install/update smoke.",
		status: "passed",
		detail: "wrapper created",
		artifacts: [
			"artifacts/install-bootstrap/install.log",
			"artifacts/install-update-smoke/defaults-list.log",
			"artifacts/install-update-smoke/update.log",
			"artifacts/install-update-smoke/install-state.json",
		],
		checks: [
			createBinaryScoreCheck({
				id: "install-bootstrap",
				label: "Bootstrap isolated install created the tlh wrapper",
				passed: true,
				details: "bootstrap wrapper verified",
				artifacts: ["artifacts/install-bootstrap/install.log"],
			}),
			createBinaryScoreCheck({
				id: "defaults-list",
				label: "Installed wrapper lists bundled default extensions",
				passed: true,
				details: "defaults list exited 0",
				artifacts: ["artifacts/install-update-smoke/defaults-list.log"],
			}),
			createBinaryScoreCheck({
				id: "update",
				label: "Installed wrapper updates against the current checkout",
				passed: true,
				details: "update exited 0",
				artifacts: ["artifacts/install-update-smoke/update.log"],
			}),
			createBinaryScoreCheck({
				id: "install-state",
				label: "Install state reflects the custom update source",
				passed: true,
				details: "install-state recorded expected metadata",
				artifacts: ["artifacts/install-update-smoke/install-state.json"],
			}),
		],
	});
	const manualScenario = createScenarioResult({
		scenarioId: "architect-e2e",
		mode: "manual",
		summary: "Prepare a ticketed fixture repo.",
		status: "prepared",
		detail: "fixture repo ready",
		artifacts: ["artifacts/architect-e2e/README.md"],
		checks: [
			createManualRubricCheck({
				id: "architect-orchestration-boundary",
				label: "Architect stays in orchestration mode",
				details: "Primary session should not edit the fixture directly.",
				artifacts: ["artifacts/architect-e2e/README.md"],
			}),
			createManualRubricCheck({
				id: "ticketed-developer-flow",
				label: "Approved ticket and developer implementation flow occurs",
				details: "Verify the run uses the normal ticket/developer workflow.",
				artifacts: ["artifacts/architect-e2e/README.md"],
			}),
			createManualRubricCheck({
				id: "fixture-repo-contained-change",
				label: "All edits and validation stay inside the fixture repo",
				details: "Check that any changes remain inside the temp fixture repo.",
				artifacts: ["artifacts/architect-e2e/README.md"],
			}),
		],
	});

	const suite = createSuiteResult({
		selectedScenarios: [
			{ id: "architect-e2e", mode: "manual" },
			{ id: "install-update-smoke", mode: "automated" },
		],
		scenarioResults: [manualScenario, automatedScenario],
		startedAt: "2026-05-29T00:00:00.000Z",
		finishedAt: "2026-05-29T00:00:05.000Z",
		keepWorkspace: true,
		requestedResultsFile: true,
		sharedArtifacts: ["artifacts/install-bootstrap/install.log"],
	});

	assert.deepEqual(JSON.parse(JSON.stringify(suite)), suite);
	assert.equal(suite.schemaVersion, 1);
	assert.equal(suite.status, "completed");
	assert.deepEqual(suite.metadata.requestedScenarioIds, ["architect-e2e", "install-update-smoke"]);
	assert.deepEqual(suite.metadata.selectedModeCounts, { automated: 1, manual: 1 });
	assert.equal(suite.metadata.resultsFileRequested, true);
	assert.equal(suite.metadata.workspaceKept, true);
	assert.deepEqual(suite.summary.scenarios, {
		total: 2,
		passed: 1,
		prepared: 1,
		failed: 0,
		other: 0,
	});
	assert.deepEqual(suite.summary.checks.automated, { passed: 4, total: 4 });
	assert.deepEqual(suite.summary.checks.manual, { pending: 3, total: 3 });
	assert.equal(suite.scenarios[0].score.type, "manual-rubric");
	assert.deepEqual(
		suite.scenarios[0].checks.map((check) => check.status),
		[null, null, null],
	);
	assert.equal(suite.scenarios[1].score.type, "automated-binary");
	assert.deepEqual(
		suite.scenarios[1].checks.map((check) => check.id),
		["install-bootstrap", "defaults-list", "update", "install-state"],
	);
	assert.deepEqual(suite.artifacts.shared, ["artifacts/install-bootstrap/install.log"]);
});

test("writeResultsFile writes redacted external results and rejects workspace paths", () => {
	const tmpRoot = mkdtempSync(join(tmpdir(), "tlh-live-eval-results-"));
	try {
		const results = {
			schemaVersion: 1,
			detail: `${tmpRoot}/workspace/private`,
		};
		const outputPath = join(tmpRoot, "external", "results.json");
		const writtenPath = writeResultsFile({
			results,
			filePath: outputPath,
			rootDir: join(tmpRoot, "workspace"),
			transformText: (text) => text.replaceAll(tmpRoot, "<REDACTED_ROOT>"),
		});

		assert.equal(writtenPath, outputPath);
		assert.equal(existsSync(outputPath), true);
		assert.match(readFileSync(outputPath, "utf8"), /<REDACTED_ROOT>\/workspace\/private/);
		assert.throws(
			() =>
				writeResultsFile({
					results,
					filePath: join(tmpRoot, "workspace", "results.json"),
					rootDir: join(tmpRoot, "workspace"),
				}),
			/--results-file must be outside the live eval workspace/,
		);
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});
