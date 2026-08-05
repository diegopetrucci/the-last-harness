import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { boundSupervisorSummary, finalizeLifecycleContinuationLaunch, lifecycleGeneration, recoverStaleLifecycleContinuationClaim, recoverStoppedLifecycleOwnership, transitionLifecycleStatus, withLifecycleContinuation, withLifecycleStatusLock, writeNormalizedLifecycleStatus } from "../../src/runs/shared/lifecycle-state.ts";
import { readStatus } from "../../src/shared/utils.ts";

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function expectNoSecretInError(fn: () => void, secret: string, expected: RegExp): void {
	assert.throws(() => {
		try {
			fn();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			assert.match(message, expected);
			assert.equal(message.includes(secret), false, `expected error to avoid secret root '${secret}', got: ${message}`);
			throw error;
		}
	}, expected);
}

describe("lifecycle state helpers", () => {
	it("bounds and sanitizes supervisor summaries", () => {
		const bounded = boundSupervisorSummary("  waiting\u0000\nfor\t supervisor  ", 18);
		assert.equal(bounded, "waiting for sup…");
		assert.ok((bounded?.length ?? 0) > 0);
	});

	it("normalizes persisted lifecycle metadata while preserving parse compatibility and privacy", () => {
		const root = tempRoot("pi-lifecycle-read-");
		try {
			const asyncDir = path.join(root, "run-legacy");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-legacy",
				mode: "single",
				state: "paused",
				startedAt: 100,
				steps: [{ agent: "worker", status: "paused" }],
				pause: {
					kind: "awaiting_supervisor",
					summary: "  need\nhelp  ",
					ownerPid: -1,
					request: {
						tool: "contact_supervisor",
						reason: "need_decision",
						requestId: " req-1 ",
						summary: "  private summary  ",
						interview: { secret: true },
						args: { token: "SECRET" },
					},
				},
				lifecycle: {
					continuation: {
						claimToken: "bad token with spaces and /private/root/secret",
						continuationRunId: `${"x".repeat(200)}`,
					},
				},
			}, null, 2), "utf-8");

			const status = readStatus(asyncDir);
			assert.equal(status?.state, "paused");
			assert.equal(status?.pause?.kind, "awaiting_supervisor");
			assert.equal(status?.pause?.summary, "need help");
			assert.equal(status?.pause?.ownerPid, undefined);
			assert.deepEqual(status?.pause?.request, {
				tool: "contact_supervisor",
				reason: "need_decision",
				requestId: "req-1",
				summary: "private summary",
			});
			assert.equal(lifecycleGeneration(status), 0);
			assert.equal(status?.lifecycle?.continuation?.claimToken, undefined);
			assert.equal(status?.lifecycle?.continuation?.continuationRunId, undefined);

			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-legacy",
				mode: "single",
				state: "pausing",
				startedAt: 100,
				steps: [{ agent: "worker", status: "pausing" }],
			}, null, 2), "utf-8");
			const pausingStatus = readStatus(asyncDir);
			assert.equal(pausingStatus?.state, "pausing");
			assert.equal(pausingStatus?.steps?.[0]?.status, "pausing");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops oversized request identifiers while preserving safe continuation tokens", () => {
		const root = tempRoot("pi-lifecycle-bounds-");
		try {
			const normalized = writeNormalizedLifecycleStatus(root, {
				runId: "run-bounds",
				mode: "single",
				state: "paused",
				startedAt: 100,
				pause: {
					kind: "awaiting_supervisor",
					request: {
						tool: "contact_supervisor",
						reason: "need_decision",
						requestId: `req-${"x".repeat(200)}`,
					},
				},
				lifecycle: {
					continuation: {
						claimToken: "claim-safe-123",
						continuationRunId: "continued-safe-123",
					},
				},
				steps: [{ agent: "worker", status: "paused" }],
			});
			assert.equal(normalized.pause?.request?.requestId, undefined);
			assert.equal(normalized.lifecycle?.continuation?.claimToken, "claim-safe-123");
			assert.equal(normalized.lifecycle?.continuation?.continuationRunId, "continued-safe-123");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes transitions atomically with monotonic guarded generations", () => {
		const root = tempRoot("pi-lifecycle-transition-");
		try {
			const asyncDir = path.join(root, "run-guarded");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-guarded",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			const pausing = transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: 0,
				mutate: (status) => ({
					...status,
					state: "pausing",
					pid: 123,
					pause: { kind: "awaiting_supervisor", summary: "Need decision", ownerPid: 123, requestedAt: 150 },
					steps: [{ ...status.steps?.[0], agent: "worker", status: "pausing" }],
				}),
			});
			assert.equal(pausing.previousGeneration, 0);
			assert.equal(pausing.nextGeneration, 1);
			const paused = transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: 1,
				mutate: (status) => ({
					...status,
					state: "paused",
					pid: undefined,
					pause: { ...status.pause!, ownerPid: undefined, pausedAt: 200 },
					steps: [{ ...status.steps?.[0], agent: "worker", status: "paused", endedAt: 200, exitCode: 0 }],
				}),
			});
			assert.equal(paused.previousGeneration, 1);
			assert.equal(paused.nextGeneration, 2);
			const continued = transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: 2,
				mutate: (status) => ({
					...status,
					state: "continued",
					steps: [{ ...status.steps?.[0], agent: "worker", status: "continued", endedAt: 250, exitCode: 0 }],
				}),
			});
			assert.equal(continued.previousGeneration, 2);
			assert.equal(continued.nextGeneration, 3);
			assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 3);
			assert.throws(
				() => transitionLifecycleStatus({ asyncDir, expectedGeneration: 0, mutate: (status) => status }),
				/expected generation 0, found 3/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects re-entrant lifecycle transitions before a second mutation can enter", () => {
		const secret = "SECRET-LOCK-ROOT-12345";
		const root = path.join(tempRoot("pi-lifecycle-lock-"), secret, "private-runspace");
		try {
			const asyncDir = path.join(root, "run-locked");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-locked",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			let outerMutations = 0;
			let innerMutations = 0;
			const transitioned = transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: 0,
				mutate: (status) => {
					outerMutations += 1;
					expectNoSecretInError(
						() => transitionLifecycleStatus({
							asyncDir,
							expectedGeneration: 0,
							mutate: (nestedStatus) => {
								innerMutations += 1;
								return nestedStatus;
							},
						}),
						secret,
						/status lock/,
					);
					assert.equal(innerMutations, 0);
					return {
						...status,
						state: "pausing",
						steps: [{ ...status.steps?.[0], agent: status.steps?.[0]?.agent ?? "worker", status: "pausing" }],
					};
				},
			});
			assert.equal(outerMutations, 1);
			assert.equal(transitioned.status.state, "pausing");
			assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the shared lifecycle lock for read-only canonical checks", () => {
		const secret = "SECRET-LOCK-READ-24680";
		const root = path.join(tempRoot("pi-lifecycle-read-lock-"), secret, "private-runspace");
		try {
			const asyncDir = path.join(root, "run-read-locked");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-read-locked",
				mode: "single",
				state: "paused",
				startedAt: 100,
				steps: [{ agent: "worker", status: "paused" }],
			});
			assert.equal(withLifecycleStatusLock(asyncDir, (status) => status?.state), "paused");
			expectNoSecretInError(
				() => withLifecycleStatusLock(asyncDir, () => withLifecycleStatusLock(asyncDir, () => undefined, { retryDelaysMs: [] }), { retryDelaysMs: [] }),
				secret,
				/status lock/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports stale generations after the lock holder commits", () => {
		const secret = "SECRET-STALE-ROOT-67890";
		const root = path.join(tempRoot("pi-lifecycle-stale-"), secret, "private-runspace");
		try {
			const asyncDir = path.join(root, "run-stale");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-stale",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});
			transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: 0,
				mutate: (status) => ({ ...status, state: "paused", pause: { kind: "cohort_pause", pausedAt: 200 } }),
			});
			expectNoSecretInError(
				() => transitionLifecycleStatus({ asyncDir, expectedGeneration: 0, mutate: (status) => status }),
				secret,
				/expected generation 0, found 1/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reclaims leaked transition locks only after confirming the recorded owner pid is dead", () => {
		const root = tempRoot("pi-lifecycle-lock-reclaim-");
		try {
			const asyncDir = path.join(root, "run-dead-owner");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-dead-owner",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});
			const lockDir = path.join(asyncDir, ".lifecycle-transition.lock");
			fs.mkdirSync(lockDir, { recursive: true });
			fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ token: "owner-dead", pid: 4242, acquiredAt: 150 }), "utf-8");

			const transitioned = transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: 0,
				lockOptions: { kill: () => { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; }, retryDelaysMs: [] },
				mutate: (status) => ({ ...status, state: "paused", pause: { kind: "cohort_pause", pausedAt: 200 } }),
			});
			assert.equal(transitioned.status.state, "paused");
			assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 1);
			assert.equal(fs.existsSync(lockDir), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("never reclaims a transition lock while the recorded owner pid is alive or unknown", () => {
		const root = tempRoot("pi-lifecycle-lock-live-");
		try {
			const asyncDir = path.join(root, "run-live-owner");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-live-owner",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});
			const lockDir = path.join(asyncDir, ".lifecycle-transition.lock");
			fs.mkdirSync(lockDir, { recursive: true });
			fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ token: "owner-live", pid: 5555, acquiredAt: 150 }), "utf-8");
			assert.throws(
				() => transitionLifecycleStatus({
					asyncDir,
					expectedGeneration: 0,
					lockOptions: { kill: () => true, retryDelaysMs: [] },
					mutate: (status) => status,
				}),
				/status lock \(pid 5555, acquired 1970-01-01T00:00:00.150Z\)/,
			);
			assert.equal(fs.existsSync(lockDir), true);
			assert.throws(
				() => transitionLifecycleStatus({
					asyncDir,
					expectedGeneration: 0,
					lockOptions: { kill: () => { const error = new Error("no access") as NodeJS.ErrnoException; error.code = "EPERM"; throw error; }, retryDelaysMs: [] },
					mutate: (status) => status,
				}),
				/status lock \(pid 5555, acquired 1970-01-01T00:00:00.150Z\)/,
			);
			assert.equal(fs.existsSync(lockDir), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reclaims ownerless transition locks only after a conservative age threshold", () => {
		const root = tempRoot("pi-lifecycle-lock-ownerless-");
		try {
			const asyncDir = path.join(root, "run-ownerless");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-ownerless",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});
			const lockDir = path.join(asyncDir, ".lifecycle-transition.lock");
			fs.mkdirSync(lockDir, { recursive: true });
			fs.writeFileSync(path.join(lockDir, "owner.json"), "{not-json", "utf-8");
			fs.utimesSync(lockDir, new Date(0), new Date(0));
			assert.throws(
				() => transitionLifecycleStatus({
					asyncDir,
					expectedGeneration: 0,
					lockOptions: { now: () => 5_000, ownerlessStaleMs: 10_000, retryDelaysMs: [] },
					mutate: (status) => status,
				}),
				/status lock/,
			);
			assert.equal(fs.existsSync(lockDir), true);
			const transitioned = transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: 0,
				lockOptions: { now: () => 20_000, ownerlessStaleMs: 10_000, retryDelaysMs: [] },
				mutate: (status) => ({ ...status, state: "paused", pause: { kind: "cohort_pause", pausedAt: 200 } }),
			});
			assert.equal(transitioned.status.state, "paused");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("never deletes a replacement transition lock owner during stale-lock recovery", () => {
		const root = tempRoot("pi-lifecycle-lock-race-");
		try {
			const asyncDir = path.join(root, "run-replacement-owner");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-replacement-owner",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});
			const lockDir = path.join(asyncDir, ".lifecycle-transition.lock");
			const ownerPath = path.join(lockDir, "owner.json");
			fs.mkdirSync(lockDir, { recursive: true });
			fs.writeFileSync(ownerPath, JSON.stringify({ token: "owner-old", pid: 7001, acquiredAt: 150 }), "utf-8");
			let checks = 0;
			assert.throws(
				() => transitionLifecycleStatus({
					asyncDir,
					expectedGeneration: 0,
					lockOptions: {
						kill: () => {
							checks += 1;
							if (checks === 1) {
								fs.writeFileSync(ownerPath, JSON.stringify({ token: "owner-new", pid: 7002, acquiredAt: 160 }), "utf-8");
							}
							const error = new Error("dead") as NodeJS.ErrnoException;
							error.code = "ESRCH";
							throw error;
						},
						retryDelaysMs: [],
					},
					mutate: (status) => status,
				}),
				/status lock \(pid 7002, acquired 1970-01-01T00:00:00.160Z\)/,
			);
			assert.deepEqual(JSON.parse(fs.readFileSync(ownerPath, "utf-8")) as { token: string; pid: number; acquiredAt: number }, { token: "owner-new", pid: 7002, acquiredAt: 160 });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects missing persisted status without leaking local roots", () => {
		const secret = "SECRET-MISSING-ROOT-24680";
		const root = path.join(tempRoot("pi-lifecycle-missing-"), secret, "private-runspace");
		try {
			const asyncDir = path.join(root, "run-missing");
			expectNoSecretInError(
				() => transitionLifecycleStatus({ asyncDir, expectedGeneration: 0, mutate: (status) => status }),
				secret,
				/persisted status was not found/,
			);
		} finally {
			fs.rmSync(path.dirname(path.dirname(root)), { recursive: true, force: true });
		}
	});

	it("recovers dead-owner continuation claims and leaves completed claims terminal", () => {
		const root = tempRoot("pi-lifecycle-claim-dead-");
		try {
			const asyncDir = path.join(root, "run-claim-dead");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-claim-dead",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 180,
				pause: { kind: "awaiting_supervisor", pausedAt: 170 },
				steps: [{ agent: "worker", status: "paused", pause: { kind: "awaiting_supervisor", pausedAt: 170 } }],
				lifecycle: { generation: 0, continuation: { claimToken: "claim-dead", claimedAt: 175, ownerPid: 8123 } },
			});
			const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
				kill: () => { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; },
				now: () => 250,
			});
			assert.equal(recovered.recovered, true);
			assert.equal(recovered.liveness, "dead");
			assert.equal(recovered.status?.lifecycle?.continuation, undefined);
			assert.equal(readStatus(asyncDir)?.lifecycle?.continuation, undefined);
			assert.equal(readStatus(asyncDir)?.lifecycle?.generation, 1);

			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-claim-dead",
				mode: "single",
				state: "continued",
				startedAt: 100,
				steps: [{ agent: "worker", status: "continued" }],
				lifecycle: { generation: 1, continuation: { claimToken: "claim-done", claimedAt: 260, ownerPid: 8123, continuedAt: 270, continuationRunId: "resumed-1" } },
			});
			const completed = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
				kill: () => { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; },
			});
			assert.equal(completed.recovered, false);
			assert.equal(completed.liveness, "completed");
			assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.continuationRunId, "resumed-1");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("clears dead-owner reserved continuations only when no target launch artifacts exist", () => {
		const root = tempRoot("pi-lifecycle-reserved-recovery-");
		try {
			const asyncDir = path.join(root, "run-reserved-recovery");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-reserved-recovery",
				mode: "single",
				state: "paused",
				startedAt: 100,
				steps: [{ agent: "worker", status: "paused" }],
				lifecycle: { generation: 0, continuation: { phase: "reserved", claimToken: "claim-reserved", claimedAt: 150, ownerPid: 9001, continuationRunId: "revived-1" } },
			});
			const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
				kill: () => { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; },
				now: () => 200,
				asyncDirRoot: root,
			});
			assert.equal(recovered.recovered, true);
			assert.equal(readStatus(asyncDir)?.lifecycle?.continuation, undefined);

			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-reserved-recovery",
				mode: "single",
				state: "paused",
				startedAt: 100,
				steps: [{ agent: "worker", status: "paused" }],
				lifecycle: { generation: 0, continuation: { phase: "launched", claimToken: "claim-launched", claimedAt: 150, ownerPid: 9002, continuationRunId: "revived-2" } },
			});
			fs.mkdirSync(path.join(root, "revived-2"), { recursive: true });
			const blocked = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
				kill: () => { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; },
				now: () => 220,
				asyncDirRoot: root,
			});
			assert.equal(blocked.recovered, false);
			assert.equal(blocked.liveness, "blocked");
			assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.continuationRunId, "revived-2");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("finalizes reserved continuations during launch gating before any target work begins", () => {
		const root = tempRoot("pi-lifecycle-finalize-reserved-");
		try {
			const asyncDir = path.join(root, "run-finalize-reserved");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-finalize-reserved",
				mode: "single",
				state: "paused",
				startedAt: 100,
				steps: [{ agent: "worker", status: "paused", pause: { kind: "awaiting_supervisor", pausedAt: 140 } }],
				pause: { kind: "awaiting_supervisor", pausedAt: 140 },
				lifecycle: { generation: 0, continuation: { phase: "reserved", claimToken: "claim-gate", claimedAt: 150, ownerPid: 9003, continuationRunId: "revived-gate" } },
			});
			const finalized = finalizeLifecycleContinuationLaunch(asyncDir, 0, "claim-gate", "revived-gate", { now: () => 250 });
			assert.equal(finalized.finalized, true);
			assert.equal(finalized.lost, false);
			const persisted = readStatus(asyncDir);
			assert.equal(persisted?.state, "continued");
			assert.equal(persisted?.steps?.[0]?.status, "continued");
			assert.equal(persisted?.lifecycle?.continuation?.phase, "continued");
			assert.equal(persisted?.lifecycle?.continuation?.continuationRunId, "revived-gate");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats already-finalized continuations as idempotent crash recovery", () => {
		const root = tempRoot("pi-lifecycle-finalize-idempotent-");
		try {
			const asyncDir = path.join(root, "run-finalize-idempotent");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-finalize-idempotent",
				mode: "single",
				state: "continued",
				startedAt: 100,
				steps: [{ agent: "worker", status: "continued" }],
				lifecycle: { generation: 0, continuation: { phase: "continued", claimToken: "claim-idempotent", claimedAt: 150, continuedAt: 240, continuationRunId: "revived-idempotent" } },
			});
			const finalized = finalizeLifecycleContinuationLaunch(asyncDir, 0, "claim-idempotent", "revived-idempotent", { now: () => 260 });
			assert.equal(finalized.finalized, true);
			assert.equal(finalized.lost, false);
			assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.continuedAt, 240);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects late continuation runners that lose their reservation before launch gating", () => {
		const root = tempRoot("pi-lifecycle-late-runner-");
		try {
			const asyncDir = path.join(root, "run-late-runner");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-late-runner",
				mode: "single",
				state: "paused",
				startedAt: 100,
				steps: [{ agent: "worker", status: "paused" }],
				lifecycle: { generation: 0, continuation: { phase: "reserved", claimToken: "claim-late", claimedAt: 150, ownerPid: 9003, continuationRunId: "revived-late" } },
			});
			transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: 0,
				mutate: (status) => ({ ...status, lifecycle: withLifecycleContinuation(status, 0, undefined) }),
			});
			const late = finalizeLifecycleContinuationLaunch(asyncDir, 0, "claim-late", "revived-late", { now: () => 250 });
			assert.equal(late.finalized, false);
			assert.equal(late.lost, true);
			assert.equal(readStatus(asyncDir)?.state, "paused");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps continuation claims fail-closed for alive, unknown, stale-generation, and historical metadata", () => {
		const root = tempRoot("pi-lifecycle-claim-fail-closed-");
		try {
			const asyncDir = path.join(root, "run-claim-fail-closed");
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-claim-fail-closed",
				mode: "single",
				state: "paused",
				startedAt: 100,
				steps: [{ agent: "worker", status: "paused" }],
				lifecycle: { generation: 0, continuation: { claimToken: "claim-live", claimedAt: 150, ownerPid: 9001 } },
			});
			const alive = recoverStaleLifecycleContinuationClaim(asyncDir, 0, { kill: () => true });
			assert.equal(alive.recovered, false);
			assert.equal(alive.liveness, "alive");
			assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.claimToken, "claim-live");

			const unknown = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
				kill: () => { const error = new Error("unknown") as NodeJS.ErrnoException; error.code = "EPERM"; throw error; },
			});
			assert.equal(unknown.recovered, false);
			assert.equal(unknown.liveness, "unknown");

			writeNormalizedLifecycleStatus(asyncDir, {
				runId: "run-claim-fail-closed",
				mode: "single",
				state: "paused",
				startedAt: 100,
				steps: [{ agent: "worker", status: "paused" }],
				lifecycle: { generation: 0, continuation: { claimToken: "claim-race", claimedAt: 150, ownerPid: 9002 } },
			});
			transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: 0,
				mutate: (status) => ({
					...status,
					lastUpdate: 190,
					lifecycle: withLifecycleContinuation(status, 0, { claimToken: "claim-new", claimedAt: 190, ownerPid: 9003 }),
				}),
			});
			const staleGeneration = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
				kill: (pid) => {
					const error = new Error("dead") as NodeJS.ErrnoException;
					error.code = pid === 9002 ? "ESRCH" : "EPERM";
					throw error;
				},
			});
			assert.equal(staleGeneration.recovered, false);
			assert.equal(readStatus(asyncDir)?.lifecycle?.continuation?.claimToken, "claim-new");

			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-claim-fail-closed",
				mode: "single",
				state: "paused",
				startedAt: 100,
				steps: [{ agent: "worker", status: "paused" }],
				lifecycle: { continuation: { claimToken: "claim-legacy", claimedAt: 150, privateRoot: "/private/root/secret" } },
			}, null, 2), "utf-8");
			const historical = readStatus(asyncDir);
			assert.equal(historical?.lifecycle?.continuation?.claimToken, "claim-legacy");
			assert.equal((historical?.lifecycle?.continuation as Record<string, unknown> | undefined)?.privateRoot, undefined);
			const missingOwner = recoverStaleLifecycleContinuationClaim(asyncDir, 0, {
				kill: () => { throw new Error("should not be called"); },
			});
			assert.equal(missingOwner.recovered, false);
			assert.equal(missingOwner.liveness, "missing-owner");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops persisted stopped-state pids without signaling them", () => {
		const paused = recoverStoppedLifecycleOwnership({
			runId: "run-paused",
			mode: "single",
			state: "paused",
			pid: 999,
			startedAt: 100,
			pause: { kind: "cohort_pause", ownerPid: 999, summary: "wait" },
			steps: [{ agent: "worker", status: "paused" }],
		}, {
			kill: () => true,
		});
		assert.equal(paused.repaired, true);
		assert.equal(paused.pidLiveness, "alive");
		assert.equal(paused.status.pid, undefined);
		assert.equal(paused.status.pause?.ownerPid, undefined);
	});
});
