import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export const liveEvalResultSchemaVersion = 1;
export const acceptanceEvidenceResultSchemaVersion = 1;

const evidenceStatuses = new Set(["passed", "failed", "pending", "blocked"]);

function uniqueStrings(values) {
  return [
    ...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)),
  ].sort();
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
    ...(check.category ? { category: check.category } : {}),
  };
}

function summarizeEvidenceChecks(checks) {
  const summarize = (category) => {
    const selected = checks.filter((check) => check.category === category);
    return {
      passed: selected.filter((check) => check.status === "passed").length,
      failed: selected.filter((check) => check.status === "failed").length,
      pending: selected.filter((check) => check.status === "pending").length,
      blocked: selected.filter((check) => check.status === "blocked").length,
      total: selected.length,
    };
  };
  return {
    deterministic: summarize("deterministic"),
    manual: summarize("manual"),
  };
}

function evidenceScenarioStatus(checks, fallback = "pending") {
  const statuses = checks.map((check) => check.status);
  if (statuses.length === 0) return fallback;
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("pending")) return "pending";
  return "passed";
}

function evidenceSuiteStatus(scenarioResults) {
  const statuses = scenarioResults.map((result) => result.status);
  if (statuses.length === 0) return "pending";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("prepared")) return "prepared";
  return "passed";
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

/**
 * Create a check from offline evidence without treating an absent value as a
 * failure or a model/assistant assertion as proof. This is additive to the
 * original live-eval check shape; ordinary live-eval callers continue to use
 * `createBinaryScoreCheck` and `createManualRubricCheck` unchanged.
 */
export function createEvidenceScoreCheck({
  id,
  label,
  status = "pending",
  details = "",
  artifacts = [],
  category = "deterministic",
}) {
  if (!evidenceStatuses.has(status))
    throw new Error(`unsupported evidence check status: ${status}`);
  if (category !== "deterministic" && category !== "manual") {
    throw new Error(`unsupported evidence check category: ${category}`);
  }
  return normalizeCheck({
    id,
    label,
    kind: category === "manual" ? "manual" : "automated",
    scoreType: category === "manual" ? "human-attestation" : "deterministic-evidence",
    status,
    passed: status === "passed" ? true : status === "failed" ? false : null,
    details,
    artifacts,
    category,
  });
}

export function createAcceptanceEvidenceScenarioResult({
  scenarioId,
  mode = "manual",
  summary,
  detail = "",
  checks = [],
  artifacts = [],
  status,
  identity = {},
}) {
  const normalizedChecks = checks.map((check) => normalizeCheck(check));
  const evidence = summarizeEvidenceChecks(normalizedChecks);
  const scenarioStatus = status || evidenceScenarioStatus(normalizedChecks);
  const base = createScenarioResult({
    scenarioId,
    mode,
    summary,
    status: scenarioStatus,
    detail,
    checks: normalizedChecks,
    artifacts,
  });
  return {
    ...base,
    status: scenarioStatus,
    identity: {
      suiteId: String(identity.suiteId || ""),
      scenarioId: String(identity.scenarioId || scenarioId),
      candidateCommit: String(identity.candidateCommit || ""),
    },
    score: {
      ...base.score,
      deterministic: evidence.deterministic,
      evidence: {
        deterministic: evidence.deterministic,
        manual: evidence.manual,
      },
      manual: {
        pending: evidence.manual.pending,
        total: evidence.manual.total,
      },
    },
  };
}

export function createAcceptanceEvidenceSuiteResult({
  selectedScenarios = [],
  scenarioResults = [],
  suiteId,
  suiteVersion,
  candidate = {},
  evidenceReferences = [],
  startedAt = "offline-evaluation",
  finishedAt = startedAt,
  sourceResultsFile = "results.json",
  limitations = [],
}) {
  const deterministic = { passed: 0, failed: 0, pending: 0, blocked: 0, total: 0 };
  const manual = { passed: 0, failed: 0, pending: 0, blocked: 0, total: 0 };
  const scenarios = {
    total: scenarioResults.length,
    passed: 0,
    prepared: 0,
    pending: 0,
    blocked: 0,
    failed: 0,
    other: 0,
  };
  for (const scenario of scenarioResults) {
    if (Object.hasOwn(scenarios, scenario.status)) scenarios[scenario.status] += 1;
    else scenarios.other += 1;
    for (const check of scenario.checks || []) {
      const target = check.category === "manual" ? manual : deterministic;
      target.total += 1;
      if (Object.hasOwn(target, check.status)) target[check.status] += 1;
    }
  }
  const status = evidenceSuiteStatus(scenarioResults);
  const sortedReferences = uniqueStrings(evidenceReferences);
  const identity = {
    suiteId: String(suiteId || ""),
    suiteVersion: Number.isInteger(suiteVersion) ? suiteVersion : null,
    candidate: {
      mode: String(candidate.mode || ""),
      ref: String(candidate.ref || candidate.candidateRef || ""),
      commit: String(candidate.commit || candidate.candidateCommit || ""),
      packageName: String(candidate.packageName || ""),
      packageVersion: String(candidate.packageVersion || ""),
      packageSha256: String(candidate.packageSha256 || ""),
    },
  };
  return {
    schemaVersion: acceptanceEvidenceResultSchemaVersion,
    reportType: "acceptance-evidence",
    generatedAt: String(finishedAt),
    status,
    metadata: {
      runner: "tlh-acceptance-evidence",
      startedAt: String(startedAt),
      finishedAt: String(finishedAt),
      suiteId: identity.suiteId,
      suiteVersion: identity.suiteVersion,
      candidate: identity.candidate,
      requestedScenarioIds: selectedScenarios.map((scenario) => String(scenario.id)),
      sourceResultsFile: String(sourceResultsFile),
      evidenceReferences: sortedReferences,
      limitations: uniqueStrings(limitations),
    },
    identity,
    summary: {
      scenarios,
      checks: {
        deterministic,
        manual,
        // Keep the original aggregate names available to consumers that only
        // understand the v1 live-eval report. The richer evidence counts above
        // remain the source of truth for pending/blocked/failed outcomes.
        automated: { passed: deterministic.passed, total: deterministic.total },
      },
    },
    artifacts: { shared: sortedReferences },
    scenarios: scenarioResults,
  };
}

export function createScenarioResult({
  scenarioId,
  mode,
  summary,
  status,
  detail = "",
  checks = [],
  artifacts = [],
}) {
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
    artifacts: uniqueStrings([
      ...artifacts,
      ...normalizedChecks.flatMap((check) => check.artifacts),
    ]),
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

export function writeResultsFile({
  results,
  filePath,
  rootDir = "",
  transformText = (text) => text,
}) {
  if (!filePath) return "";
  const resolvedPath = resolve(filePath);
  if (isWithinRoot(resolvedPath, rootDir)) {
    throw new Error(`--results-file must be outside the live eval workspace: ${resolvedPath}`);
  }
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, transformText(`${JSON.stringify(results, null, 2)}\n`), "utf8");
  return resolvedPath;
}
