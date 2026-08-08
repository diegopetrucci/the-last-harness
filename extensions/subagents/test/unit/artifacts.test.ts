import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	cleanupOldArtifacts,
	getArtifactsDir,
	getProjectArtifactsDir,
	getProjectChainRunsDir,
	getProjectSubagentsDir,
} from "../../src/shared/artifacts.ts";
import { TEMP_ARTIFACTS_DIR } from "../../src/shared/types.ts";

describe("project-local artifact paths", () => {
	it("places generated subagent files under .pi-subagents for a project cwd", () => {
		const cwd = path.join("tmp", "repo");
		assert.equal(getProjectSubagentsDir(cwd), path.join(cwd, ".pi-subagents"));
		assert.equal(getProjectArtifactsDir(cwd), path.join(cwd, ".pi-subagents", "artifacts"));
		assert.equal(getProjectChainRunsDir(cwd), path.join(cwd, ".pi-subagents", "chain-runs"));
		assert.equal(getArtifactsDir(null, cwd), path.join(cwd, ".pi-subagents", "artifacts"));
	});

	it("keeps the session artifact fallback when no project cwd is available", () => {
		const sessionFile = path.join("tmp", "sessions", "parent.jsonl");
		assert.equal(getArtifactsDir(sessionFile), path.join("tmp", "sessions", "subagent-artifacts"));
	});

	it("falls back to the shared temp artifact root without a project cwd or session file", () => {
		assert.equal(getArtifactsDir(null), TEMP_ARTIFACTS_DIR);
	});
});

describe("artifact cleanup", () => {
	function withTempDir(fn: (dir: string) => void): void {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-cleanup-"));
		try {
			fn(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	function agePath(target: string, ageDays: number): void {
		const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
		fs.utimesSync(target, when, when);
	}

	it("removes fully stale nested artifact trees", () => {
		withTempDir((dir) => {
			const tree = path.join(dir, "nested", "progress");
			fs.mkdirSync(tree, { recursive: true });
			const staleFile = path.join(tree, "output.md");
			fs.writeFileSync(staleFile, "stale", "utf8");
			agePath(staleFile, 10);
			agePath(tree, 10);
			agePath(path.dirname(tree), 10);

			cleanupOldArtifacts(dir, 5);

			assert.equal(fs.existsSync(path.join(dir, "nested")), false);
		});
	});

	it("retains nested trees when any descendant is recent", () => {
		withTempDir((dir) => {
			const tree = path.join(dir, "nested", "progress");
			fs.mkdirSync(tree, { recursive: true });
			const staleFile = path.join(tree, "old-output.md");
			const recentFile = path.join(tree, "current-output.md");
			fs.writeFileSync(staleFile, "old", "utf8");
			fs.writeFileSync(recentFile, "recent", "utf8");
			agePath(staleFile, 10);
			agePath(tree, 10);
			agePath(path.dirname(tree), 10);

			cleanupOldArtifacts(dir, 5);

			assert.equal(fs.existsSync(path.join(dir, "nested")), true);
			assert.equal(fs.existsSync(staleFile), true);
			assert.equal(fs.existsSync(recentFile), true);
		});
	});

	it("retains nested trees when a descendant cannot be inspected", { skip: process.platform === "win32" }, () => {
		withTempDir((dir) => {
			const tree = path.join(dir, "nested", "progress");
			fs.mkdirSync(tree, { recursive: true });
			const staleFile = path.join(tree, "output.md");
			fs.writeFileSync(staleFile, "stale", "utf8");
			agePath(staleFile, 10);
			agePath(tree, 10);
			agePath(path.dirname(tree), 10);
			fs.chmodSync(tree, 0o000);

			try {
				cleanupOldArtifacts(dir, 5);
			} finally {
				fs.chmodSync(tree, 0o700);
			}

			assert.equal(fs.existsSync(path.join(dir, "nested")), true);
			assert.equal(fs.existsSync(staleFile), true);
		});
	});

	it("does not traverse or delete external symlink targets when removing stale trees", {
		skip: typeof fs.symlinkSync !== "function" || typeof fs.lutimesSync !== "function",
	}, () => {
		withTempDir((dir) => {
			const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-external-"));
			try {
				const externalFile = path.join(externalRoot, "keep.txt");
				fs.writeFileSync(externalFile, "keep", "utf8");

				const tree = path.join(dir, "nested");
				fs.mkdirSync(tree, { recursive: true });
				const linkPath = path.join(tree, "outside-link");
				fs.symlinkSync(externalRoot, linkPath, "dir");
				agePath(tree, 10);
				fs.lutimesSync(
					linkPath,
					new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
					new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
				);

				cleanupOldArtifacts(dir, 5);

				assert.equal(fs.existsSync(tree), false);
				assert.equal(fs.existsSync(externalRoot), true);
				assert.equal(fs.readFileSync(externalFile, "utf8"), "keep");
			} finally {
				fs.rmSync(externalRoot, { recursive: true, force: true });
			}
		});
	});
});
