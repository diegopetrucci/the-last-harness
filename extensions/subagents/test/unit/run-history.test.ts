import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadRunsForAgent, recordRun } from "../../src/runs/shared/run-history.ts";

let tempDir = "";
let agentDir = "";
let oldAgentDir: string | undefined;

describe("run-history error recording", () => {
	beforeEach(() => {
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-history-"));
		agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("truncates a long error to 300 chars for a failed run", () => {
		const longError = "x".repeat(500);
		recordRun("agent-a", "Do a thing", 1, 100, longError);
		const history = loadRunsForAgent("agent-a");
		assert.equal(history.length, 1);
		assert.equal(history[0]?.status, "error");
		assert.equal(history[0]?.error?.length, 300);
		assert.equal(history[0]?.error, longError.slice(0, 300));
	});

	it("omits the error field for a successful run even when an error string is passed", () => {
		recordRun("agent-b", "Do a thing", 0, 50, "Overloaded");
		const history = loadRunsForAgent("agent-b");
		assert.equal(history.length, 1);
		assert.equal(history[0]?.status, "ok");
		assert.equal("error" in history[0]!, false);
	});

	it("omits the error field for a failed run without an error string", () => {
		recordRun("agent-c", "Do a thing", 1, 50);
		const history = loadRunsForAgent("agent-c");
		assert.equal(history.length, 1);
		assert.equal(history[0]?.status, "error");
		assert.equal("error" in history[0]!, false);
	});

	it("omits the error field for a failed run with an empty error string", () => {
		recordRun("agent-d", "Do a thing", 1, 50, "");
		const history = loadRunsForAgent("agent-d");
		assert.equal(history.length, 1);
		assert.equal(history[0]?.status, "error");
		assert.equal("error" in history[0]!, false);
	});
});
