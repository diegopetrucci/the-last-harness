import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildRevivedAsyncTask, resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";

function writeJson(filePath: string, value: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

const pausedCheckedAcceptance = {
	level: "checked",
	explicit: true,
	inferredReason: ["async write-capable or risky run"],
	criteria: [
		{
			id: "criterion-1",
			must: "Implement the requested change without widening scope",
			evidence: ["changed-files"],
			severity: "required",
		},
	],
	evidence: ["changed-files", "commands-run", "no-staged-files"],
	verify: [{ id: "tests", command: "npm test" }],
	stopRules: ["Do not widen scope"],
} as const;

const pausedNoneAcceptance = {
	level: "none",
	explicit: false,
	inferredReason: [],
	criteria: [],
	evidence: [],
	verify: [],
	stopRules: [],
} as const;

function skippedPausedAcceptanceLedger(effectiveAcceptance = pausedCheckedAcceptance) {
	return {
		status: "skipped",
		effectiveAcceptance,
		inferredReason: effectiveAcceptance.inferredReason,
		criteria: effectiveAcceptance.criteria,
		runtimeChecks: [
			{
				id: "paused",
				status: "not-applicable",
				message:
					"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
			},
		],
		verifyRuns: [],
	};
}

function notRequiredPausedAcceptanceLedger(effectiveAcceptance = pausedNoneAcceptance) {
	return {
		status: "not-required",
		effectiveAcceptance,
		inferredReason: effectiveAcceptance.inferredReason,
		criteria: effectiveAcceptance.criteria,
		runtimeChecks: [
			{
				id: "acceptance-disabled",
				status: "not-applicable",
				message: "Acceptance level none does not require evaluation.",
			},
		],
		verifyRuns: [],
	};
}

describe("async resume lookup", () => {
	it("resolves a completed single-child run from persisted status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-abc", "status.json"), {
				runId: "run-abc",
				mode: "single",
				state: "complete",
				startedAt: 100,
				endedAt: 200,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-a" },
				{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
			);

			assert.equal(target.kind, "revive");
			assert.equal(target.runId, "run-abc");
			assert.equal(target.agent, "worker");
			assert.equal(target.sessionFile, sessionFile);
			assert.equal(target.cwd, root);
			assert.equal(target.intercomTarget, "subagent-worker-run-abc-1");
			assert.equal(target.continuationAcceptance, undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("selects the requested parallel child ticket instead of the aggregate run ticket", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-step-ticket-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionA = path.join(root, "a.jsonl");
			const sessionB = path.join(root, "b.jsonl");
			fs.writeFileSync(sessionA, "", "utf-8");
			fs.writeFileSync(sessionB, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-parallel-tickets", "status.json"), {
				runId: "run-parallel-tickets",
				mode: "parallel",
				state: "complete",
				startedAt: 100,
				endedAt: 200,
				lastUpdate: 200,
				cwd: root,
				tkTicket: { id: "psr-aggregate", title: "Aggregate ticket" },
				steps: [
					{
						agent: "developer-a",
						status: "complete",
						sessionFile: sessionA,
						tkTicket: { id: "psr-a", title: "A ticket" },
					},
					{
						agent: "developer-b",
						status: "complete",
						sessionFile: sessionB,
						tkTicket: { id: "psr-b", title: "B ticket" },
					},
				],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-parallel-tickets", index: 1 },
				{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
			);
			assert.deepEqual(target.tkTicket, { id: "psr-b", title: "B ticket" });
			assert.equal(target.agent, "developer-b");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves cumulative active runtime without counting paused wall time", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-active-runtime-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "paused.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-paused", "status.json"), {
				runId: "run-paused",
				mode: "single",
				state: "paused",
				startedAt: 100,
				endedAt: 200,
				lastUpdate: 10_000_000,
				cwd: root,
				sessionFile,
				pause: { kind: "awaiting_supervisor", pausedAt: 200 },
				steps: [
					{
						agent: "worker",
						status: "paused",
						sessionFile,
						activeRuntimeMs: 75,
						pause: { kind: "awaiting_supervisor", pausedAt: 200 },
						acceptance: skippedPausedAcceptanceLedger(),
					},
				],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-paused" },
				{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), now: () => 20_000_000 },
			);

			assert.equal(target.activeRuntimeMs, 75);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects continued awaiting-supervisor sources after continuation finalization", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-continued-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "continued.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-continued", "status.json"), {
				runId: "run-continued",
				mode: "single",
				state: "continued",
				startedAt: 100,
				endedAt: 200,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				pause: { kind: "awaiting_supervisor", summary: "Need a decision", pausedAt: 150 },
				lifecycle: {
					continuation: {
						claimToken: "claim-run-continued",
						claimedAt: 160,
						continuedAt: 200,
						continuationRunId: "revived-123",
					},
				},
				steps: [{ agent: "worker", status: "continued", sessionFile }],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-continued" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/already launched continuation 'revived-123'/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("recovers a dead-owner paused continuation claim before resuming", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-claimed-dead-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "paused-dead.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-claimed-dead", "status.json"), {
				runId: "run-claimed-dead",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [
					{
						agent: "worker",
						status: "paused",
						sessionFile,
						acceptance: {
							status: "skipped",
							effectiveAcceptance: {
								level: "checked",
								explicit: true,
								inferredReason: ["async write-capable or risky run"],
								criteria: [
									{
										id: "criterion-1",
										must: "Implement the requested change without widening scope",
										evidence: ["changed-files"],
										severity: "required",
									},
								],
								evidence: ["changed-files", "commands-run", "no-staged-files"],
								verify: [{ id: "tests", command: "npm test" }],
								stopRules: ["Do not widen scope"],
							},
							inferredReason: ["async write-capable or risky run"],
							criteria: [
								{
									id: "criterion-1",
									must: "Implement the requested change without widening scope",
									evidence: ["changed-files"],
									severity: "required",
								},
							],
							runtimeChecks: [
								{
									id: "paused",
									status: "not-applicable",
									message:
										"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
								},
							],
							verifyRuns: [],
						},
					},
				],
				lifecycle: { continuation: { claimToken: "claim-dead", claimedAt: 150, ownerPid: 4444 } },
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-claimed-dead" },
				{
					asyncDirRoot: asyncRoot,
					resultsDir: path.join(root, "results"),
					kill: () => {
						const error = new Error("dead") as NodeJS.ErrnoException;
						error.code = "ESRCH";
						throw error;
					},
					now: () => 250,
				},
			);
			assert.equal(target.kind, "revive");
			assert.equal(target.runId, "run-claimed-dead");
			const persisted = JSON.parse(
				fs.readFileSync(path.join(asyncRoot, "run-claimed-dead", "status.json"), "utf-8"),
			) as { lifecycle?: { continuation?: object; generation?: number } };
			assert.equal(persisted.lifecycle?.continuation, undefined);
			assert.equal(persisted.lifecycle?.generation, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects reserved or launched paused continuations with a known target run id as already launched", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-launched-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "paused-launched.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-launched", "status.json"), {
				runId: "run-launched",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [{ agent: "worker", status: "paused", sessionFile }],
				lifecycle: {
					continuation: {
						phase: "launched",
						claimToken: "claim-launched",
						claimedAt: 150,
						ownerPid: 5555,
						continuationRunId: "revived-123",
					},
				},
			});
			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-launched" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
					),
				/already launched continuation 'revived-123'/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects paused continuation claims when the recorded owner is alive, unknown, or legacy metadata is incomplete", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-claimed-live-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "paused-live.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-claimed-live", "status.json"), {
				runId: "run-claimed-live",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [
					{
						agent: "worker",
						status: "paused",
						sessionFile,
						acceptance: {
							status: "skipped",
							effectiveAcceptance: {
								level: "checked",
								explicit: true,
								inferredReason: ["async write-capable or risky run"],
								criteria: [
									{
										id: "criterion-1",
										must: "Implement the requested change without widening scope",
										evidence: ["changed-files"],
										severity: "required",
									},
								],
								evidence: ["changed-files", "commands-run", "no-staged-files"],
								verify: [{ id: "tests", command: "npm test" }],
								stopRules: ["Do not widen scope"],
							},
							inferredReason: ["async write-capable or risky run"],
							criteria: [
								{
									id: "criterion-1",
									must: "Implement the requested change without widening scope",
									evidence: ["changed-files"],
									severity: "required",
								},
							],
							runtimeChecks: [
								{
									id: "paused",
									status: "not-applicable",
									message:
										"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
								},
							],
							verifyRuns: [],
						},
					},
				],
				lifecycle: { continuation: { claimToken: "claim-live", claimedAt: 150, ownerPid: 5555 } },
			});
			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-claimed-live" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
					),
				/already claimed for continuation/,
			);
			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-claimed-live" },
						{
							asyncDirRoot: asyncRoot,
							resultsDir: path.join(root, "results"),
							kill: () => {
								const error = new Error("unknown") as NodeJS.ErrnoException;
								error.code = "EPERM";
								throw error;
							},
						},
					),
				/already claimed for continuation/,
			);
			writeJson(path.join(asyncRoot, "run-claimed-live", "status.json"), {
				runId: "run-claimed-live",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [
					{
						agent: "worker",
						status: "paused",
						sessionFile,
						acceptance: {
							status: "skipped",
							effectiveAcceptance: {
								level: "checked",
								explicit: true,
								inferredReason: ["async write-capable or risky run"],
								criteria: [
									{
										id: "criterion-1",
										must: "Implement the requested change without widening scope",
										evidence: ["changed-files"],
										severity: "required",
									},
								],
								evidence: ["changed-files", "commands-run", "no-staged-files"],
								verify: [{ id: "tests", command: "npm test" }],
								stopRules: ["Do not widen scope"],
							},
							inferredReason: ["async write-capable or risky run"],
							criteria: [
								{
									id: "criterion-1",
									must: "Implement the requested change without widening scope",
									evidence: ["changed-files"],
									severity: "required",
								},
							],
							runtimeChecks: [
								{
									id: "paused",
									status: "not-applicable",
									message:
										"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
								},
							],
							verifyRuns: [],
						},
					},
				],
				lifecycle: { continuation: { claimToken: "claim-legacy", claimedAt: 150 } },
			});
			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-claimed-live" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/already claimed for continuation/,
			);
			const persisted = JSON.parse(
				fs.readFileSync(path.join(asyncRoot, "run-claimed-live", "status.json"), "utf-8"),
			) as { lifecycle?: { continuation?: { ownerPid?: number; claimToken?: string } } };
			assert.equal(persisted.lifecycle?.continuation?.ownerPid, undefined);
			assert.equal(persisted.lifecycle?.continuation?.claimToken, "claim-legacy");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reuses skipped paused acceptance when reviving a paused child", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "paused.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-paused", "status.json"), {
				runId: "run-paused",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				tkTicket: { id: "psr-raw4", title: "Paused\u009b ticket\u001b[31m title\u001b[0m" },
				steps: [
					{
						agent: "worker",
						status: "paused",
						sessionFile,
						acceptance: {
							status: "skipped",
							effectiveAcceptance: {
								level: "checked",
								explicit: true,
								inferredReason: ["async write-capable or risky run"],
								criteria: [
									{
										id: "criterion-1",
										must: "Implement the requested change without widening scope",
										evidence: ["changed-files"],
										severity: "required",
									},
								],
								evidence: ["changed-files", "commands-run", "no-staged-files"],
								verify: [{ id: "tests", command: "npm test" }],
								stopRules: ["Do not widen scope"],
							},
							inferredReason: ["async write-capable or risky run"],
							criteria: [
								{
									id: "criterion-1",
									must: "Implement the requested change without widening scope",
									evidence: ["changed-files"],
									severity: "required",
								},
							],
							runtimeChecks: [
								{
									id: "paused",
									status: "not-applicable",
									message:
										"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
								},
							],
							verifyRuns: [],
						},
					},
				],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-paused" },
				{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
			);
			assert.equal(target.kind, "revive");
			assert.equal(target.state, "paused");
			assert.deepEqual(target.tkTicket, { id: "psr-raw4", title: "Paused ticket title" });
			assert.deepEqual(target.continuationAcceptance, {
				level: "checked",
				explicit: true,
				inferredReason: ["async write-capable or risky run"],
				criteria: [
					{
						id: "criterion-1",
						must: "Implement the requested change without widening scope",
						evidence: ["changed-files"],
						severity: "required",
					},
				],
				evidence: ["changed-files", "commands-run", "no-staged-files"],
				verify: [{ id: "tests", command: "npm test" }],
				stopRules: ["Do not widen scope"],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("permits paused not-required/level-none ledgers without reviving a continuation contract", () => {
		for (const persistedAs of ["status", "result-only"] as const) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-async-resume-paused-none-${persistedAs}-`));
			try {
				const asyncRoot = path.join(root, "runs");
				const resultsDir = path.join(root, "results");
				const sessionFile = path.join(root, `${persistedAs}.jsonl`);
				fs.writeFileSync(sessionFile, "", "utf-8");
				if (persistedAs === "status") {
					writeJson(path.join(asyncRoot, "run-paused-none", "status.json"), {
						runId: "run-paused-none",
						mode: "single",
						state: "paused",
						startedAt: 100,
						lastUpdate: 200,
						cwd: root,
						sessionFile,
						steps: [
							{ agent: "worker", status: "paused", sessionFile, acceptance: notRequiredPausedAcceptanceLedger() },
						],
					});
				} else {
					writeJson(path.join(resultsDir, "run-paused-none.json"), {
						id: "run-paused-none",
						agent: "worker",
						success: false,
						state: "paused",
						cwd: root,
						results: [
							{
								agent: "worker",
								interrupted: true,
								success: false,
								sessionFile,
								acceptance: notRequiredPausedAcceptanceLedger(),
							},
						],
					});
				}

				const target = resolveAsyncResumeTarget({ id: "run-paused-none" }, { asyncDirRoot: asyncRoot, resultsDir });
				assert.equal(target.kind, "revive");
				assert.equal(target.state, "paused");
				assert.equal(target.sessionFile, sessionFile);
				assert.equal(target.continuationAcceptance, undefined);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("rejects incompatible paused acceptance ledger statuses and status-level mismatches", () => {
		for (const persistedAs of ["status", "result-only"] as const) {
			for (const { label, acceptance, message } of [
				{
					label: "skipped-level-none",
					acceptance: skippedPausedAcceptanceLedger(pausedNoneAcceptance),
					message: /status 'skipped' cannot carry effective level 'none'/,
				},
				{
					label: "not-required-level-checked",
					acceptance: notRequiredPausedAcceptanceLedger(pausedCheckedAcceptance),
					message: /status 'not-required' must carry effective level 'none'/,
				},
				{
					label: "reviewed-terminal-status",
					acceptance: { ...skippedPausedAcceptanceLedger(), status: "reviewed" },
					message: /status 'reviewed' is incompatible with continuation resume; expected 'skipped' or 'not-required'/,
				},
				{
					label: "accepted-terminal-status",
					acceptance: { ...skippedPausedAcceptanceLedger(), status: "accepted" },
					message: /status 'accepted' is incompatible with continuation resume; expected 'skipped' or 'not-required'/,
				},
				{
					label: "rejected-terminal-status",
					acceptance: { ...skippedPausedAcceptanceLedger(), status: "rejected" },
					message: /status 'rejected' is incompatible with continuation resume; expected 'skipped' or 'not-required'/,
				},
			]) {
				const root = fs.mkdtempSync(
					path.join(os.tmpdir(), `pi-async-resume-paused-incompatible-${persistedAs}-${label}-`),
				);
				try {
					const asyncRoot = path.join(root, "runs");
					const resultsDir = path.join(root, "results");
					const sessionFile = path.join(root, `${label}.jsonl`);
					fs.writeFileSync(sessionFile, "", "utf-8");
					if (persistedAs === "status") {
						writeJson(path.join(asyncRoot, "run-paused-incompatible", "status.json"), {
							runId: "run-paused-incompatible",
							mode: "single",
							state: "paused",
							startedAt: 100,
							lastUpdate: 200,
							cwd: root,
							sessionFile,
							steps: [{ agent: "worker", status: "paused", sessionFile, acceptance }],
						});
					} else {
						writeJson(path.join(resultsDir, "run-paused-incompatible.json"), {
							id: "run-paused-incompatible",
							agent: "worker",
							success: false,
							state: "paused",
							cwd: root,
							results: [{ agent: "worker", interrupted: true, success: false, sessionFile, acceptance }],
						});
					}

					assert.throws(
						() => resolveAsyncResumeTarget({ id: "run-paused-incompatible" }, { asyncDirRoot: asyncRoot, resultsDir }),
						message,
					);
				} finally {
					fs.rmSync(root, { recursive: true, force: true });
				}
			}
		}
	});

	it("allows a paused child to revive without replay when its persisted session file is absent", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-missing-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "missing.jsonl");
			writeJson(path.join(asyncRoot, "run-paused-missing-session", "status.json"), {
				runId: "run-paused-missing-session",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [
					{
						agent: "worker",
						status: "paused",
						sessionFile,
						acceptance: {
							status: "skipped",
							effectiveAcceptance: {
								level: "checked",
								explicit: true,
								inferredReason: [],
								criteria: [
									{
										id: "criterion-1",
										must: "Implement the requested change without widening scope",
										evidence: ["changed-files"],
										severity: "required",
									},
								],
								evidence: ["changed-files", "commands-run", "no-staged-files"],
								verify: [],
								stopRules: ["Do not widen scope"],
							},
							criteria: [
								{
									id: "criterion-1",
									must: "Implement the requested change without widening scope",
									evidence: ["changed-files"],
									severity: "required",
								},
							],
							runtimeChecks: [
								{
									id: "paused",
									status: "not-applicable",
									message:
										"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
								},
							],
							verifyRuns: [],
						},
					},
				],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-paused-missing-session" },
				{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
			);
			assert.equal(target.kind, "revive");
			assert.equal(target.state, "paused");
			assert.equal(target.sessionFile, undefined);
			assert.deepEqual(target.continuationAcceptance, {
				level: "checked",
				explicit: true,
				inferredReason: [],
				criteria: [
					{
						id: "criterion-1",
						must: "Implement the requested change without widening scope",
						evidence: ["changed-files"],
						severity: "required",
					},
				],
				evidence: ["changed-files", "commands-run", "no-staged-files"],
				verify: [],
				stopRules: ["Do not widen scope"],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when a paused child has no persisted acceptance ledger yet", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-window-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "paused.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-paused-window", "status.json"), {
				runId: "run-paused-window",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [{ agent: "worker", status: "paused", sessionFile }],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-paused-window" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/skipped acceptance ledger has not been persisted yet/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous run id prefixes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-aa", "status.json"), {
				runId: "run-aa",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "scout", status: "running" }],
			});
			writeJson(path.join(asyncRoot, "run-ab", "status.json"), {
				runId: "run-ab",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-a" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/Ambiguous async run id prefix 'run-a' matched: run-aa, run-ab/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects path-like ids and directories outside the async root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paths-"));
		try {
			const asyncRoot = path.join(root, "runs");
			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "../run" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/id must be an async run id or prefix, not a path/,
			);
			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ dir: path.join(root, "outside") },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/Async run directory must be inside/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps terminal follow-up resumes strict when the persisted session file is absent", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-terminal-missing-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "missing.jsonl");
			writeJson(path.join(asyncRoot, "run-terminal-missing-session", "status.json"), {
				runId: "run-terminal-missing-session",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				sessionFile,
				steps: [{ agent: "worker", status: "complete", sessionFile }],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-terminal-missing-session" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/session file does not exist/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps completed children strict when an overall paused run has a missing session file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-terminal-missing-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const completedSessionFile = path.join(root, "missing-completed.jsonl");
			const pausedSessionFile = path.join(root, "missing-paused.jsonl");
			writeJson(path.join(asyncRoot, "run-paused-terminal-missing-session", "status.json"), {
				runId: "run-paused-terminal-missing-session",
				mode: "parallel",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "worker-a", status: "complete", sessionFile: completedSessionFile },
					{
						agent: "worker-b",
						status: "paused",
						sessionFile: pausedSessionFile,
						acceptance: { status: "skipped", effectiveAcceptance: { level: "checked" } },
					},
				],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-paused-terminal-missing-session", index: 0 },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/session file does not exist/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects non-jsonl session files before reviving", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "session.txt");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-session", "status.json"), {
				runId: "run-session",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-session" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/session file must be a \.jsonl file/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed result metadata before using session fields", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-result-"));
		try {
			const resultsDir = path.join(root, "results");
			writeJson(path.join(resultsDir, "run-result.json"), {
				id: "run-result",
				agent: "worker",
				success: true,
				state: "complete",
				results: [{ agent: "worker", sessionFile: { path: "session.jsonl" } }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-result" }, { asyncDirRoot: path.join(root, "runs"), resultsDir }),
				/results\[0\].sessionFile must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed status session ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-session-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-session-id", "status.json"), {
				runId: "run-session-id",
				sessionId: { value: "session" },
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-session-id" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/sessionId must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns a live intercom target for a running child", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-live-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-live", "status.json"), {
				runId: "run-live",
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "scout", status: "running" }],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-live" },
				{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
			);

			assert.equal(target.kind, "live");
			assert.equal(target.intercomTarget, "subagent-scout-run-live-1");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("revives a completed child by index while a sibling async child is still running", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-partial-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "done.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-partial", "status.json"), {
				runId: "run-partial",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "done", status: "complete", sessionFile },
					{ agent: "active", status: "running" },
				],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-partial", index: 0 },
				{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
			);
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "done");
			assert.equal(target.sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects pending indexed children in still-running async runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-pending-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "pending.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-pending", "status.json"), {
				runId: "run-pending",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "active", status: "running" },
					{ agent: "later", status: "pending", sessionFile },
				],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-pending", index: 1 },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/pending and has not started yet/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves a completed multi-child run when an index and per-child session file are available", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-multi-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const firstSession = path.join(root, "a.jsonl");
			const secondSession = path.join(root, "b.jsonl");
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-multi", "status.json"), {
				runId: "run-multi",
				mode: "chain",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession },
				],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-multi" },
						{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
					),
				/Provide index to choose one/,
			);
			const target = resolveAsyncResumeTarget(
				{ id: "run-multi", index: 1 },
				{ asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
			);
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "b");
			assert.equal(target.index, 1);
			assert.equal(target.sessionFile, secondSession);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("result-only revival identifies a paused child via interrupted flag", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-paused-"));
		try {
			const resultsDir = path.join(root, "results");
			const sessionFile = path.join(root, "result-only.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			const effectiveAcceptance = {
				level: "checked",
				explicit: true,
				inferredReason: [],
				criteria: [
					{
						id: "criterion-1",
						must: "Implement the requested change without widening scope",
						evidence: ["changed-files"],
						severity: "required",
					},
				],
				evidence: ["changed-files", "commands-run", "no-staged-files"],
				verify: [],
				stopRules: ["Do not widen scope"],
			};
			writeJson(path.join(resultsDir, "run-result-only-paused.json"), {
				id: "run-result-only-paused",
				agent: "worker",
				success: false,
				state: "paused",
				cwd: root,
				results: [
					{
						agent: "worker",
						interrupted: true,
						success: false,
						exitCode: 0,
						sessionFile,
						activeRuntimeMs: 375,
						acceptance: {
							status: "skipped",
							effectiveAcceptance,
							criteria: [
								{
									id: "criterion-1",
									must: "Implement the requested change without widening scope",
									evidence: ["changed-files"],
									severity: "required",
								},
							],
							runtimeChecks: [
								{
									id: "paused",
									status: "not-applicable",
									message:
										"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
								},
							],
							verifyRuns: [],
						},
					},
				],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-result-only-paused" },
				{ asyncDirRoot: path.join(root, "runs"), resultsDir },
			);
			assert.equal(target.kind, "revive");
			assert.equal(target.state, "paused");
			// F3: paused correctly identified via interrupted
			assert.equal(target.sessionFile, sessionFile);
			assert.equal(target.activeRuntimeMs, 375);
			// F3: continuationAcceptance applied from result artifact
			assert.deepEqual(target.continuationAcceptance, effectiveAcceptance);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("result-only revival: non-interrupted child is not identified as paused", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-not-paused-"));
		try {
			const resultsDir = path.join(root, "results");
			const sessionFile = path.join(root, "result-only-terminal.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(resultsDir, "run-result-only-terminal.json"), {
				id: "run-result-only-terminal",
				agent: "worker",
				success: false,
				state: "paused",
				cwd: root,
				results: [
					{
						agent: "worker",
						// success: false but NOT interrupted — should not be treated as paused
						success: false,
						exitCode: 1,
						sessionFile,
					},
				],
			});

			// Without a status file, a non-interrupted child must not be misidentified as paused.
			// Since it is not paused, the fail-closed guard must not fire (no acceptance needed).
			const target = resolveAsyncResumeTarget(
				{ id: "run-result-only-terminal" },
				{ asyncDirRoot: path.join(root, "runs"), resultsDir },
			);
			assert.equal(target.kind, "revive");
			assert.equal(target.continuationAcceptance, undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("result-only revival fails closed when interrupted child has no acceptance ledger", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-no-acceptance-"));
		try {
			const resultsDir = path.join(root, "results");
			const sessionFile = path.join(root, "result-only-no-acceptance.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(resultsDir, "run-result-only-no-acceptance.json"), {
				id: "run-result-only-no-acceptance",
				agent: "worker",
				success: false,
				state: "paused",
				cwd: root,
				results: [
					{
						agent: "worker",
						interrupted: true,
						success: false,
						exitCode: 0,
						sessionFile,
						// No acceptance field — should trigger fail-closed guard
					},
				],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-result-only-no-acceptance" },
						{ asyncDirRoot: path.join(root, "runs"), resultsDir },
					),
				/skipped acceptance ledger has not been persisted yet/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("result-only revival propagates the full persisted skipped ledger into continuationAcceptance", () => {
		// This test verifies result-artifact propagation on result-only revival:
		// the persisted skipped ledger's effectiveAcceptance is surfaced verbatim as
		// continuationAcceptance (all gates preserved). It does NOT exercise
		// mergeContinuationAcceptance — the caller applies any monotonic merge externally.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-propagation-"));
		try {
			const resultsDir = path.join(root, "results");
			const sessionFile = path.join(root, "result-only-monotonic.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			const strictAcceptance = {
				level: "checked",
				explicit: true,
				inferredReason: [],
				criteria: [
					{
						id: "criterion-1",
						must: "Implement the requested change without widening scope",
						evidence: ["changed-files"],
						severity: "required",
					},
				],
				evidence: ["changed-files", "commands-run", "no-staged-files"],
				verify: [{ id: "tests", command: "npm test" }],
				stopRules: ["Do not widen scope"],
			};
			writeJson(path.join(resultsDir, "run-result-only-monotonic.json"), {
				id: "run-result-only-monotonic",
				agent: "worker",
				success: false,
				state: "paused",
				cwd: root,
				results: [
					{
						agent: "worker",
						interrupted: true,
						success: false,
						exitCode: 0,
						sessionFile,
						acceptance: {
							status: "skipped",
							effectiveAcceptance: strictAcceptance,
							criteria: [
								{
									id: "criterion-1",
									must: "Implement the requested change without widening scope",
									evidence: ["changed-files"],
									severity: "required",
								},
							],
							runtimeChecks: [
								{
									id: "paused",
									status: "not-applicable",
									message: "Acceptance was not evaluated because the run was paused/interrupted.",
								},
							],
							verifyRuns: [],
						},
					},
				],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-result-only-monotonic" },
				{ asyncDirRoot: path.join(root, "runs"), resultsDir },
			);
			assert.equal(target.kind, "revive");
			assert.equal(target.state, "paused");
			// continuationAcceptance carries the full strict contract from the result artifact:
			// verify commands, stop rules, and criteria are all propagated verbatim.
			const ca = target.continuationAcceptance;
			assert.ok(ca, "continuationAcceptance must be present");
			assert.equal(ca.level, "checked");
			assert.ok(Array.isArray(ca.verify) && ca.verify.length > 0, "verify commands must be preserved");
			assert.ok(Array.isArray(ca.stopRules) && ca.stopRules.length > 0, "stop rules must be preserved");
			assert.ok(Array.isArray(ca.criteria) && ca.criteria.length > 0, "criteria must be preserved");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("F4: result-only paused child with a malformed skipped acceptance ledger fails closed with a clear error", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-malformed-"));
		try {
			const resultsDir = path.join(root, "results");
			const sessionFile = path.join(root, "result-only-malformed.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(resultsDir, "run-result-only-malformed.json"), {
				id: "run-result-only-malformed",
				agent: "worker",
				success: false,
				state: "paused",
				cwd: root,
				results: [
					{
						agent: "worker",
						interrupted: true,
						success: false,
						exitCode: 0,
						sessionFile,
						acceptance: {
							status: "skipped",
							// Malformed/partial: status is skipped (so the presence guard passes) but
							// effectiveAcceptance is missing the required arrays
							// (criteria/evidence/verify/stopRules/inferredReason). Must fail closed with
							// the incomplete/malformed error, NOT a raw TypeError from mergeContinuationAcceptance.
							effectiveAcceptance: { level: "checked" },
							runtimeChecks: [
								{
									id: "paused",
									status: "not-applicable",
									message: "Acceptance was not evaluated because the run was paused/interrupted.",
								},
							],
							verifyRuns: [],
						},
					},
				],
			});

			assert.throws(
				() =>
					resolveAsyncResumeTarget(
						{ id: "run-result-only-malformed" },
						{ asyncDirRoot: path.join(root, "runs"), resultsDir },
					),
				(err) => {
					assert.ok(err instanceof Error, "must throw an Error");
					assert.match(
						err.message,
						/incomplete or malformed; refusing to resume with an unverified acceptance contract/,
					);
					assert.doesNotMatch(
						err.message,
						/is not iterable|Cannot read propert|undefined is not/,
						"must be a clean fail-closed error, not a raw TypeError",
					);
					return true;
				},
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("F5: result-only paused child whose acceptance arrays hold malformed elements fails closed cleanly", () => {
		// All 5 arrays are PRESENT (so the presence-only predicate would have passed),
		// but criteria holds a null element (and verify a command-less object). Downstream
		// mergeAcceptanceCriteria/formatAcceptancePrompt dereference criterion.id and would
		// throw a raw TypeError; the element-shape predicate must fail closed with the clean
		// incomplete/malformed error instead.
		for (const { label, effectiveAcceptance } of [
			{
				label: "criteria-null-element",
				effectiveAcceptance: {
					level: "checked",
					explicit: true,
					inferredReason: [],
					criteria: [null],
					evidence: ["changed-files"],
					verify: [],
					stopRules: ["Do not widen scope"],
				},
			},
			{
				label: "verify-missing-command",
				effectiveAcceptance: {
					level: "checked",
					explicit: true,
					inferredReason: [],
					criteria: [{ id: "criterion-1", must: "x", evidence: ["changed-files"], severity: "required" }],
					evidence: ["changed-files"],
					verify: [{}],
					stopRules: [],
				},
			},
		]) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-async-resume-result-only-badelem-${label}-`));
			try {
				const resultsDir = path.join(root, "results");
				const sessionFile = path.join(root, "result-only-badelem.jsonl");
				fs.writeFileSync(sessionFile, "", "utf-8");
				writeJson(path.join(resultsDir, "run-result-only-badelem.json"), {
					id: "run-result-only-badelem",
					agent: "worker",
					success: false,
					state: "paused",
					cwd: root,
					results: [
						{
							agent: "worker",
							interrupted: true,
							success: false,
							exitCode: 0,
							sessionFile,
							acceptance: {
								status: "skipped",
								effectiveAcceptance,
								runtimeChecks: [
									{
										id: "paused",
										status: "not-applicable",
										message: "Acceptance was not evaluated because the run was paused/interrupted.",
									},
								],
								verifyRuns: [],
							},
						},
					],
				});

				assert.throws(
					() =>
						resolveAsyncResumeTarget(
							{ id: "run-result-only-badelem" },
							{ asyncDirRoot: path.join(root, "runs"), resultsDir },
						),
					(err) => {
						assert.ok(err instanceof Error, `[${label}] must throw an Error`);
						assert.match(
							err.message,
							/incomplete or malformed; refusing to resume with an unverified acceptance contract/,
							`[${label}] must be the clean fail-closed error`,
						);
						assert.doesNotMatch(
							err.message,
							/is not iterable|Cannot read propert|undefined is not/,
							`[${label}] must not be a raw TypeError`,
						);
						return true;
					},
				);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("F4: result-only paused child with a well-formed skipped ledger still returns continuationAcceptance", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-wellformed-"));
		try {
			const resultsDir = path.join(root, "results");
			const sessionFile = path.join(root, "result-only-wellformed.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			const effectiveAcceptance = {
				level: "checked",
				explicit: true,
				inferredReason: [],
				criteria: [
					{
						id: "criterion-1",
						must: "Implement the requested change without widening scope",
						evidence: ["changed-files"],
						severity: "required",
					},
				],
				evidence: ["changed-files", "commands-run", "no-staged-files"],
				verify: [],
				stopRules: ["Do not widen scope"],
			};
			writeJson(path.join(resultsDir, "run-result-only-wellformed.json"), {
				id: "run-result-only-wellformed",
				agent: "worker",
				success: false,
				state: "paused",
				cwd: root,
				results: [
					{
						agent: "worker",
						interrupted: true,
						success: false,
						exitCode: 0,
						sessionFile,
						acceptance: {
							status: "skipped",
							effectiveAcceptance,
							criteria: [
								{
									id: "criterion-1",
									must: "Implement the requested change without widening scope",
									evidence: ["changed-files"],
									severity: "required",
								},
							],
							runtimeChecks: [
								{
									id: "paused",
									status: "not-applicable",
									message: "Acceptance was not evaluated because the run was paused/interrupted.",
								},
							],
							verifyRuns: [],
						},
					},
				],
			});

			const target = resolveAsyncResumeTarget(
				{ id: "run-result-only-wellformed" },
				{ asyncDirRoot: path.join(root, "runs"), resultsDir },
			);
			assert.equal(target.kind, "revive");
			assert.equal(target.state, "paused");
			assert.deepEqual(target.continuationAcceptance, effectiveAcceptance);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("frames the revived follow-up with original run context", () => {
		const task = buildRevivedAsyncTask(
			{
				kind: "revive",
				runId: "run-old",
				state: "complete",
				agent: "worker",
				index: 0,
				intercomTarget: "subagent-worker-run-old-1",
				sessionFile: "/tmp/session.jsonl",
			},
			"What changed?",
		);

		assert.match(task, /Original run: run-old/);
		assert.doesNotMatch(task, /async subagent conversation/);
		assert.match(task, /Original agent: worker/);
		assert.match(task, /Original session file: \/tmp\/session\.jsonl/);
		assert.match(task, /Follow-up:\nWhat changed\?/);
	});
});
