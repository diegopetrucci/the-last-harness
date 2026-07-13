import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	buildReviewEnvelope,
	decideBranchAction,
	parseReviewArgs,
	registerReviewCommand,
} from "../extensions/the-last-harness/review.ts";
import {
	cleanupTempDir,
	createIsolatedProfileFixture,
	makeTempDir as makeSharedTempDir,
	withEnv,
} from "./test-fixture-helpers.mjs";

const reviewEnvRoot = makeSharedTempDir("tlh-review-agent-env-");
const reviewEnvHome = join(reviewEnvRoot, "home");
const reviewEnvAgent = join(reviewEnvRoot, "agent");
const previousReviewPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousReviewHome = process.env.HOME;
mkdirSync(reviewEnvHome, { recursive: true });
mkdirSync(reviewEnvAgent, { recursive: true });
process.env.PI_CODING_AGENT_DIR = reviewEnvAgent;
process.env.HOME = reviewEnvHome;
process.on("exit", () => {
	cleanupTempDir(reviewEnvRoot);
	if (previousReviewPiAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousReviewPiAgentDir;
	}
	if (previousReviewHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = previousReviewHome;
	}
});

/**
 * @param {{
 * 	cwd: string;
 * 	exec: (command: string, args: string[], options: { cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
 * 	hasUI?: boolean;
 * 	custom?: () => Promise<unknown> | unknown;
 * 	editor?: (title: string, prefill?: string) => Promise<string | undefined> | string | undefined;
 * 	branchEntries?: unknown[];
 * }} params
 */
export function createReviewHarness({ cwd, exec, hasUI = true, custom, editor, branchEntries = [] }) {
	let handler;
	/** @type {Array<{ command: string; args: string[]; cwd?: string }>} */
	const execCalls = [];
	/** @type {Array<{ message: string; level: string }>} */
	const notifications = [];
	/** @type {string[]} */
	const sentMessages = [];
	/** @type {Array<{ title: string; prefill?: string }>} */
	const editorCalls = [];
	let customCallCount = 0;

	registerReviewCommand({
		registerCommand(name, command) {
			if (name === "review") {
				handler = command.handler;
			}
		},
		exec: async (command, args, options) => {
			execCalls.push({ command, args, cwd: options?.cwd });
			return exec(command, args, options ?? {});
		},
		sendUserMessage(message) {
			sentMessages.push(message);
		},
	});

	assert.equal(typeof handler, "function", "review command should register a handler");

	return {
		handler,
		execCalls,
		notifications,
		sentMessages,
		editorCalls,
		get customCallCount() {
			return customCallCount;
		},
		ctx: {
			cwd,
			hasUI,
			sessionManager: {
				getBranch: () => branchEntries,
			},
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
				custom: async () => {
					customCallCount += 1;
					return custom ? custom() : true;
				},
				editor: async (title, prefill) => {
					editorCalls.push({ title, prefill });
					return editor ? editor(title, prefill) : undefined;
				},
			},
		},
	};
}

export function makeTempDir(t, prefix) {
	return makeSharedTempDir(prefix, t);
}

export function makePrimaryFixture(t, prefix) {
	return createIsolatedProfileFixture(prefix, { cwd: true, test: t });
}

export function assertRenderedPathLine(message, linePattern, expectedPath) {
	const line = message.split("\n").find((candidate) => linePattern.test(candidate));
	assert.ok(line, `expected a line matching ${linePattern}`);

	const match = line.match(linePattern);
	assert.ok(match, `expected a line matching ${linePattern}`);
	assert.equal(JSON.parse(match[1]), expectedPath);
}

export function assertNoStandaloneLine(message, unexpectedLine) {
	assert.equal(
		message.split("\n").includes(unexpectedLine),
		false,
		`should not render '${unexpectedLine}' as a standalone line`,
	);
}

export function assertStandaloneLineCount(message, expectedLine, expectedCount) {
	assert.equal(
		message.split("\n").filter((line) => line === expectedLine).length,
		expectedCount,
		`expected ${expectedCount} standalone '${expectedLine}' line(s)`,
	);
}

export {
	assert,
	buildReviewEnvelope,
	chmodSync,
	decideBranchAction,
	join,
	mkdirSync,
	parseReviewArgs,
	symlinkSync,
	test,
	withEnv,
	writeFileSync,
};
