import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createAnnotateGitDiffController } = await jiti.import("../extensions/annotate-git-diff/index.ts");

class FakeWindow extends EventEmitter {
	constructor() {
		super();
		this.sent = [];
		this.closeCalls = 0;
	}

	send(js) {
		this.sent.push(js);
	}

	close() {
		this.closeCalls += 1;
		this.emit("closed");
	}
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function parseSentMessages(window) {
	return window.sent.map((js) => {
		assert.match(js, /^window\.__reviewReceive\(/);
		return JSON.parse(js.slice("window.__reviewReceive(".length, -2));
	});
}

async function flushAsyncWork() {
	await new Promise((resolve) => setImmediate(resolve));
}

function createReviewData(overrides = {}) {
	return {
		repoRoot: "/repo",
		files: [
			{
				id: "branch:notes.txt",
				path: "notes.txt",
				worktreeStatus: "modified",
				hasWorkingTreeFile: true,
				inGitDiff: true,
				gitDiff: {
					status: "modified",
					oldPath: "notes.txt",
					newPath: "notes.txt",
					displayPath: "notes.txt",
					hasOriginal: true,
					hasModified: true,
				},
				kind: "text",
				mimeType: null,
			},
		],
		commits: [
			{
				sha: "abc1234",
				shortSha: "abc1234",
				subject: "seed",
				authorName: "TLH",
				authorDate: "2026-01-01T00:00:00.000Z",
				kind: "commit",
			},
		],
		branchBaseRef: "origin/main",
		branchMergeBaseSha: "base1234",
		repositoryHasHead: true,
		...overrides,
	};
}

function createPiHarness() {
	return {
		commands: [],
		events: [],
		sent: [],
		on(name, handler) {
			this.events.push({ name, handler });
		},
		registerCommand(name, config) {
			this.commands.push({ name, config });
		},
		sendUserMessage(message, options) {
			this.sent.push({ message, options });
		},
	};
}

function createContext() {
	const notifications = [];
	const pasted = [];
	return {
		cwd: "/repo",
		notifications,
		pasted,
		ctx: {
			cwd: "/repo",
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
				getEditorText() {
					return "";
				},
				pasteToEditor(text) {
					pasted.push(text);
				},
			},
		},
	};
}

function createController(overrides = {}) {
	const pi = createPiHarness();
	const window = overrides.window ?? new FakeWindow();
	const context = createContext();
	const deps = {
		getReviewWindowData: async () => createReviewData(),
		getCommitFiles: async () => [],
		loadReviewFileContents: async () => ({
			originalContent: "before",
			modifiedContent: "after",
			kind: "text",
			mimeType: null,
			originalExists: true,
			modifiedExists: true,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		}),
		composeReviewPrompt: () => "prompt",
		openReviewWindow: async () => window,
		buildReviewHtml: () => "<html></html>",
		createRepoChangeWatcher: () => ({ dispose() {} }),
		...overrides,
	};
	const controller = createAnnotateGitDiffController(pi, deps);
	return { controller, window, context, deps, pi };
}

test("annotate-git-diff ignores malformed and primitive host messages", async () => {
	let commitRequests = 0;
	let fileRequests = 0;
	const { controller, window, context } = createController({
		getCommitFiles: async () => {
			commitRequests += 1;
			return [];
		},
		loadReviewFileContents: async () => {
			fileRequests += 1;
			throw new Error("should not run");
		},
	});

	await controller.handler("", context.ctx);

	for (const payload of [
		null,
		undefined,
		0,
		"text",
		{},
		{ type: "request-commit", sha: 123 },
		{ type: "request-file", scope: "commits" },
		{
			type: "submit",
			overallComment: "must not submit",
			comments: [
				{
					id: "missing-lines",
					fileId: "branch:notes.txt",
					scope: "branch",
					side: "modified",
					body: "missing required line fields",
				},
			],
		},
	]) {
		assert.doesNotThrow(() => {
			window.emit("message", payload);
		});
	}

	await flushAsyncWork();
	assert.equal(commitRequests, 0);
	assert.equal(fileRequests, 0);
	assert.deepEqual(context.pasted, []);
	assert.deepEqual(parseSentMessages(window), []);
});

test("annotate-git-diff blocks concurrent opens until the first review window resolves", async () => {
	const openDeferred = createDeferred();
	let openCalls = 0;
	const { controller, context, window } = createController({
		openReviewWindow: async () => {
			openCalls += 1;
			return openDeferred.promise;
		},
	});

	const first = controller.handler("", context.ctx);
	await Promise.resolve();
	await controller.handler("", context.ctx);
	assert.equal(openCalls, 1);
	assert.deepEqual(context.notifications, [{ message: "A review window is already open.", level: "warning" }]);

	openDeferred.resolve(window);
	await first;
	assert.equal(context.notifications.at(-1)?.message, "Opened native review window.");
	controller.shutdown();
});

test("annotate-git-diff cancels a pending open on shutdown without blocking a later invocation", async () => {
	const firstOpen = createDeferred();
	const firstWindow = new FakeWindow();
	const secondWindow = new FakeWindow();
	let openCalls = 0;
	let watcherStarts = 0;
	const { controller, context } = createController({
		openReviewWindow: async () => {
			openCalls += 1;
			return openCalls === 1 ? firstOpen.promise : secondWindow;
		},
		createRepoChangeWatcher: () => {
			watcherStarts += 1;
			return { dispose() {} };
		},
	});

	const interrupted = controller.handler("", context.ctx);
	await flushAsyncWork();
	assert.equal(openCalls, 1);

	controller.shutdown();
	await controller.handler("", context.ctx);
	assert.equal(openCalls, 2);
	assert.equal(watcherStarts, 1);
	assert.equal(secondWindow.closeCalls, 0);

	firstOpen.resolve(firstWindow);
	await interrupted;
	assert.equal(firstWindow.closeCalls, 1);
	assert.equal(watcherStarts, 1);
	assert.equal(context.notifications.filter(({ message }) => message === "Opened native review window.").length, 1);

	controller.shutdown();
	assert.equal(secondWindow.closeCalls, 1);
});

test("annotate-git-diff rejects unadvertised commit and file revision requests", async () => {
	let commitRequests = 0;
	let fileRequests = 0;
	const { controller, context, window } = createController({
		getCommitFiles: async () => {
			commitRequests += 1;
			return [];
		},
		loadReviewFileContents: async () => {
			fileRequests += 1;
			throw new Error("should not run");
		},
	});

	await controller.handler("", context.ctx);
	window.emit("message", { type: "request-commit", requestId: "bad-commit", sha: "deadbeef" });
	window.emit("message", {
		type: "request-file",
		requestId: "bad-file",
		fileId: "branch:notes.txt",
		scope: "commits",
		commitSha: "deadbeef",
	});
	window.emit("message", {
		type: "request-file",
		requestId: "wrong-scope",
		fileId: "branch:notes.txt",
		scope: "branch",
		commitSha: "abc1234",
	});

	assert.equal(commitRequests, 0);
	assert.equal(fileRequests, 0);
	assert.deepEqual(parseSentMessages(window), [
		{ type: "commit-error", requestId: "bad-commit", sha: "deadbeef", message: "Unknown commit requested." },
		{
			type: "file-error",
			requestId: "bad-file",
			fileId: "branch:notes.txt",
			scope: "commits",
			commitSha: "deadbeef",
			message: "Unknown commit requested.",
		},
		{
			type: "file-error",
			requestId: "wrong-scope",
			fileId: "branch:notes.txt",
			scope: "branch",
			commitSha: "abc1234",
			message: "Unexpected commit requested for this scope.",
		},
	]);
});

test("annotate-git-diff retries transient commit and file loader failures instead of caching rejections", async () => {
	let commitRequests = 0;
	let fileRequests = 0;
	const { controller, context, window } = createController({
		getCommitFiles: async () => {
			commitRequests += 1;
			if (commitRequests === 1) {
				throw new Error("commit loader unavailable");
			}
			return [
				{
					id: "commit:abc1234:notes.txt",
					path: "notes.txt",
					worktreeStatus: null,
					hasWorkingTreeFile: false,
					inGitDiff: true,
					gitDiff: {
						status: "modified",
						oldPath: "notes.txt",
						newPath: "notes.txt",
						displayPath: "notes.txt",
						hasOriginal: true,
						hasModified: true,
					},
					kind: "text",
					mimeType: null,
				},
			];
		},
		loadReviewFileContents: async (_pi, _repoRoot, file, scope, commitSha) => {
			fileRequests += 1;
			if (fileRequests === 1) {
				throw new Error("file loader unavailable");
			}
			return {
				originalContent: `${file.id}:${scope}:${commitSha}:before`,
				modifiedContent: `${file.id}:${scope}:${commitSha}:after`,
				kind: "text",
				mimeType: null,
				originalExists: true,
				modifiedExists: true,
				originalPreviewUrl: null,
				modifiedPreviewUrl: null,
			};
		},
	});

	await controller.handler("", context.ctx);
	window.emit("message", { type: "request-commit", requestId: "c1", sha: "abc1234" });
	await flushAsyncWork();
	window.emit("message", { type: "request-commit", requestId: "c2", sha: "abc1234" });
	await flushAsyncWork();
	window.emit("message", {
		type: "request-file",
		requestId: "f1",
		fileId: "branch:notes.txt",
		scope: "branch",
		commitSha: null,
	});
	await flushAsyncWork();
	window.emit("message", {
		type: "request-file",
		requestId: "f2",
		fileId: "branch:notes.txt",
		scope: "branch",
		commitSha: null,
	});
	await flushAsyncWork();

	assert.equal(commitRequests, 2);
	assert.equal(fileRequests, 2);
	assert.deepEqual(parseSentMessages(window), [
		{ type: "commit-error", requestId: "c1", sha: "abc1234", message: "commit loader unavailable" },
		{
			type: "commit-data",
			requestId: "c2",
			sha: "abc1234",
			files: [
				{
					id: "commit:abc1234:notes.txt",
					path: "notes.txt",
					worktreeStatus: null,
					hasWorkingTreeFile: false,
					inGitDiff: true,
					gitDiff: {
						status: "modified",
						oldPath: "notes.txt",
						newPath: "notes.txt",
						displayPath: "notes.txt",
						hasOriginal: true,
						hasModified: true,
					},
					kind: "text",
					mimeType: null,
				},
			],
		},
		{
			type: "file-error",
			requestId: "f1",
			fileId: "branch:notes.txt",
			scope: "branch",
			commitSha: null,
			message: "file loader unavailable",
		},
		{
			type: "file-data",
			requestId: "f2",
			fileId: "branch:notes.txt",
			scope: "branch",
			commitSha: null,
			originalContent: "branch:notes.txt:branch:null:before",
			modifiedContent: "branch:notes.txt:branch:null:after",
			kind: "text",
			mimeType: null,
			originalExists: true,
			modifiedExists: true,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		},
	]);
});

test("annotate-git-diff binds file authorization to the current scope and exact commit sha", async () => {
	const commitAFile = {
		id: "commit:abc1234:notes.txt",
		path: "notes.txt",
		worktreeStatus: null,
		hasWorkingTreeFile: false,
		inGitDiff: true,
		gitDiff: {
			status: "modified",
			oldPath: "notes.txt",
			newPath: "notes.txt",
			displayPath: "notes.txt",
			hasOriginal: true,
			hasModified: true,
		},
		kind: "text",
		mimeType: null,
	};
	const snapshotFile = {
		id: "snapshot:guide.md",
		path: "guide.md",
		worktreeStatus: null,
		hasWorkingTreeFile: true,
		inGitDiff: false,
		gitDiff: null,
		kind: "text",
		mimeType: null,
	};
	const loadCalls = [];
	const promptCalls = [];
	const { controller, context, window, pi } = createController({
		getReviewWindowData: async () =>
			createReviewData({
				files: [createReviewData().files[0], snapshotFile],
				commits: [
					...createReviewData().commits,
					{
						sha: "def5678",
						shortSha: "def5678",
						subject: "second",
						authorName: "TLH",
						authorDate: "2026-01-02T00:00:00.000Z",
						kind: "commit",
					},
				],
			}),
		getCommitFiles: async (_pi, _repoRoot, sha) => (sha === "abc1234" ? [commitAFile] : []),
		loadReviewFileContents: async (_pi, _repoRoot, file, scope, commitSha) => {
			loadCalls.push(`${scope}:${commitSha ?? "null"}:${file.id}`);
			return {
				originalContent: `${file.id}:before`,
				modifiedContent: `${file.id}:after`,
				kind: file.kind,
				mimeType: file.mimeType,
				originalExists: true,
				modifiedExists: true,
				originalPreviewUrl: null,
				modifiedPreviewUrl: null,
			};
		},
		composeReviewPrompt: (files, payload) => {
			promptCalls.push({ files, payload });
			return "injected prompt";
		},
	});

	await controller.handler("", context.ctx);
	window.emit("message", { type: "request-commit", requestId: "load-a", sha: "abc1234" });
	await flushAsyncWork();

	const invalidRequests = [
		{
			payload: {
				type: "request-file",
				requestId: "bad-branch-snapshot",
				fileId: "snapshot:guide.md",
				scope: "branch",
				commitSha: null,
			},
			expected: {
				type: "file-error",
				requestId: "bad-branch-snapshot",
				fileId: "snapshot:guide.md",
				scope: "branch",
				commitSha: null,
				message: "Unknown file requested.",
			},
		},
		{
			payload: {
				type: "request-file",
				requestId: "bad-commit-branch",
				fileId: "branch:notes.txt",
				scope: "commits",
				commitSha: "abc1234",
			},
			expected: {
				type: "file-error",
				requestId: "bad-commit-branch",
				fileId: "branch:notes.txt",
				scope: "commits",
				commitSha: "abc1234",
				message: "Unknown file requested.",
			},
		},
		{
			payload: {
				type: "request-file",
				requestId: "bad-branch-commit",
				fileId: "commit:abc1234:notes.txt",
				scope: "branch",
				commitSha: null,
			},
			expected: {
				type: "file-error",
				requestId: "bad-branch-commit",
				fileId: "commit:abc1234:notes.txt",
				scope: "branch",
				commitSha: null,
				message: "Unknown file requested.",
			},
		},
		{
			payload: {
				type: "request-file",
				requestId: "bad-all-commit",
				fileId: "commit:abc1234:notes.txt",
				scope: "all",
				commitSha: null,
			},
			expected: {
				type: "file-error",
				requestId: "bad-all-commit",
				fileId: "commit:abc1234:notes.txt",
				scope: "all",
				commitSha: null,
				message: "Unknown file requested.",
			},
		},
		{
			payload: {
				type: "request-file",
				requestId: "bad-sha",
				fileId: "commit:abc1234:notes.txt",
				scope: "commits",
				commitSha: "def5678",
			},
			expected: {
				type: "file-error",
				requestId: "bad-sha",
				fileId: "commit:abc1234:notes.txt",
				scope: "commits",
				commitSha: "def5678",
				message: "Unknown file requested.",
			},
		},
	];
	for (const { payload } of invalidRequests) {
		window.emit("message", payload);
	}
	await flushAsyncWork();

	window.emit("message", {
		type: "request-file",
		requestId: "ok-all",
		fileId: "snapshot:guide.md",
		scope: "all",
		commitSha: null,
	});
	window.emit("message", {
		type: "request-file",
		requestId: "ok-branch",
		fileId: "branch:notes.txt",
		scope: "branch",
		commitSha: null,
	});
	window.emit("message", {
		type: "request-file",
		requestId: "ok-commit",
		fileId: "commit:abc1234:notes.txt",
		scope: "commits",
		commitSha: "abc1234",
	});
	await flushAsyncWork();

	assert.deepEqual(loadCalls, [
		"all:null:snapshot:guide.md",
		"branch:null:branch:notes.txt",
		"commits:abc1234:commit:abc1234:notes.txt",
	]);
	assert.deepEqual(parseSentMessages(window), [
		{ type: "commit-data", requestId: "load-a", sha: "abc1234", files: [commitAFile] },
		...invalidRequests.map(({ expected }) => expected),
		{
			type: "file-data",
			requestId: "ok-all",
			fileId: "snapshot:guide.md",
			scope: "all",
			commitSha: null,
			originalContent: "snapshot:guide.md:before",
			modifiedContent: "snapshot:guide.md:after",
			kind: "text",
			mimeType: null,
			originalExists: true,
			modifiedExists: true,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		},
		{
			type: "file-data",
			requestId: "ok-branch",
			fileId: "branch:notes.txt",
			scope: "branch",
			commitSha: null,
			originalContent: "branch:notes.txt:before",
			modifiedContent: "branch:notes.txt:after",
			kind: "text",
			mimeType: null,
			originalExists: true,
			modifiedExists: true,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		},
		{
			type: "file-data",
			requestId: "ok-commit",
			fileId: "commit:abc1234:notes.txt",
			scope: "commits",
			commitSha: "abc1234",
			originalContent: "commit:abc1234:notes.txt:before",
			modifiedContent: "commit:abc1234:notes.txt:after",
			kind: "text",
			mimeType: null,
			originalExists: true,
			modifiedExists: true,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		},
	]);

	const submitPayload = { type: "submit", overallComment: "ship it", comments: [], draft: false };
	window.emit("message", submitPayload);
	await flushAsyncWork();
	assert.deepEqual(promptCalls, [
		{
			files: [createReviewData().files[0], snapshotFile, commitAFile],
			payload: submitPayload,
		},
	]);
	// Explicit submit (draft: false) sends via sendUserMessage, not paste.
	assert.deepEqual(context.pasted, []);
	assert.deepEqual(pi.sent, [{ message: "injected prompt", options: { deliverAs: "followUp" } }]);
	assert.equal(
		context.notifications.some(({ message }) => message === "Review feedback sent to the agent."),
		true,
	);
});

test("annotate-git-diff retains pending immutable commit state across review-data refreshes", async () => {
	const workingTreeSha = "__tlh_working_tree__";
	const commitAFile = {
		id: "commit:abc1234:notes.txt",
		path: "notes.txt",
		worktreeStatus: null,
		hasWorkingTreeFile: false,
		inGitDiff: true,
		gitDiff: {
			status: "modified",
			oldPath: "notes.txt",
			newPath: "notes.txt",
			displayPath: "notes.txt",
			hasOriginal: true,
			hasModified: true,
		},
		kind: "text",
		mimeType: null,
	};
	const workingTreeFile = { ...commitAFile, id: `commit:${workingTreeSha}:notes.txt`, worktreeStatus: "modified" };
	const immutableCommitFiles = createDeferred();
	const workingTreeCommitFiles = createDeferred();
	const immutableContents = createDeferred();
	const commitLoads = [];
	let contentLoads = 0;
	const promptCalls = [];
	const reviewData = createReviewData({
		commits: [
			...createReviewData().commits,
			{
				sha: workingTreeSha,
				shortSha: "WT",
				subject: "Uncommitted changes",
				authorName: "",
				authorDate: "",
				kind: "working-tree",
			},
		],
	});
	const { controller, context, window, pi } = createController({
		getReviewWindowData: async () => reviewData,
		getCommitFiles: async (_pi, _repoRoot, sha) => {
			commitLoads.push(sha);
			return sha === "abc1234" ? immutableCommitFiles.promise : workingTreeCommitFiles.promise;
		},
		loadReviewFileContents: async () => {
			contentLoads += 1;
			return immutableContents.promise;
		},
		composeReviewPrompt: (files, payload) => {
			promptCalls.push({ files, payload });
			return "retained immutable prompt";
		},
	});

	await controller.handler("", context.ctx);
	window.emit("message", { type: "request-commit", requestId: "commit-a", sha: "abc1234" });
	window.emit("message", { type: "request-commit", requestId: "working-tree", sha: workingTreeSha });
	await flushAsyncWork();
	window.emit("message", { type: "request-review-data", requestId: "refresh-before-commits" });
	await flushAsyncWork();

	immutableCommitFiles.resolve([commitAFile]);
	workingTreeCommitFiles.resolve([workingTreeFile]);
	await flushAsyncWork();
	assert.deepEqual(
		parseSentMessages(window).filter((message) => message.type === "commit-data"),
		[{ type: "commit-data", requestId: "commit-a", sha: "abc1234", files: [commitAFile] }],
	);

	window.emit("message", {
		type: "request-file",
		requestId: "pending-immutable-file",
		fileId: commitAFile.id,
		scope: "commits",
		commitSha: "abc1234",
	});
	await flushAsyncWork();
	window.emit("message", { type: "request-review-data", requestId: "refresh-before-file" });
	await flushAsyncWork();
	immutableContents.resolve({
		originalContent: "immutable before",
		modifiedContent: "immutable after",
		kind: "text",
		mimeType: null,
		originalExists: true,
		modifiedExists: true,
		originalPreviewUrl: null,
		modifiedPreviewUrl: null,
	});
	await flushAsyncWork();

	window.emit("message", {
		type: "request-file",
		requestId: "cached-immutable-file",
		fileId: commitAFile.id,
		scope: "commits",
		commitSha: "abc1234",
	});
	window.emit("message", {
		type: "request-file",
		requestId: "dropped-working-tree-file",
		fileId: workingTreeFile.id,
		scope: "commits",
		commitSha: workingTreeSha,
	});
	await flushAsyncWork();

	assert.equal(commitLoads.filter((sha) => sha === "abc1234").length, 1);
	assert.equal(contentLoads, 1);
	const messages = parseSentMessages(window);
	for (const requestId of ["pending-immutable-file", "cached-immutable-file"]) {
		assert.equal(
			messages.some((message) => message.type === "file-data" && message.requestId === requestId),
			true,
		);
	}
	assert.deepEqual(
		messages.find((message) => message.requestId === "dropped-working-tree-file"),
		{
			type: "file-error",
			requestId: "dropped-working-tree-file",
			fileId: workingTreeFile.id,
			scope: "commits",
			commitSha: workingTreeSha,
			message: "Unknown file requested.",
		},
	);

	const submitPayload = {
		type: "submit",
		overallComment: "retained review",
		comments: [
			{
				id: "commit-comment",
				fileId: commitAFile.id,
				scope: "commits",
				commitSha: "abc1234",
				commitShort: "abc1234",
				commitKind: "commit",
				side: "file",
				startLine: null,
				endLine: null,
				body: "immutable metadata",
			},
		],
		draft: false,
	};
	window.emit("message", submitPayload);
	await flushAsyncWork();
	assert.deepEqual(promptCalls, [{ files: [reviewData.files[0], commitAFile], payload: submitPayload }]);
	// Explicit submit (draft: false) sends via sendUserMessage, not paste.
	assert.deepEqual(context.pasted, []);
	assert.deepEqual(pi.sent, [{ message: "retained immutable prompt", options: { deliverAs: "followUp" } }]);
	assert.equal(
		context.notifications.some(({ message }) => message === "Review feedback sent to the agent."),
		true,
	);
});

test("annotate-git-diff suppresses stale commit and file results after review-data refreshes", async () => {
	const pendingCommitFiles = createDeferred();
	const pendingFileContents = createDeferred();
	let reviewDataLoads = 0;
	let fileLoads = 0;
	const refreshedData = createReviewData({
		files: [{ ...createReviewData().files[0], inGitDiff: false }],
		commits: [],
	});
	const { controller, context, window } = createController({
		getReviewWindowData: async () => {
			reviewDataLoads += 1;
			return reviewDataLoads === 1 ? createReviewData() : refreshedData;
		},
		getCommitFiles: async () => pendingCommitFiles.promise,
		loadReviewFileContents: async () => {
			fileLoads += 1;
			return pendingFileContents.promise;
		},
	});

	await controller.handler("", context.ctx);
	window.emit("message", { type: "request-commit", requestId: "load-old-commit", sha: "abc1234" });
	window.emit("message", {
		type: "request-file",
		requestId: "load-old-file",
		fileId: "branch:notes.txt",
		scope: "branch",
		commitSha: null,
	});
	await flushAsyncWork();
	window.emit("message", { type: "request-review-data", requestId: "refresh" });
	await flushAsyncWork();

	pendingCommitFiles.resolve([
		{
			id: "commit:abc1234:notes.txt",
			path: "notes.txt",
			worktreeStatus: null,
			hasWorkingTreeFile: false,
			inGitDiff: true,
			gitDiff: {
				status: "modified",
				oldPath: "notes.txt",
				newPath: "notes.txt",
				displayPath: "notes.txt",
				hasOriginal: true,
				hasModified: true,
			},
			kind: "text",
			mimeType: null,
		},
	]);
	pendingFileContents.resolve({
		originalContent: "before",
		modifiedContent: "after",
		kind: "text",
		mimeType: null,
		originalExists: true,
		modifiedExists: true,
		originalPreviewUrl: null,
		modifiedPreviewUrl: null,
	});
	await flushAsyncWork();

	window.emit("message", {
		type: "request-file",
		requestId: "old-commit-file",
		fileId: "commit:abc1234:notes.txt",
		scope: "commits",
		commitSha: "abc1234",
	});
	window.emit("message", {
		type: "request-file",
		requestId: "old-commit-file-all",
		fileId: "commit:abc1234:notes.txt",
		scope: "all",
		commitSha: null,
	});
	window.emit("message", {
		type: "request-file",
		requestId: "old-branch-file",
		fileId: "branch:notes.txt",
		scope: "branch",
		commitSha: null,
	});
	await flushAsyncWork();

	assert.equal(fileLoads, 1);
	assert.deepEqual(parseSentMessages(window), [
		{
			type: "review-data",
			requestId: "refresh",
			files: refreshedData.files,
			commits: refreshedData.commits,
			branchBaseRef: refreshedData.branchBaseRef,
			branchMergeBaseSha: refreshedData.branchMergeBaseSha,
			repositoryHasHead: refreshedData.repositoryHasHead,
		},
		{
			type: "file-error",
			requestId: "old-commit-file",
			fileId: "commit:abc1234:notes.txt",
			scope: "commits",
			commitSha: "abc1234",
			message: "Unknown commit requested.",
		},
		{
			type: "file-error",
			requestId: "old-commit-file-all",
			fileId: "commit:abc1234:notes.txt",
			scope: "all",
			commitSha: null,
			message: "Unknown file requested.",
		},
		{
			type: "file-error",
			requestId: "old-branch-file",
			fileId: "branch:notes.txt",
			scope: "branch",
			commitSha: null,
			message: "Unknown file requested.",
		},
	]);
});

test("annotate-git-diff keeps only the newest overlapping review-data refresh", async () => {
	const refreshOne = createDeferred();
	const refreshTwo = createDeferred();
	const newestData = createReviewData({
		files: [
			{
				id: "snapshot:newest.md",
				path: "newest.md",
				worktreeStatus: null,
				hasWorkingTreeFile: true,
				inGitDiff: false,
				gitDiff: null,
				kind: "text",
				mimeType: null,
			},
		],
		commits: [],
	});
	const staleData = createReviewData({
		files: [
			{
				id: "snapshot:stale.md",
				path: "stale.md",
				worktreeStatus: null,
				hasWorkingTreeFile: true,
				inGitDiff: false,
				gitDiff: null,
				kind: "text",
				mimeType: null,
			},
		],
		commits: [],
	});
	let refreshLoads = 0;
	const { controller, context, window } = createController({
		getReviewWindowData: async () => {
			refreshLoads += 1;
			if (refreshLoads === 1) return createReviewData();
			if (refreshLoads === 2) return refreshOne.promise;
			return refreshTwo.promise;
		},
		loadReviewFileContents: async (_pi, _repoRoot, file) => ({
			originalContent: `${file.id}:before`,
			modifiedContent: `${file.id}:after`,
			kind: file.kind,
			mimeType: file.mimeType,
			originalExists: true,
			modifiedExists: true,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		}),
	});

	await controller.handler("", context.ctx);
	window.emit("message", { type: "request-review-data", requestId: "refresh-1" });
	window.emit("message", { type: "request-review-data", requestId: "refresh-2" });
	refreshTwo.resolve(newestData);
	await flushAsyncWork();
	refreshOne.resolve(staleData);
	await flushAsyncWork();

	window.emit("message", {
		type: "request-file",
		requestId: "newest-file",
		fileId: "snapshot:newest.md",
		scope: "all",
		commitSha: null,
	});
	window.emit("message", {
		type: "request-file",
		requestId: "stale-file",
		fileId: "snapshot:stale.md",
		scope: "all",
		commitSha: null,
	});
	await flushAsyncWork();

	const sentMessages = parseSentMessages(window);
	assert.deepEqual(sentMessages[0], {
		type: "review-data",
		requestId: "refresh-2",
		files: newestData.files,
		commits: newestData.commits,
		branchBaseRef: newestData.branchBaseRef,
		branchMergeBaseSha: newestData.branchMergeBaseSha,
		repositoryHasHead: newestData.repositoryHasHead,
	});
	assert.deepEqual(
		sentMessages.slice(1).sort((left, right) => left.requestId.localeCompare(right.requestId)),
		[
			{
				type: "file-data",
				requestId: "newest-file",
				fileId: "snapshot:newest.md",
				scope: "all",
				commitSha: null,
				originalContent: "snapshot:newest.md:before",
				modifiedContent: "snapshot:newest.md:after",
				kind: "text",
				mimeType: null,
				originalExists: true,
				modifiedExists: true,
				originalPreviewUrl: null,
				modifiedPreviewUrl: null,
			},
			{
				type: "file-error",
				requestId: "stale-file",
				fileId: "snapshot:stale.md",
				scope: "all",
				commitSha: null,
				message: "Unknown file requested.",
			},
		].sort((left, right) => left.requestId.localeCompare(right.requestId)),
	);
});

test("annotate-git-diff suppresses late results after shutdown", async () => {
	const pendingContents = createDeferred();
	const timers = [];
	const { controller, context, window, pi } = createController({
		loadReviewFileContents: async () => pendingContents.promise,
		setTimeoutFn: (fn, _delay) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimeoutFn: () => {},
	});

	await controller.handler("", context.ctx);
	window.emit("message", {
		type: "request-file",
		requestId: "pending",
		fileId: "branch:notes.txt",
		scope: "branch",
		commitSha: null,
	});
	controller.shutdown();
	window.emit("message", { type: "submit", overallComment: "late", comments: [] });
	pendingContents.resolve({
		originalContent: "before",
		modifiedContent: "after",
		kind: "text",
		mimeType: null,
		originalExists: true,
		modifiedExists: true,
		originalPreviewUrl: null,
		modifiedPreviewUrl: null,
	});
	await Promise.resolve();
	for (const timer of timers) timer();
	await Promise.resolve();

	assert.deepEqual(context.pasted, []);
	assert.deepEqual(parseSentMessages(window), []);
	assert.deepEqual(pi.sent, []);
	assert.equal(
		context.notifications.some(({ message }) => message === "Appended review feedback to the editor."),
		false,
	);
	assert.equal(
		context.notifications.some(({ message }) => message === "Review feedback sent to the agent."),
		false,
	);
});

test("annotate-git-diff explicit submit sends via sendUserMessage and does not paste", async () => {
	const { controller, context, window, pi } = createController({
		composeReviewPrompt: () => "explicit prompt",
	});
	await controller.handler("", context.ctx);
	window.emit("message", { type: "submit", overallComment: "explicit comment", comments: [], draft: false });
	await flushAsyncWork();
	assert.deepEqual(context.pasted, []);
	assert.deepEqual(pi.sent, [{ message: "explicit prompt", options: { deliverAs: "followUp" } }]);
	assert.equal(
		context.notifications.some(({ message }) => message === "Review feedback sent to the agent."),
		true,
	);
	assert.equal(
		context.notifications.some(({ message }) => message === "Appended review feedback to the editor."),
		false,
	);
});

test("annotate-git-diff submit payload without draft field defaults to draft (paste) path", async () => {
	const { controller, context, window, pi } = createController({
		composeReviewPrompt: () => "undiscriminated prompt",
	});
	await controller.handler("", context.ctx);
	// A payload with no draft discriminator must NOT fire an agent turn.
	// It routes to the safe paste path instead.
	window.emit("message", { type: "submit", overallComment: "no discriminator", comments: [] });
	await flushAsyncWork();
	assert.deepEqual(context.pasted, ["undiscriminated prompt"]);
	assert.deepEqual(pi.sent, []);
	assert.equal(
		context.notifications.some(({ message }) => message === "Appended review feedback to the editor."),
		true,
	);
	assert.equal(
		context.notifications.some(({ message }) => message === "Review feedback sent to the agent."),
		false,
	);
});

test("annotate-git-diff draft-on-close pastes into editor and does not send", async () => {
	const { controller, context, window, pi } = createController({
		composeReviewPrompt: () => "draft prompt",
	});
	await controller.handler("", context.ctx);
	window.emit("message", { type: "submit", overallComment: "draft comment", comments: [], draft: true });
	await flushAsyncWork();
	assert.deepEqual(context.pasted, ["draft prompt"]);
	assert.deepEqual(pi.sent, []);
	assert.equal(
		context.notifications.some(({ message }) => message === "Appended review feedback to the editor."),
		true,
	);
	assert.equal(
		context.notifications.some(({ message }) => message === "Review feedback sent to the agent."),
		false,
	);
});
