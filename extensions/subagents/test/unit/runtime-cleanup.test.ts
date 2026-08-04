import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cleanupRuntimeDirs, inspectRuntimeDirs } from "../../src/extension/runtime-cleanup.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setTreeMtime(targetPath: string, mtimeMs: number): void {
	const stat = fs.statSync(targetPath);
	if (stat.isDirectory()) {
		for (const entry of fs.readdirSync(targetPath)) setTreeMtime(path.join(targetPath, entry), mtimeMs);
	}
	const time = new Date(mtimeMs);
	fs.utimesSync(targetPath, time, time);
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function writeRoute(nestedEventsDir: string, rootRunId: string, suffix: string): string {
	const routeDir = path.join(nestedEventsDir, `${rootRunId}-${suffix}`);
	fs.mkdirSync(path.join(routeDir, "events"), { recursive: true });
	fs.mkdirSync(path.join(routeDir, "controls"), { recursive: true });
	fs.writeFileSync(path.join(routeDir, "route.json"), JSON.stringify({ rootRunId, capabilityToken: suffix }, null, 2), "utf-8");
	return routeDir;
}

function createPaths(root: string): { asyncDir: string; nestedRunsDir: string; nestedEventsDir: string } {
	return {
		asyncDir: path.join(root, "async-subagent-runs"),
		nestedRunsDir: path.join(root, "nested-subagent-runs"),
		nestedEventsDir: path.join(root, "nested-subagent-events"),
	};
}

describe("runtime cleanup", () => {
	it("removes stale async dirs while preserving active and paused runs", () => {
		const root = tempRoot("pi-runtime-cleanup-async-");
		const now = 9 * ONE_DAY_MS;
		const paths = createPaths(root);
		try {
			const staleEmptyDir = path.join(paths.asyncDir, "stale-empty");
			fs.mkdirSync(staleEmptyDir, { recursive: true });
			setTreeMtime(staleEmptyDir, now - (2 * ONE_DAY_MS));

			const staleCompleteDir = path.join(paths.asyncDir, "stale-complete");
			writeStatus(staleCompleteDir, {
				runId: "stale-complete",
				mode: "single",
				state: "complete",
				startedAt: now - (10 * ONE_DAY_MS),
				endedAt: now - (8 * ONE_DAY_MS),
			});
			setTreeMtime(staleCompleteDir, now - (8 * ONE_DAY_MS));

			const pausedDir = path.join(paths.asyncDir, "paused-run");
			writeStatus(pausedDir, {
				runId: "paused-run",
				mode: "single",
				state: "paused",
				startedAt: now - (20 * ONE_DAY_MS),
				lastUpdate: now - (20 * ONE_DAY_MS),
			});
			setTreeMtime(pausedDir, now - (20 * ONE_DAY_MS));

			const runningDir = path.join(paths.asyncDir, "running-run");
			writeStatus(runningDir, {
				runId: "running-run",
				mode: "single",
				state: "running",
				startedAt: now - ONE_DAY_MS,
				lastUpdate: now - 1000,
			});

			const result = cleanupRuntimeDirs(paths, { now: () => now, kill: () => true });
			assert.equal(result.removedAsyncDirs, 2);
			assert.equal(fs.existsSync(staleEmptyDir), false);
			assert.equal(fs.existsSync(staleCompleteDir), false);
			assert.equal(fs.existsSync(pausedDir), true);
			assert.equal(fs.existsSync(runningDir), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports runtime dir counts and unreferenced nested event routes", () => {
		const root = tempRoot("pi-runtime-cleanup-counts-");
		const now = Date.now();
		const paths = createPaths(root);
		try {
			writeStatus(path.join(paths.asyncDir, "run-live"), {
				runId: "run-live",
				mode: "single",
				state: "running",
				startedAt: now - 1000,
				lastUpdate: now - 500,
			});
			writeStatus(path.join(paths.nestedRunsDir, "run-live", "child-1"), {
				runId: "child-1",
				mode: "single",
				state: "failed",
				startedAt: now - (10 * ONE_DAY_MS),
				endedAt: now - (8 * ONE_DAY_MS),
			});
			setTreeMtime(path.join(paths.nestedRunsDir, "run-live", "child-1"), now - (8 * ONE_DAY_MS));
			writeRoute(paths.nestedEventsDir, "run-live", "kept");
			const staleRoute = writeRoute(paths.nestedEventsDir, "gone-root", "stale");
			setTreeMtime(staleRoute, now - (2 * ONE_DAY_MS));

			const counts = inspectRuntimeDirs(paths, { now: () => now, kill: () => true });
			assert.equal(counts.topLevelAsyncDirs, 1);
			assert.equal(counts.nestedAsyncDirs, 1);
			assert.equal(counts.activeOrLiveAsyncDirs, 1);
			assert.equal(counts.staleAsyncDirs, 1);
			assert.equal(counts.nestedEventDirs, 2);
			assert.equal(counts.unreferencedNestedEventDirs, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
