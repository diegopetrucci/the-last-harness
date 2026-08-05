import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	ASYNC_RESUME_INTERRUPT_SIGNAL,
	interruptLiveAsyncResumeTarget,
	resolveAsyncResumeTarget,
} from "../../src/runs/background/async-resume.ts";

function writeJson(filePath: string, value: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("live async resume interrupt", () => {
	it("interrupts a resolved live async child before the caller sends a follow-up", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-async-resume-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-live");
			writeJson(path.join(asyncDir, "status.json"), {
				runId: "run-live",
				mode: "single",
				state: "running",
				pid: process.pid,
				cwd: root,
				startedAt: 100,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			});
			const target = resolveAsyncResumeTarget({ id: "run-live" }, { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(target.kind, "live");

			const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
			const state = {
				asyncJobs: new Map([["run-live", {
					asyncId: "run-live",
					asyncDir,
					status: "running" as const,
					pid: process.pid,
					activityState: "needs_attention" as const,
					updatedAt: 100,
				}]]),
			};

			const result = interruptLiveAsyncResumeTarget({
				target,
				state,
				now: () => 1234,
				resultsDir,
				kill: (pid, signal) => {
					kills.push({ pid, signal });
					return true;
				},
			});

			assert.deepEqual(result, { ok: true, asyncId: "run-live" });
			assert.deepEqual(kills, [{ pid: process.pid, signal: 0 }, { pid: process.pid, signal: ASYNC_RESUME_INTERRUPT_SIGNAL }]);
			assert.equal(state.asyncJobs.get("run-live")?.activityState, undefined);
			assert.equal(state.asyncJobs.get("run-live")?.updatedAt, 1234);
			// The portable control request is dropped regardless of the signal path.
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still interrupts a live async child when the OS signal is unavailable (ENOSYS on Windows)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-async-resume-enosys-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-live");
			writeJson(path.join(asyncDir, "status.json"), {
				runId: "run-live",
				mode: "single",
				state: "running",
				pid: process.pid,
				cwd: root,
				startedAt: 100,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			});
			const target = resolveAsyncResumeTarget({ id: "run-live" }, { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(target.kind, "live");

			const state = {
				asyncJobs: new Map([["run-live", {
					asyncId: "run-live",
					asyncDir,
					status: "running" as const,
					pid: process.pid,
					activityState: "needs_attention" as const,
					updatedAt: 100,
				}]]),
			};

			const result = interruptLiveAsyncResumeTarget({
				target,
				state,
				now: () => 7,
				resultsDir,
				kill: () => {
					const error = new Error("kill ENOSYS") as NodeJS.ErrnoException;
					error.code = "ENOSYS";
					throw error;
				},
			});

			// The signal failed, but the file-based control inbox makes the interrupt succeed.
			assert.deepEqual(result, { ok: true, asyncId: "run-live" });
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), true);
			assert.equal(state.asyncJobs.get("run-live")?.activityState, undefined);
			assert.equal(state.asyncJobs.get("run-live")?.updatedAt, 7);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not report success or leave a stale request when the runner pid is gone", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-async-resume-esrch-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-live");
			writeJson(path.join(asyncDir, "status.json"), {
				runId: "run-live",
				mode: "single",
				state: "running",
				pid: 12345,
				cwd: root,
				startedAt: 100,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			});
			const target = resolveAsyncResumeTarget({ id: "run-live" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: (_pid, signal) => {
					if (signal === 0) return true;
					const error = new Error("missing process") as NodeJS.ErrnoException;
					error.code = "ESRCH";
					throw error;
				},
			});
			assert.equal(target.kind, "live");

			const result = interruptLiveAsyncResumeTarget({
				target,
				resultsDir,
				kill: () => {
					const error = new Error("missing process") as NodeJS.ErrnoException;
					error.code = "ESRCH";
					throw error;
				},
			});

			assert.deepEqual(result, { ok: false, message: "Async run run-live is live but no interrupt-capable runner pid was found." });
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
			const repairedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(repairedStatus.state, "failed");
			assert.equal(fs.existsSync(path.join(resultsDir, "run-live.json")), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
