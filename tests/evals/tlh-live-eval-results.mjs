import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export const liveEvalResultSchemaVersion = 1;

function uniqueStrings(values) {
	return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function summarizeChecks(checks) {
	const automatedChecks = checks.filter((check) => check.kind === "automated");
	const manualChecks = checks.filter((check) => check.kind === "manual");
	return {
		automated: {
			passed: automatedChecks.filter((check) => check.passed === true).length,
			total: automatedChecks.length,
		},
		manual: {
			pending: manualChecks.length,
			total: manualChecks.length,
		},
	};
}

function detectScoreType(checks) {
	const hasAutomated = checks.some((check) => check.kind === "automated");
	const hasManual = checks.some((check) => check.kind === "manual");
	if (hasAutomated && hasManual) return "mixed";
	if (hasManual) return "manual-rubric";
	return "automated-binary";
}

function normalizeCheck(check) {
	return {
		id: String(check.id),
		label: String(check.label),
		kind: check.kind,
		scoreType: check.scoreType,
		status: check.status,
		passed: check.passed,
		details: String(check.details || ""),
		artifacts: uniqueStrings(check.artifacts),
	};
}

export function createBinaryScoreCheck({ id, label, passed, details = "", artifacts = [] }) {
	const isPassed = Boolean(passed);
	return normalizeCheck({
		id,
		label,
		kind: "automated",
		scoreType: "binary",
		status: isPassed ? "passed" : "failed",
		passed: isPassed,
		details,
		artifacts,
	});
}

export function createManualRubricCheck({ id, label, details = "", artifacts = [] }) {
	return normalizeCheck({
		id,
		label,
		kind: "manual",
		scoreType: "rubric",
		status: null,
		passed: null,
		details,
		artifacts,
	});
}

export function createScenarioResult({ scenarioId, mode, summary, status, detail = "", checks = [], artifacts = [] }) {
	const normalizedChecks = checks.map((check) => normalizeCheck(check));
	const counts = summarizeChecks(normalizedChecks);
	return {
		id: String(scenarioId),
		mode: String(mode),
		status: String(status),
		summary: String(summary),
		detail: String(detail || ""),
		score: {
			type: detectScoreType(normalizedChecks),
			automated: counts.automated,
			manual: counts.manual,
		},
		checks: normalizedChecks,
		artifacts: uniqueStrings([...artifacts, ...normalizedChecks.flatMap((check) => check.artifacts)]),
	};
}

export function createSuiteResult({
	selectedScenarios = [],
	scenarioResults = [],
	startedAt,
	finishedAt,
	keepWorkspace = false,
	failed = false,
	requestedResultsFile = false,
	sharedArtifacts = [],
}) {
	const summary = {
		scenarios: {
			total: scenarioResults.length,
			passed: 0,
			prepared: 0,
			failed: 0,
			other: 0,
		},
		checks: {
			automated: { passed: 0, total: 0 },
			manual: { pending: 0, total: 0 },
		},
	};

	for (const result of scenarioResults) {
		if (result.status === "passed") summary.scenarios.passed += 1;
		else if (result.status === "prepared") summary.scenarios.prepared += 1;
		else if (result.status === "failed") summary.scenarios.failed += 1;
		else summary.scenarios.other += 1;
		summary.checks.automated.passed += result.score.automated.passed;
		summary.checks.automated.total += result.score.automated.total;
		summary.checks.manual.pending += result.score.manual.pending;
		summary.checks.manual.total += result.score.manual.total;
	}

	return {
		schemaVersion: liveEvalResultSchemaVersion,
		generatedAt: String(finishedAt),
		status: failed ? "failed" : "completed",
		metadata: {
			runner: "tlh-live-evals",
			startedAt: String(startedAt),
			finishedAt: String(finishedAt),
			requestedScenarioIds: selectedScenarios.map((scenario) => scenario.id),
			selectedModeCounts: {
				automated: selectedScenarios.filter((scenario) => scenario.mode === "automated").length,
				manual: selectedScenarios.filter((scenario) => scenario.mode === "manual").length,
			},
			artifactRoot: "artifacts/",
			resultsFileRequested: Boolean(requestedResultsFile),
			workspaceKept: Boolean(keepWorkspace),
		},
		summary,
		artifacts: {
			shared: uniqueStrings(sharedArtifacts),
		},
		scenarios: scenarioResults,
	};
}

function isWithinRoot(targetPath, rootPath) {
	if (!rootPath) return false;
	const target = resolve(targetPath);
	const root = resolve(rootPath);
	return target === root || target.startsWith(`${root}${sep}`);
}

export function writeResultsFile({ results, filePath, rootDir = "", transformText = (text) => text }) {
	if (!filePath) return "";
	const resolvedPath = resolve(filePath);
	if (isWithinRoot(resolvedPath, rootDir)) {
		throw new Error(`--results-file must be outside the live eval workspace: ${resolvedPath}`);
	}
	mkdirSync(dirname(resolvedPath), { recursive: true });
	writeFileSync(resolvedPath, transformText(`${JSON.stringify(results, null, 2)}\n`), "utf8");
	return resolvedPath;
}
