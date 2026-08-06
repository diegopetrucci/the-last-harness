import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, RESULTS_DIR, SUBAGENT_ASYNC_STARTED_EVENT, resolveTempRootDir } from "../../src/shared/types.ts";
import { consumeChildMessageRequests, steerRequestsDir, writeChildMessageAcceptance } from "../../src/runs/background/control-channel.ts";
import { getArtifactsDir } from "../../src/shared/artifacts.ts";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

interface ExecutorResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		mode?: string;
		runId?: string;
		results?: Array<{
			agent?: string;
			finalOutput?: string;
			outputMode?: string;
			savedOutputPath?: string;
			outputSaveError?: string;
			truncation?: { truncated?: boolean };
			attemptedModels?: string[];
			modelFallbackNotice?: string;
		}>;
		asyncId?: string;
	};
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<ExecutorResult>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!executorMod?.createSubagentExecutor;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function normalizePathForComparison(targetPath: string): string {
	try {
		return fs.realpathSync.native(targetPath);
	} catch {
		return path.resolve(targetPath);
	}
}

function createRecordingEventBus(options: { acknowledgeResults?: boolean } = {}) {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const bus = {
		emitted,
		on(channel: string, handler: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => {
				channelListeners.delete(handler);
				if (channelListeners.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			emitted.push({ channel, payload });
			for (const handler of listeners.get(channel) ?? []) {
				handler(payload);
			}
			if (options.acknowledgeResults && channel === "subagent:result-intercom") {
				const requestId = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : undefined;
				if (typeof requestId === "string") {
					setImmediate(() => bus.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
				}
			}
		},
	};
	return bus;
}

describe("intercom result delivery cutover", { skip: !available ? "executor not importable" : undefined }, () => {
	let tempDir: string;
	let homeDir: string;
	let mockPi: MockPi;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	before(() => {
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		homeDir = createTempDir("pi-subagent-intercom-home-");
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		mockPi = createMockPi();
		mockPi.install();
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom"), { recursive: true });
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "intercom"), { recursive: true });
		fs.writeFileSync(path.join(os.homedir(), ".pi", "agent", "intercom", "config.json"), JSON.stringify({ enabled: true }), "utf-8");
	});

	after(() => {
		mockPi.uninstall();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(homeDir);
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-intercom-result-");
		mockPi.reset();
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom"), { recursive: true });
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "intercom"), { recursive: true });
		fs.writeFileSync(path.join(os.homedir(), ".pi", "agent", "intercom", "config.json"), JSON.stringify({ enabled: true }), "utf-8");
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	async function readMockCallArgs(index: number): Promise<string[]> {
		const deadline = Date.now() + 10_000;
		let callFile: string | undefined;
		while (!callFile) {
			callFile = fs.readdirSync(mockPi.dir)
				.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
				.sort()[index];
			if (callFile || Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(callFile, `expected mock pi call at index ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!fs.existsSync(filePath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for file: ${filePath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	async function waitForAsyncState(runId: string, expected: string, timeoutMs = 10_000): Promise<void> {
		const statusPath = path.join(ASYNC_DIR, runId, "status.json");
		const deadline = Date.now() + timeoutMs;
		while (true) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { state?: string };
				if (status.state === expected) return;
			}
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async state '${expected}' for ${runId}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	async function waitForAsyncStatusPredicate(
		runId: string,
		predicate: (status: { state?: string; currentStep?: number; sessionFile?: string; steps?: Array<{ status?: string; sessionFile?: string; acceptance?: { status?: string } }> }) => boolean,
		label: string,
		timeoutMs = 10_000,
	): Promise<void> {
		const statusPath = path.join(ASYNC_DIR, runId, "status.json");
		const deadline = Date.now() + timeoutMs;
		while (true) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { state?: string; currentStep?: number; sessionFile?: string; steps?: Array<{ status?: string; sessionFile?: string; acceptance?: { status?: string } }> };
				if (predicate(status)) return;
			}
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async status predicate '${label}' for ${runId}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	function readAsyncStatusJson<T>(runId: string): T {
		return JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, runId, "status.json"), "utf-8")) as T;
	}

	async function waitForMockPiCall(index: number, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const callFile = fs.readdirSync(mockPi.dir)
				.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
				.sort()
				.at(index);
			if (callFile) return;
			if (Date.now() > deadline) assert.fail(`Timed out waiting for recorded mock pi call ${index}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	async function waitForRevivedAsyncResult(result: ExecutorResult, timeoutMs = 10_000): Promise<string> {
		const revivedId = result.details?.asyncId;
		assert.ok(revivedId, "expected revived async id");
		const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
		await waitForFile(resultPath, timeoutMs);
		return revivedId;
	}

	function startedMockPiPids(): number[] {
		return fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.map((name) => Number(name.split("-")[2]))
			.filter((pid) => Number.isInteger(pid) && pid > 0);
	}

	function isPidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return !(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH");
		}
	}

	function git(cwd: string, args: string[]): string {
		const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
		}
		return result.stdout.trim();
	}

	function createRepo(prefix: string): string {
		const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		git(repoDir, ["init"]);
		git(repoDir, ["config", "user.email", "tests@example.com"]);
		git(repoDir, ["config", "user.name", "Intercom Result Tests"]);
		fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf-8");
		git(repoDir, ["add", "tracked.txt"]);
		git(repoDir, ["commit", "-m", "initial commit"]);
		return repoDir;
	}

	async function waitFor(predicate: () => boolean, failure: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) assert.fail(failure);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	function makeExecutor(options: { bridgeMode?: "always" | "off"; agents?: ReturnType<typeof makeAgent>[]; acknowledgeResults?: boolean; kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean; worktreeBaseDir?: string } = {}) {
		const events = createRecordingEventBus({ acknowledgeResults: options.acknowledgeResults ?? true });
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
			completionSeen: new Map(),
			watcher: null,
			watcherRestartTimer: null,
			resultFileCoalescer: {
				schedule: () => false,
				clear: () => {},
			},
		};
		const executor = createSubagentExecutor!({
			pi: {
				events,
				getSessionName: () => "orchestrator",
				setSessionName: () => {},
			},
			state,
			config: {
				intercomBridge: { mode: options.bridgeMode ?? "always" },
				...(options.worktreeBaseDir ? { worktreeBaseDir: options.worktreeBaseDir } : {}),
			},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: options.agents ?? [makeAgent("worker")] }),
			kill: options.kill,
		});
		return { executor, events, state };
	}

	async function expectUnsupportedChainRequest(
		executor: ReturnType<typeof makeExecutor>["executor"],
		requestId: string,
		request: Record<string, unknown>,
	) {
		const beforeCalls = mockPi.callCount();
		const result = await executor.execute(
			requestId,
			request,
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Saved chains are deliberately unsupported/);
		assert.match(result.content[0]?.text ?? "", /Omit 'chain'/);
		assert.equal(mockPi.callCount(), beforeCalls);
		return result;
	}

	it("single foreground runs return one native grouped result and emit no result event", async () => {
		mockPi.onCall({ output: "Full child output from worker" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-intercom",
			{ agent: "worker", task: "Summarize feature status" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /^subagent results/m);
		assert.match(result.content[0]?.text ?? "", /Mode: single/);
		assert.match(result.content[0]?.text ?? "", /Status: completed/);
		assert.match(result.content[0]?.text ?? "", /Children: 1 completed/);
		assert.match(result.content[0]?.text ?? "", /1\/1\. worker — completed/);
		assert.match(result.content[0]?.text ?? "", /Summary:\nFull child output from worker/);
		assert.equal((result.content[0]?.text ?? "").match(/Full child output from worker/g)?.length ?? 0, 1);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Delivered .* via intercom/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Run intercom target:/);
		assert.equal(result.details?.results?.[0]?.finalOutput, "Full child output from worker");
	});

	it("bridge-off single runs still use the native grouped result with no listener dependence", async () => {
		mockPi.onCall({ output: "Legacy foreground output" });
		const { executor, events } = makeExecutor({ bridgeMode: "off" });

		const result = await executor.execute(
			"single-no-intercom",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Mode: single/);
		assert.match(result.content[0]?.text ?? "", /Summary:\nLegacy foreground output/);
	});

	it("native foreground results do not wait for acknowledgement listeners", async () => {
		mockPi.onCall({ output: "Unacknowledged foreground output" });
		const { executor, events } = makeExecutor({ acknowledgeResults: false });

		const result = await executor.execute(
			"single-no-ack",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Summary:\nUnacknowledged foreground output/);
	});

	it("native foreground results do not depend on installed intercom package files", async () => {
		fs.rmSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom"), { recursive: true, force: true });
		fs.rmSync(path.join(os.homedir(), ".pi", "agent", "intercom"), { recursive: true, force: true });
		mockPi.onCall({ output: "No package foreground output" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-no-package",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Summary:\nNo package foreground output/);
	});

	it("native foreground summaries honor maxOutput truncation without discarding full structured output", async () => {
		const fullOutput = `first visible line\n${"second hidden line".repeat(700)}\nthird hidden line`;
		mockPi.onCall({ output: fullOutput });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-truncated",
			{ agent: "worker", task: "Summarize lines", maxOutput: { lines: 1, bytes: 100 } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
		assert.match(text, /first visible line/);
		assert.doesNotMatch(text, /second hidden line/);
		assert.equal(result.details?.results?.[0]?.finalOutput, fullOutput);
		assert.equal(result.details?.results?.[0]?.truncation?.truncated, true);
		assert.ok(text.length <= 8_000);
	});

	it("native foreground summaries preserve file-only references even when maxOutput is smaller", async () => {
		mockPi.onCall({ output: "full saved native output\nwith hidden details" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-file-only",
			{
				agent: "worker",
				task: "Write report",
				output: "native-file-only.md",
				outputMode: "file-only",
				maxOutput: { lines: 1, bytes: 10 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /Summary:\nOutput saved to:/);
		assert.match(text, /native-file-only\.md/);
		assert.doesNotMatch(text, /full saved native output/);
		assert.doesNotMatch(text, /\[TRUNCATED:/);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /^Output saved to:/);
		assert.equal(result.details?.results?.[0]?.outputMode, "file-only");
	});

	it("failed file-only foreground runs return truncated native error context without leaking full output", async () => {
		mockPi.onCall({ output: "single visible partial\nsingle hidden partial\nsingle final hidden", stderr: "single terminal failure", exitCode: 1 });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-failed",
			{
				agent: "worker",
				task: "Summarize failure",
				output: "failed-file-only.md",
				outputMode: "file-only",
				maxOutput: { lines: 1, bytes: 100 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true);
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /Mode: single/);
		assert.match(text, /Status: failed/);
		assert.match(text, /Children: 1 failed/);
		assert.match(text, /1\/1\. worker — failed/);
		assert.match(text, /single terminal failure/);
		assert.match(text, /Output:\n\[TRUNCATED: showing first 1 of 3 lines/);
		assert.match(text, /single visible partial/);
		assert.doesNotMatch(text, /single hidden partial/);
		assert.equal(result.details?.results?.[0]?.outputMode, "file-only");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, undefined);
		assert.equal(result.details?.results?.[0]?.finalOutput, "single visible partial\nsingle hidden partial\nsingle final hidden");
	});

	it("file-only output-save failures return truncated output plus an actionable save error", async () => {
		const blockedParent = path.join(tempDir, "not-a-directory");
		fs.writeFileSync(blockedParent, "blocking file", "utf-8");
		const requestedOutput = path.join(blockedParent, "report.md");
		mockPi.onCall({ output: "save visible line\nsave hidden line\nsave final hidden" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-file-save-failed",
			{
				agent: "worker",
				task: "Write report",
				output: requestedOutput,
				outputMode: "file-only",
				maxOutput: { lines: 1, bytes: 100 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /Status: completed/);
		assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
		assert.match(text, /save visible line/);
		assert.doesNotMatch(text, /save hidden line/);
		assert.match(text, /Output file error:/);
		assert.equal(text.match(/Output file error:/g)?.length ?? 0, 1);
		assert.match(text, new RegExp(requestedOutput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.ok(text.indexOf("Output file error:") < text.indexOf("[TRUNCATED:"));
		assert.ok(text.length <= 8_000);
		assert.match(text, /(?:EEXIST|ENOTDIR|not a directory|file already exists)/i);
		assert.equal(result.details?.results?.[0]?.savedOutputPath, undefined);
		assert.ok(result.details?.results?.[0]?.outputSaveError);
		assert.equal(result.details?.results?.[0]?.finalOutput, "save visible line\nsave hidden line\nsave final hidden");
	});

	it("parallel native summaries retain save errors without leaking output beyond maxOutput", async () => {
		const blockedParent = path.join(tempDir, "parallel-not-a-directory");
		fs.writeFileSync(blockedParent, "blocking file", "utf-8");
		const requestedOutput = path.join(blockedParent, "report.md");
		mockPi.onCall({ output: "parallel visible line\nparallel hidden line\nparallel final hidden" });
		const { executor } = makeExecutor();

		const result = await executor.execute(
			"parallel-file-save-failed",
			{
				tasks: [{
					agent: "worker",
					task: "Write parallel report",
					output: requestedOutput,
					outputMode: "file-only",
				}],
				maxOutput: { lines: 1, bytes: 100 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /Status: completed/);
		assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
		assert.match(text, /parallel visible line/);
		assert.doesNotMatch(text, /parallel hidden line/);
		assert.match(text, /Output file error:/);
		const saveError = result.details?.results?.[0]?.outputSaveError;
		assert.ok(saveError);
		assert.match(saveError, new RegExp(blockedParent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(text, new RegExp(saveError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.ok(text.indexOf("Output file error:") < text.indexOf("[TRUNCATED:"));
		assert.equal(result.details?.results?.[0]?.finalOutput, "parallel visible line\nparallel hidden line\nparallel final hidden");
		assert.ok(text.length <= 8_000);
	});

	it("chain native requests fail closed before file-save work starts", async () => {
		const blockedParent = path.join(tempDir, "chain-not-a-directory");
		fs.writeFileSync(blockedParent, "blocking file", "utf-8");
		const requestedOutput = path.join(blockedParent, "report.md");
		const { executor, events } = makeExecutor();

		await expectUnsupportedChainRequest(executor, "chain-file-save-failed", {
			chain: [{
				agent: "worker",
				task: "Write chain report",
				output: requestedOutput,
				outputMode: "file-only",
			}],
			maxOutput: { lines: 1, bytes: 100 },
		});
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.equal(fs.existsSync(requestedOutput), false);
	});

	it("chain multi-step requests fail closed before save diagnostics or child launches", async () => {
		const blockedParent = path.join(tempDir, "oversized-diagnostic-blocker");
		fs.writeFileSync(blockedParent, "blocking file", "utf-8");
		const requestedOutput = path.join(
			blockedParent,
			...Array.from({ length: 70 }, (_, index) => `segment-${index.toString().padStart(2, "0")}`),
			"report.md",
		);
		const { executor, events } = makeExecutor();

		await expectUnsupportedChainRequest(executor, "chain-earlier-save-error", {
			chain: [
				{ agent: "worker", task: "first report", output: requestedOutput, outputMode: "file-only" },
				{ agent: "worker", task: "finish chain" },
			],
			maxOutput: { lines: 1, bytes: 100 },
		});
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.equal(fs.existsSync(requestedOutput), false);
	});

	it("paused foreground runs stay actionable and emit no grouped result event", async () => {
		mockPi.onCall({ delay: 10_000 });
		const { executor, events, state } = makeExecutor({ agents: [makeAgent("slow")] });

		const runPromise = executor.execute(
			"single-pause",
			{ agent: "slow", task: "Wait for interrupt" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const readyDeadline = Date.now() + 5_000;
		while (Date.now() < readyDeadline) {
			if (mockPi.callCount() === 1 && typeof ([...state.foregroundControls.values()][0] as { interrupt?: unknown } | undefined)?.interrupt === "function") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(mockPi.callCount(), 1);

		const interruptResult = await executor.execute(
			"single-pause-interrupt",
			{ action: "interrupt" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(interruptResult.content[0]?.text ?? "", /Interrupt requested for foreground run/);

		const result = await runPromise;
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /^Foreground run [a-z0-9-]+ paused after interrupt \(slow\)\./);
		assert.match(result.content[0]?.text ?? "", /Pause succeeded; this foreground run is paused and waiting for your explicit next action/);
		assert.match(result.content[0]?.text ?? "", /Resume: subagent\(\{ action: "resume", id: "[a-z0-9-]+", message: "\.\.\." \}\)/);
	});

	it("top-level parallel runs bound oversized grouped native output while retaining full details", async () => {
		const fullOutput = `Parallel child output ${"P".repeat(12_000)}`;
		mockPi.onCall({ output: fullOutput });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Mode: parallel/);
		assert.match(result.content[0]?.text ?? "", /Children: 2 completed/);
		assert.match(result.content[0]?.text ?? "", /1\/2\. a — completed/);
		assert.match(result.content[0]?.text ?? "", /2\/2\. b — completed/);
		assert.match(result.content[0]?.text ?? "", /Summary:\nParallel child output/);
		assert.equal(result.details?.results?.every((entry) => entry.finalOutput === fullOutput), true);
		assert.ok((result.content[0]?.text ?? "").length <= 8_000);
	});

	it("top-level parallel native worktree results capture patch artifacts before cleanup", async () => {
		const repoDir = createRepo("pi-intercom-native-worktree-");
		const worktreeBaseDir = path.join(tempDir, "worktrees");
		mockPi.onCall({ output: "Parallel worktree child output", delay: 500 });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a")], worktreeBaseDir });
		const runId = "parallel-native-worktree";

		try {
			const runPromise = executor.execute(
				runId,
				{ tasks: [{ agent: "a", task: "worktree-edit" }], worktree: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);
			await waitFor(() => fs.existsSync(worktreeBaseDir) && fs.readdirSync(worktreeBaseDir).length > 0, `Timed out waiting for worktree base dir: ${worktreeBaseDir}`);
			const worktreeDir = path.join(worktreeBaseDir, fs.readdirSync(worktreeBaseDir)[0]!);
			fs.writeFileSync(path.join(worktreeDir, "tracked.txt"), "updated from worktree\n", "utf-8");
			fs.writeFileSync(path.join(worktreeDir, "new-file.ts"), "export const worktree = true;\n", "utf-8");

			const result = await runPromise;
			const text = result.content[0]?.text ?? "";
			assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
			assert.match(text, /Mode: parallel/);
			assert.match(text, /=== Worktree Changes ===/);
			assert.equal(text.match(/=== Worktree Changes ===/g)?.length ?? 0, 1);
			assert.equal(text.match(/Full patches:/g)?.length ?? 0, 1);
			assert.ok(text.length <= 8_000);
			const patchesDir = text.match(/Full patches: (.+)$/m)?.[1];
			assert.ok(patchesDir, "expected native result to reference patch artifacts");
			assert.ok(fs.existsSync(patchesDir), `expected patches dir to exist: ${patchesDir}`);
			const patchFiles = fs.readdirSync(patchesDir).filter((name) => name.endsWith(".patch"));
			assert.equal(patchFiles.length, 1);
			const patch = fs.readFileSync(path.join(patchesDir, patchFiles[0]!), "utf-8");
			assert.match(patch, /tracked\.txt/);
			assert.match(patch, /new-file\.ts/);
			assert.equal(fs.existsSync(worktreeDir), false, `worktree should be cleaned up: ${worktreeDir}`);
			assert.equal(fs.existsSync(worktreeBaseDir) ? fs.readdirSync(worktreeBaseDir).length : 0, 0);
			assert.equal(git(repoDir, ["branch", "--list", "pi-parallel-*"]).trim(), "");
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});

	it("chain grouping requests fail closed before native summaries are built", async () => {
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b"), makeAgent("c")] });

		await expectUnsupportedChainRequest(executor, "chain-intercom", {
			chain: [
				{ agent: "a", task: "step-a" },
				{ parallel: [{ agent: "b", task: "step-b" }, { agent: "c", task: "step-c" }] },
			],
		});
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
	});

	it("chain fallback requests fail closed before retries or notices are produced", async () => {
		const { executor } = makeExecutor({ agents: [makeAgent("a", { model: "openai/gpt-5-mini" })] });

		await expectUnsupportedChainRequest(executor, "chain-fallback-notice", {
			chain: [{
				agent: "a",
				task: "step-a",
				fallbackModels: ["anthropic/claude-sonnet-4"],
				modelFallbackNotice: "Quota fallback engaged",
			}],
		});
	});

	it("failed chain foreground requests fail closed before any child can fail", async () => {
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		await expectUnsupportedChainRequest(executor, "chain-failed", {
			chain: [{ agent: "a", task: "first failing step" }, { agent: "b", task: "must not run" }],
		});
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
	});

	it("paused chain flows fail closed before detach or grouped receipts are possible", async () => {
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("b")] });

		await expectUnsupportedChainRequest(executor, "chain-detached-intercom", {
			chain: [
				{ agent: "a", task: "ask supervisor" },
				{ agent: "b", task: "must not run" },
			],
		});
		assert.equal(bus.emitted.some((entry) => entry.channel === INTERCOM_DETACH_REQUEST_EVENT), false);
		assert.equal(bus.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
	});

	it("resume action queues a live async follow-up in the native inbox without result intercom", async () => {
		const runId = `resume-live-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
		let acknowledged = false;
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			const sessionFile = path.join(asyncDir, "worker.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				pid: process.pid,
				sessionId: "session-123",
				startedAt: 100,
				lastUpdate: Date.now(),
				sessionFile,
				steps: [{ agent: "worker", status: "running", sessionFile }],
			}, null, 2), "utf-8");
			const { executor, events } = makeExecutor({
				kill: (pid, signal) => {
					kills.push({ pid, signal });
					if (!acknowledged && signal === 0) {
						const requestDir = steerRequestsDir(asyncDir);
						const requestFile = fs.existsSync(requestDir) ? fs.readdirSync(requestDir)[0] : undefined;
						if (requestFile) {
							const request = JSON.parse(fs.readFileSync(path.join(requestDir, requestFile), "utf-8")) as { id: string };
							writeChildMessageAcceptance(asyncDir, { requestId: request.id, type: "resume", status: "accepted", ts: Date.now(), acceptedIndexes: [0] });
							acknowledged = true;
						}
					}
					return true;
				},
			});

			const result = await executor.execute(
				"resume-live",
				{ action: "resume", id: runId, message: "Can you clarify the last change?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", new RegExp(`Resume follow-up accepted for live async run ${runId} child 0`));
			assert.equal(kills.every(({ signal }) => signal === 0), true);
			assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
			const requests = consumeChildMessageRequests(asyncDir);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.type, "resume");
			assert.equal(requests[0]?.targetIndex, 0);
			assert.equal(requests[0]?.message, "Can you clarify the last change?");
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action rejects chain-root continuation requests for live and completed async runs", async () => {
		const sourceRunId = `resume-chain-root-${Date.now()}`;
		const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
		const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
		const sourceSession = path.join(tempDir, "source-child.jsonl");
		try {
			fs.mkdirSync(sourceAsyncDir, { recursive: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(sourceSession, "", "utf-8");
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({
				runId: sourceRunId,
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: 100,
				lastUpdate: 100,
				cwd: tempDir,
				steps: [{ agent: "worker", status: "running", sessionFile: sourceSession }],
			}, null, 2), "utf-8");
			fs.writeFileSync(sourceResultPath, JSON.stringify({
				id: sourceRunId,
				agent: "worker",
				mode: "single",
				success: true,
				state: "complete",
				summary: "root output",
				results: [{ agent: "worker", output: "root output", success: true, sessionFile: sourceSession }],
			}, null, 2), "utf-8");
			const { executor, events } = makeExecutor({ agents: [makeAgent("worker"), makeAgent("reviewer")] });
			const chainRequest = {
				action: "resume",
				id: sourceRunId,
				chain: [{ agent: "reviewer", task: "Review this root result: {previous}" }],
			} as const;

			const liveResult = await executor.execute(
				"resume-chain-root-live",
				chainRequest,
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(liveResult.isError, true);
			assert.match(liveResult.content[0]?.text ?? "", /Saved chains are deliberately unsupported/);
			assert.equal(events.emitted.find((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT), undefined);

			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({
				runId: sourceRunId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");

			const completedResult = await executor.execute(
				"resume-chain-root-complete",
				chainRequest,
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(completedResult.isError, true);
			assert.match(completedResult.content[0]?.text ?? "", /Saved chains are deliberately unsupported/);
			assert.equal(events.emitted.find((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT), undefined);
		} finally {
			fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
			fs.rmSync(sourceResultPath, { force: true });
		}
	});

	it("resume action revives completed async runs with the current session model when the child is unconfigured", async () => {
		mockPi.onCall({ output: "revived answer" });
		const runId = `resume-revive-inherit-model-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "child-session-inherit-model.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("worker", { output: "resume-report.md" })] });

			const result = await executor.execute(
				"resume-revive-inherit-model",
				{ action: "resume", id: runId, message: "What changed?", output: "resume-report.md" },
				new AbortController().signal,
				undefined,
				{
					...makeMinimalCtx(tempDir),
					model: { provider: "github-copilot", id: "gpt-5-mini" },
				},
			);

			assert.equal(result.isError, undefined);
			const revivedId = await waitForRevivedAsyncResult(result);
			const args = await readMockCallArgs(0);
			const modelIndex = args.indexOf("--model");
			assert.notEqual(modelIndex, -1);
			assert.equal(args[modelIndex + 1], "github-copilot/gpt-5-mini");
			const payload = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${revivedId}.json`), "utf-8")) as {
				results?: Array<{ artifactPaths?: { outputPath?: string } }>;
			};
			const artifactOutputPath = payload.results?.[0]?.artifactPaths?.outputPath;
			assert.equal(artifactOutputPath, path.join(getArtifactsDir(null), `${revivedId}_worker_output.md`));
			assert.equal(fs.existsSync(artifactOutputPath), true);
			assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action keeps an explicit model override authoritative when reviving a completed async run", async () => {
		mockPi.onCall({ output: "revived answer" });
		const runId = `resume-revive-explicit-model-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "child-session-explicit-model.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("worker", { model: "openai/gpt-4o" })] });

			const result = await executor.execute(
				"resume-revive-explicit-model",
				{ action: "resume", id: runId, message: "What changed?", model: "anthropic/claude-sonnet-4" },
				new AbortController().signal,
				undefined,
				{
					...makeMinimalCtx(tempDir),
					model: { provider: "github-copilot", id: "gpt-5-mini" },
				},
			);

			assert.equal(result.isError, undefined);
			await waitForRevivedAsyncResult(result);
			const args = await readMockCallArgs(0);
			const modelIndex = args.indexOf("--model");
			assert.notEqual(modelIndex, -1);
			assert.equal(args[modelIndex + 1], "anthropic/claude-sonnet-4");
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives completed multi-child async runs by index", async () => {
		mockPi.onCall({ output: "revived async child b" });
		const runId = `resume-revive-multi-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const firstSession = path.join(tempDir, "child-a.jsonl");
		const secondSession = path.join(tempDir, "child-b.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "parallel",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession },
				],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

			const result = await executor.execute(
				"resume-revive-multi",
				{ action: "resume", id: runId, index: 1, message: "What did b find?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
			assert.match(result.content[0]?.text ?? "", /Agent: b/);
			assert.match(result.content[0]?.text ?? "", new RegExp(secondSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			await waitForRevivedAsyncResult(result);
			const args = await readMockCallArgs(0);
			assert.equal(args[args.indexOf("--session") + 1], secondSession);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives paused async acceptance with paused-ledger provenance and monotonic overrides", async () => {
		mockPi.onCall({ delay: 10_000, output: "paused before acceptance" });
		mockPi.onCall({
			output: [
				"resume complete",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [
						{ id: "criterion-1", status: "satisfied", evidence: "Implemented the requested fix after resume." },
						{ id: "criterion-2", status: "satisfied", evidence: "Included the requested resume note." },
					],
					changedFiles: ["src/example.ts"],
					testsAddedOrUpdated: ["test/integration/intercom-result-delivery.test.ts"],
					commandsRun: [{ command: "npm test -- --runInBand", result: "passed", summary: "mocked" }],
					validationOutput: [],
					residualRisks: ["none"],
					noStagedFiles: true,
					diffSummary: "resumed fix only",
					reviewFindings: ["no blockers"],
					manualNotes: "Resume note included.",
				}),
				"```",
			].join("\n"),
		});
		const { executor } = makeExecutor({ bridgeMode: "off" });
		const started = await executor.execute(
			"resume-paused-acceptance-start",
			{
				agent: "worker",
				task: "Implement the paused acceptance fix",
				async: true,
				acceptance: {
					level: "checked",
					criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope" }],
					stopRules: ["Do not widen scope"],
				},
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const asyncId = started.details?.asyncId;
		assert.ok(asyncId, "expected async id");
		const pausedResumeWaitMs = process.platform === "win32" ? 30_000 : 15_000;
		await waitForAsyncStatusPredicate(
			asyncId,
			(status) => status.state === "running" && status.steps?.[0]?.status === "running" && !!(status.steps[0]?.sessionFile ?? status.sessionFile),
			"running child session",
			pausedResumeWaitMs,
		);

		const interrupted = await executor.execute(
			"resume-paused-acceptance-interrupt",
			{ action: "interrupt", id: asyncId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(interrupted.isError, undefined);
		await waitForAsyncStatusPredicate(
			asyncId,
			(status) => status.state === "paused"
				&& status.steps?.[0]?.status === "paused"
				&& status.steps[0]?.acceptance?.status === "skipped"
				&& !!(status.steps[0]?.sessionFile ?? status.sessionFile),
			"paused skipped acceptance ledger",
			pausedResumeWaitMs,
		);
		// Resume immediately after the first paused status write, before the
		// results payload lands: the paused status itself must already carry the
		// skipped acceptance ledger so the revival keeps the original contract.
		const resumed = await executor.execute(
			"resume-paused-acceptance-resume",
			{
				action: "resume",
				id: asyncId,
				message: "Finish the fix and include the resume note.",
				acceptance: {
					level: "attested",
					criteria: [{ id: "criterion-2", must: "Include the requested resume note" }],
					evidence: ["manual-notes"],
				},
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(
			resumed.isError,
			undefined,
			`resume returned isError; text=${JSON.stringify(resumed.content?.[0]?.text)} details=${JSON.stringify(resumed.details)}`,
		);
		const revivedId = resumed.details?.asyncId;
		assert.ok(revivedId, "expected revived async id");
		await waitForFile(path.join(RESULTS_DIR, `${asyncId}.json`), pausedResumeWaitMs);
		const pausedPayload = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${asyncId}.json`), "utf-8")) as {
			results?: Array<{ acceptance?: { status?: string; effectiveAcceptance?: { explicit?: boolean; level?: string; stopRules?: string[] } } }>;
		};
		assert.equal(pausedPayload.results?.[0]?.acceptance?.status, "skipped");
		assert.equal(pausedPayload.results?.[0]?.acceptance?.effectiveAcceptance?.explicit, true);
		assert.equal(pausedPayload.results?.[0]?.acceptance?.effectiveAcceptance?.level, "checked");
		await waitForFile(path.join(RESULTS_DIR, `${revivedId}.json`), pausedResumeWaitMs);
		const revivedPayload = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${revivedId}.json`), "utf-8")) as {
			results?: Array<{ acceptance?: { status?: string; effectiveAcceptance?: { level?: string; explicit?: boolean; criteria?: Array<{ id?: string }>; evidence?: string[]; stopRules?: string[] } } }>;
		};
		const revivedAcceptance = revivedPayload.results?.[0]?.acceptance?.effectiveAcceptance;
		assert.equal(revivedPayload.results?.[0]?.acceptance?.status, "checked");
		assert.equal(revivedAcceptance?.level, "checked");
		assert.equal(revivedAcceptance?.explicit, true);
		assert.deepEqual(revivedAcceptance?.criteria?.map((criterion) => criterion.id), ["criterion-1", "criterion-2"]);
		assert.equal(revivedAcceptance?.evidence?.includes("changed-files"), true);
		assert.equal(revivedAcceptance?.evidence?.includes("manual-notes"), true);
		assert.deepEqual(revivedAcceptance?.stopRules, ["Do not widen scope"]);
	});

	it("resume action revives a non-currentStep paused parallel child with its skipped acceptance contract intact", async () => {
		mockPi.onCall({ delay: 10_000, output: "parallel child a paused before acceptance" });
		mockPi.onCall({ delay: 10_000, output: "parallel child b paused before acceptance" });
		mockPi.onCall({
			output: [
				"parallel child a resumed",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [
						{ id: "criterion-1", status: "satisfied", evidence: "Preserved the original paused contract." },
						{ id: "criterion-2", status: "satisfied", evidence: "Added the requested resume note." },
					],
					changedFiles: ["test/integration/intercom-result-delivery.test.ts"],
					testsAddedOrUpdated: ["test/integration/intercom-result-delivery.test.ts"],
					commandsRun: [{ command: "npm test -- --runInBand", result: "passed", summary: "mocked" }],
					validationOutput: [],
					residualRisks: ["none"],
					noStagedFiles: true,
					diffSummary: "resumed child only",
					reviewFindings: ["no blockers"],
					manualNotes: "Resume note included.",
				}),
				"```",
			].join("\n"),
		});
		const { executor } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a"), makeAgent("b")] });
		const started = await executor.execute(
			"resume-paused-parallel-acceptance-start",
			{
				tasks: [
					{
						agent: "a",
						task: "Implement child a changes",
						acceptance: {
							level: "checked",
							criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope" }],
							stopRules: ["Do not widen scope"],
						},
					},
					{
						agent: "b",
						task: "Implement child b changes",
						acceptance: {
							level: "checked",
							criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope" }],
							stopRules: ["Do not widen scope"],
						},
					},
				],
				async: true,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const asyncId = started.details?.asyncId;
		assert.ok(asyncId, "expected async id");
		const pausedResumeWaitMs = process.platform === "win32" ? 30_000 : 15_000;
		await waitForAsyncStatusPredicate(
			asyncId,
			(status) => status.state === "running"
				&& status.currentStep === 1
				&& status.steps?.[0]?.status === "running"
				&& status.steps?.[1]?.status === "running",
			"running parallel children with last-started currentStep",
			pausedResumeWaitMs,
		);
		const runningStatus = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, asyncId, "status.json"), "utf-8")) as {
			currentStep?: number;
			steps?: Array<{ acceptance?: { status?: string } }>;
		};
		assert.equal(runningStatus.currentStep, 1);
		assert.equal(runningStatus.steps?.[0]?.acceptance, undefined);
		assert.equal(runningStatus.steps?.[1]?.acceptance, undefined);

		const interrupted = await executor.execute(
			"resume-paused-parallel-acceptance-interrupt",
			{ action: "interrupt", id: asyncId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(interrupted.isError, undefined);
		await waitForAsyncStatusPredicate(
			asyncId,
			(status) => status.state === "paused"
				&& status.steps?.[0]?.status === "paused"
				&& status.steps?.[1]?.status === "paused"
				&& status.steps[0]?.acceptance?.status === "skipped"
				&& status.steps[1]?.acceptance?.status === "skipped",
			"paused parallel skipped acceptance ledgers",
			pausedResumeWaitMs,
		);
		const pausedStatus = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, asyncId, "status.json"), "utf-8")) as {
			steps?: Array<{ acceptance?: { status?: string; effectiveAcceptance?: { explicit?: boolean; level?: string; criteria?: Array<{ id?: string }>; stopRules?: string[] } } }>;
		};
		const pausedNonCurrentAcceptance = pausedStatus.steps?.[0]?.acceptance;
		assert.equal(pausedNonCurrentAcceptance?.status, "skipped");
		assert.equal(pausedNonCurrentAcceptance?.effectiveAcceptance?.explicit, true);
		assert.equal(pausedNonCurrentAcceptance?.effectiveAcceptance?.level, "checked");
		assert.deepEqual(pausedNonCurrentAcceptance?.effectiveAcceptance?.criteria?.map((criterion) => criterion.id), ["criterion-1"]);
		assert.deepEqual(pausedNonCurrentAcceptance?.effectiveAcceptance?.stopRules, ["Do not widen scope"]);

		const resumed = await executor.execute(
			"resume-paused-parallel-acceptance-resume",
			{
				action: "resume",
				id: asyncId,
				index: 0,
				message: "Finish child a and include the resume note.",
				acceptance: {
					level: "attested",
					criteria: [{ id: "criterion-2", must: "Include the requested resume note" }],
					evidence: ["manual-notes"],
				},
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(
			resumed.isError,
			undefined,
			`resume returned isError; text=${JSON.stringify(resumed.content?.[0]?.text)} details=${JSON.stringify(resumed.details)}`,
		);
		const revivedId = resumed.details?.asyncId;
		assert.ok(revivedId, "expected revived async id");
		await waitForFile(path.join(RESULTS_DIR, `${revivedId}.json`), pausedResumeWaitMs);
		const revivedPayload = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${revivedId}.json`), "utf-8")) as {
			results?: Array<{ acceptance?: { status?: string; effectiveAcceptance?: { level?: string; explicit?: boolean; criteria?: Array<{ id?: string }>; evidence?: string[]; stopRules?: string[] } } }>;
		};
		const revivedAcceptance = revivedPayload.results?.[0]?.acceptance?.effectiveAcceptance;
		assert.equal(revivedPayload.results?.[0]?.acceptance?.status, "checked");
		assert.equal(revivedAcceptance?.level, "checked");
		assert.equal(revivedAcceptance?.explicit, true);
		assert.deepEqual(revivedAcceptance?.criteria?.map((criterion) => criterion.id), ["criterion-1", "criterion-2"]);
		assert.equal(revivedAcceptance?.evidence?.includes("changed-files"), true);
		assert.equal(revivedAcceptance?.evidence?.includes("manual-notes"), true);
		assert.deepEqual(revivedAcceptance?.stopRules, ["Do not widen scope"]);
	});

	it("resume action revives completed async runs with concise status receipts", async () => {
		mockPi.onCall({ output: "revived answer" });
		const runId = `resume-revive-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "child-session.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor();

			const result = await executor.execute(
				"resume-revive",
				{ action: "resume", id: runId, message: "What changed?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
			assert.match(result.content[0]?.text ?? "", /Status if needed: subagent\(\{ action: "status"/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /call wait\(\)/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Follow:/);
			const revivedId = result.details?.asyncId;
			assert.ok(revivedId, "expected revived async id");
			const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives a completed foreground child by index", async () => {
		mockPi.onCall({ output: "first child done" });
		mockPi.onCall({ output: "second child done" });
		mockPi.onCall({ output: "revived foreground answer" });
		const { executor } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a"), makeAgent("b")] });

		const original = await executor.execute(
			"foreground-resume-original",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");

		const revived = await executor.execute(
			"foreground-resume",
			{ action: "resume", id: runId, index: 1, message: "Follow up with b" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(revived.isError, undefined);
		assert.match(revived.content[0]?.text ?? "", /Revived foreground subagent from/);
		assert.match(revived.content[0]?.text ?? "", /Agent: b/);
		const reviveArgs = await readMockCallArgs(2);
		const selectedSession = original.details?.results?.[1]?.sessionFile;
		assert.ok(selectedSession, "expected selected child session file");
		assert.equal(reviveArgs[reviveArgs.indexOf("--session") + 1], selectedSession);
		const revivedId = revived.details?.asyncId;
		assert.ok(revivedId, "expected revived async id");
		const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	});

	it("status keeps paused foreground supervisor runs actionable and guided resume revives the same session once", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1_000, jsonl: [events.assistantMessage("should not replay before resume")] },
			],
		});
		mockPi.onCall({ output: "resumed after supervisor reply" });
		const { executor } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		const original = await executor.execute(
			"foreground-paused-status-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.match(original.content[0]?.text ?? "", /paused awaiting supervisor/i);
		assert.match(original.content[0]?.text ?? "", /Resume unchanged: subagent\(\{ action: "resume", id: "/);
		assert.match(original.content[0]?.text ?? "", /Resume with guidance: subagent\(\{ action: "resume", id: ".*", message: "Supervisor replied: \.\.\." \}\)/);
		assert.match(original.content[0]?.text ?? "", /action: "interrupt"/);

		const status = await executor.execute(
			"foreground-paused-status",
			{ action: "status", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const statusText = status.content[0]?.text ?? "";
		assert.match(statusText, /State: remembered foreground/);
		assert.match(statusText, /awaiting supervisor/);
		assert.match(statusText, /Resume unchanged: subagent\(\{ action: "resume", id: ".*", index: 0 \}\)/);
		assert.match(statusText, /Resume with guidance: subagent\(\{ action: "resume", id: ".*", index: 0, message: "Supervisor replied: \.\.\." \}\)/);
		assert.match(statusText, /action: "interrupt"/);
		assert.doesNotMatch(statusText, /Cwd:|Session:|Transcript: \/|Output: \//);

		const revived = await executor.execute(
			"foreground-paused-resume",
			{ action: "resume", id: runId, message: "Supervisor replied: proceed with option A." },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(revived.isError, undefined);
		assert.match(revived.content[0]?.text ?? "", /Revived foreground subagent from/);
		await waitForRevivedAsyncResult(revived);
		const selectedSession = original.details?.results?.[0]?.sessionFile;
		assert.ok(selectedSession, "expected paused child session file");
		const reviveArgs = await readMockCallArgs(1);
		assert.equal(reviveArgs[reviveArgs.indexOf("--session") + 1], selectedSession);
		assert.equal(mockPi.callCount(), 2);
	});

	it("resume unchanged revives a paused foreground supervisor run in the same session", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1_000, jsonl: [events.assistantMessage("should not replay before resume")] },
			],
		});
		mockPi.onCall({ output: "resumed without extra guidance" });
		const { executor } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		const original = await executor.execute(
			"foreground-paused-unchanged-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");

		const revived = await executor.execute(
			"foreground-paused-unchanged-resume",
			{ action: "resume", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(revived.isError, undefined);
		await waitForRevivedAsyncResult(revived);
		const reviveArgs = await readMockCallArgs(1);
		const joinedArgs = reviveArgs.join(" ");
		assert.match(joinedArgs, /Continue under the existing task and instructions\./);
		assert.match(joinedArgs, /pause again rather than guess\./);
	});

	it("persists foreground lifecycle generations through paused and continued transitions", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1_000, jsonl: [events.assistantMessage("should not replay before resume")] },
			],
		});
		mockPi.onCall({ output: "resumed after persisted pause" });
		const { executor } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		const original = await executor.execute(
			"foreground-paused-generation-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		const pausedStatus = readAsyncStatusJson<{
			state?: string;
			pid?: number;
			pause?: { ownerPid?: number };
			lifecycle?: { generation?: number };
			steps?: Array<{ status?: string }>;
		}>(runId);
		assert.equal(pausedStatus.state, "paused");
		assert.equal(pausedStatus.pid, undefined);
		assert.equal(pausedStatus.pause?.ownerPid, undefined);
		assert.equal(pausedStatus.steps?.[0]?.status, "paused");
		assert.ok((pausedStatus.lifecycle?.generation ?? -1) >= 2);

		const revived = await executor.execute(
			"foreground-paused-generation-resume",
			{ action: "resume", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(revived.isError, undefined);
		await waitForRevivedAsyncResult(revived);
		await waitForAsyncState(runId, "continued");
		const continuedStatus = readAsyncStatusJson<{
			state?: string;
			pid?: number;
			pause?: { ownerPid?: number };
			lifecycle?: { generation?: number; continuation?: { claimToken?: string; continuedAt?: number } };
			steps?: Array<{ status?: string }>;
		}>(runId);
		assert.equal(continuedStatus.state, "continued");
		assert.equal(continuedStatus.pid, undefined);
		assert.equal(continuedStatus.pause?.ownerPid, undefined);
		assert.equal(continuedStatus.steps?.[0]?.status, "continued");
		assert.equal(typeof continuedStatus.lifecycle?.continuation?.claimToken, "string");
		assert.equal(typeof continuedStatus.lifecycle?.continuation?.continuedAt, "number");
		assert.ok((continuedStatus.lifecycle?.generation ?? -1) > (pausedStatus.lifecycle?.generation ?? -1));
	});

	it("disk-only paused foreground recovery supports status and unchanged resume", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1_000, jsonl: [events.assistantMessage("should not replay before resume")] },
			],
		});
		mockPi.onCall({ output: "resumed after reload" });
		const first = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		const original = await first.executor.execute(
			"foreground-paused-reload-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.equal(first.events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${runId}.json`)), false);

		const reloaded = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		const status = await reloaded.executor.execute(
			"foreground-paused-reload-status",
			{ action: "status", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(status.content[0]?.text ?? "", /Paused lifecycle actions:/);
		assert.doesNotMatch(status.content[0]?.text ?? "", /Cwd:|Dir:|Session:|\/private|\/tmp\//);

		const revived = await reloaded.executor.execute(
			"foreground-paused-reload-resume",
			{ action: "resume", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(revived.isError, undefined);
		assert.doesNotMatch(revived.content[0]?.text ?? "", /Session:|Async dir:|Intercom target:|\/private|\/tmp\//);
		await waitForRevivedAsyncResult(revived);
		await waitForAsyncState(runId, "continued");

		const persistedStatus = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, runId, "status.json"), "utf-8")) as {
			state?: string;
			pause?: { kind?: string };
			lifecycle?: { continuation?: { continuationRunId?: string; continuedAt?: number; claimToken?: string } };
			pid?: number;
		};
		assert.equal(persistedStatus.state, "continued");
		assert.equal(persistedStatus.pause?.kind, "awaiting_supervisor");
		assert.equal(typeof persistedStatus.lifecycle?.continuation?.continuationRunId, "string");
		assert.equal(typeof persistedStatus.lifecycle?.continuation?.continuedAt, "number");
		assert.equal(persistedStatus.pid, undefined);
		assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${runId}.json`)), false);
		assert.equal(reloaded.events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);

		const duplicate = await reloaded.executor.execute(
			"foreground-paused-reload-resume-duplicate",
			{ action: "resume", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(duplicate.isError, true);
		assert.match(duplicate.content[0]?.text ?? "", /already launched continuation/i);
		assert.doesNotMatch(duplicate.content[0]?.text ?? "", /Session:|Async dir:|Intercom target:|\/private|\/tmp\//);

		const cancelled = await reloaded.executor.execute(
			"foreground-paused-reload-cancel",
			{ action: "interrupt", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(cancelled.isError, true);
		assert.match(cancelled.content[0]?.text ?? "", /already continued/i);
		assert.doesNotMatch(cancelled.content[0]?.text ?? "", /Session:|Async dir:|Intercom target:|\/private|\/tmp\//);
	});

	it("persists paused foreground parallel cohorts with per-index actions and terminal transitions", async () => {
		mockPi.onCall({
			matchArgIncludes: "finish",
			jsonl: [events.assistantMessage("completed sibling")],
		});
		mockPi.onCall({
			matchArgIncludes: "ask supervisor",
			steps: [
				{ delay: 200, jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1_000, jsonl: [events.assistantMessage("should not replay before resume")] },
			],
		});
		mockPi.onCall({
			matchArgIncludes: "keep working",
			steps: [
				{ delay: 50, jsonl: [events.assistantMessage("running sibling partial output")] },
				{ delay: 10_000 },
			],
		});
		mockPi.onCall({
			matchArgIncludes: "start late work",
			steps: [
				{ delay: 50, jsonl: [events.assistantMessage("late-start sibling partial output")] },
				{ delay: 10_000 },
			],
		});
		mockPi.onCall({ matchArgIncludes: "Continue under the existing task and instructions", output: "resumed requester" });
		const first = makeExecutor({ agents: [
			makeAgent("done"),
			makeAgent("ask", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("wait"),
			makeAgent("started"),
			makeAgent("queued"),
		] });
		const original = await first.executor.execute(
			"foreground-parallel-pause-original",
			{ tasks: [
				{ agent: "done", task: "finish" },
				{ agent: "ask", task: "ask supervisor" },
				{ agent: "wait", task: "keep working" },
				{ agent: "started", task: "start late work" },
				{ agent: "queued", task: "must not start" },
			], concurrency: 3 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.equal(mockPi.callCount(), 4);
		await waitForMockPiCall(0);
		const spawnedPids = startedMockPiPids();
		assert.equal(spawnedPids.length, 4);
		assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${runId}.json`)), false);
		await waitForAsyncState(runId, "paused");
		const pausedStatus = readAsyncStatusJson<{
			state?: string;
			steps?: Array<{ status?: string; pause?: { kind?: string } }>;
		}>(runId);
		assert.equal(pausedStatus.state, "paused");
		assert.equal(pausedStatus.steps?.[0]?.status, "completed");
		assert.equal(pausedStatus.steps?.[1]?.status, "paused");
		assert.equal(pausedStatus.steps?.[1]?.pause?.kind, "awaiting_supervisor");
		assert.equal(pausedStatus.steps?.[2]?.status, "paused");
		assert.equal(pausedStatus.steps?.[2]?.pause?.kind, "cohort_pause");
		assert.equal(pausedStatus.steps?.[3]?.status, "paused");
		assert.equal(pausedStatus.steps?.[3]?.pause?.kind, "cohort_pause");
		assert.equal(pausedStatus.steps?.[4]?.status, "pending");
		const requesterIndex = pausedStatus.steps?.findIndex((step) => step.pause?.kind === "awaiting_supervisor") ?? -1;
		const cohortIndexes = pausedStatus.steps?.flatMap((step, index) => step.pause?.kind === "cohort_pause" ? [index] : []) ?? [];
		assert.equal(requesterIndex, 1);
		assert.deepEqual(cohortIndexes, [2, 3]);
		assert.equal(first.events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.deepEqual(spawnedPids.map((pid) => isPidAlive(pid)), [false, false, false, false]);

		const second = makeExecutor({ agents: [
			makeAgent("done"),
			makeAgent("ask", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("wait"),
			makeAgent("started"),
			makeAgent("queued"),
		] });
		const status = await second.executor.execute(
			"foreground-parallel-pause-status",
			{ action: "status", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const statusText = status.content[0]?.text ?? "";
		assert.match(statusText, new RegExp(`Resume unchanged: subagent\\(\\{ action: "resume", id: ".*", index: ${requesterIndex} \\}\\)`));
		for (const cohortIndex of cohortIndexes) {
			assert.match(statusText, new RegExp(`Resume child: subagent\\(\\{ action: "resume", id: ".*", index: ${cohortIndex}, message: "\\.\\.\\." \\}\\)`));
			assert.match(statusText, new RegExp(`Cancel child: subagent\\(\\{ action: "interrupt", id: ".*", index: ${cohortIndex} \\}\\)`));
		}

		const cancelled = await second.executor.execute(
			"foreground-parallel-pause-cancel",
			{ action: "interrupt", id: runId, index: cohortIndexes[0] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(cancelled.isError, undefined);
		assert.match(cancelled.content[0]?.text ?? "", new RegExp(`child ${cohortIndexes[0]}`));
		const afterCancel = readAsyncStatusJson<{
			steps?: Array<{ status?: string }>;
		}>(runId);
		assert.equal(afterCancel.steps?.[0]?.status, "completed");
		assert.equal(afterCancel.steps?.[requesterIndex]?.status, "paused");
		assert.equal(afterCancel.steps?.[cohortIndexes[0]]?.status, "cancelled");
		assert.equal(afterCancel.steps?.[cohortIndexes[1]]?.status, "paused");

		const revived = await second.executor.execute(
			"foreground-parallel-pause-resume",
			{ action: "resume", id: runId, index: requesterIndex },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(revived.isError, undefined);
		await waitForRevivedAsyncResult(revived);

		const third = makeExecutor({ agents: [
			makeAgent("done"),
			makeAgent("ask", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("wait"),
			makeAgent("started"),
			makeAgent("queued"),
		] });
		const duplicate = await third.executor.execute(
			"foreground-parallel-pause-duplicate",
			{ action: "resume", id: runId, index: requesterIndex },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(duplicate.isError, true);
		assert.match(duplicate.content[0]?.text ?? "", /already launched (?:its )?continuation|already continued/i);
		await waitForAsyncStatusPredicate(runId, (status) => status.steps?.[requesterIndex]?.status === "continued", "continued paused foreground parallel child");
		const continuedStatus = readAsyncStatusJson<{
			state?: string;
			steps?: Array<{ status?: string }>;
		}>(runId);
		assert.equal(typeof continuedStatus.steps?.[0]?.status, "string");
		assert.equal(continuedStatus.steps?.[requesterIndex]?.status, "continued");
		assert.equal(continuedStatus.steps?.[cohortIndexes[0]]?.status, "cancelled");
		assert.equal(continuedStatus.steps?.[cohortIndexes[1]]?.status, "paused");
		assert.equal(typeof continuedStatus.steps?.[4]?.status, "string");
	});

	it("chain status flows fail closed before paused foreground recovery exists", async () => {
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("b")] });

		const original = await expectUnsupportedChainRequest(executor, "foreground-detached-chain-status-original", {
			chain: [{ agent: "a", task: "ask supervisor" }, { agent: "b", task: "must not run" }],
		});
		assert.equal(original.details?.runId, undefined);
		assert.equal(bus.emitted.some((entry) => entry.channel === INTERCOM_DETACH_REQUEST_EVENT), false);
	});

	it("chain parallel pause requests fail closed before any paused status is persisted", async () => {
		const first = makeExecutor({ agents: [
			makeAgent("a"),
			makeAgent("done"),
			makeAgent("ask", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("wait"),
			makeAgent("started"),
			makeAgent("queued"),
			makeAgent("later"),
		] });
		const original = await expectUnsupportedChainRequest(first.executor, "foreground-chain-parallel-pause-original", {
			chain: [
				{ agent: "a", task: "first" },
				{ parallel: [
					{ agent: "done", task: "parallel finish" },
					{ agent: "ask", task: "parallel ask supervisor" },
					{ agent: "wait", task: "parallel keep working" },
					{ agent: "started", task: "parallel start late work" },
					{ agent: "queued", task: "parallel must not start" },
				], concurrency: 3 },
				{ agent: "later", task: "later must not run" },
			],
		});
		assert.equal(original.details?.runId, undefined);
		assert.equal(first.events.emitted.some((entry) => entry.channel === INTERCOM_DETACH_REQUEST_EVENT), false);
		assert.equal(first.events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
	});

	it("sequential chain pause requests fail closed before continuation state is created", async () => {
		const first = makeExecutor({ agents: [makeAgent("a"), makeAgent("b", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("c")] });
		const original = await expectUnsupportedChainRequest(first.executor, "foreground-sequential-chain-pause-original", {
			chain: [{ agent: "a", task: "first" }, { agent: "b", task: "ask supervisor" }, { agent: "c", task: "must not run" }],
		});
		assert.equal(original.details?.runId, undefined);
		assert.equal(first.events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
	});

	it("interrupt makes a paused foreground supervisor run terminal, idempotent, and artifact-preserving", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1_000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const { executor } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		const original = await executor.execute(
			"foreground-paused-cancel-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		const outputPath = original.details?.results?.[0]?.artifactPaths?.outputPath;
		assert.ok(outputPath, "expected preserved output artifact path");
		const pausedStatus = readAsyncStatusJson<{
			state?: string;
			pid?: number;
			pause?: { ownerPid?: number };
			lifecycle?: { generation?: number };
		}>(runId);
		assert.equal(pausedStatus.state, "paused");
		assert.equal(pausedStatus.pid, undefined);
		assert.equal(pausedStatus.pause?.ownerPid, undefined);

		const cancelled = await executor.execute(
			"foreground-paused-cancel",
			{ action: "interrupt", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(cancelled.isError, undefined);
		assert.match(cancelled.content[0]?.text ?? "", /Cancelled paused foreground run/);
		assert.equal(fs.existsSync(outputPath!), true);
		const cancelledStatus = readAsyncStatusJson<{
			state?: string;
			pid?: number;
			pause?: { ownerPid?: number };
			cancel?: { cancelledAt?: number };
			lifecycle?: { generation?: number };
		}>(runId);
		assert.equal(cancelledStatus.state, "cancelled");
		assert.equal(cancelledStatus.pid, undefined);
		assert.equal(cancelledStatus.pause?.ownerPid, undefined);
		assert.equal(typeof cancelledStatus.cancel?.cancelledAt, "number");
		assert.ok((cancelledStatus.lifecycle?.generation ?? -1) > (pausedStatus.lifecycle?.generation ?? -1));

		const cancelledAgain = await executor.execute(
			"foreground-paused-cancel-again",
			{ action: "interrupt", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(cancelledAgain.isError, undefined);
		assert.match(cancelledAgain.content[0]?.text ?? "", /already cancelled/i);

		const resumed = await executor.execute(
			"foreground-paused-cancelled-resume",
			{ action: "resume", id: runId, message: "Follow up" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(resumed.isError, true);
		assert.match(resumed.content[0]?.text ?? "", /cancelled while paused/);

		const status = await executor.execute(
			"foreground-paused-cancel-status",
			{ action: "status", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(status.content[0]?.text ?? "", /cancelled/);
		assert.match(status.content[0]?.text ?? "", /kept its existing artifacts/i);
	});

	it("bounds paused-cancel lifecycle failures without leaking raw status paths", async () => {
		const defaultTempRoot = resolveTempRootDir({
			env: { ...process.env, PI_SUBAGENTS_TEMP_ROOT: "   " },
		});
		assert.notEqual(
			normalizePathForComparison(path.dirname(ASYNC_DIR)),
			normalizePathForComparison(defaultTempRoot),
			"malformed-status fixture must not target the live uid-scoped temp root",
		);

		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need direction" })] },
				{ delay: 1_000, jsonl: [events.assistantMessage("received pong")] },
			],
		});
		const { executor } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		let runDir: string | undefined;
		let statusPath: string | undefined;
		let resultPath: string | undefined;
		try {
			const original = await executor.execute(
				"foreground-paused-cancel-failure-original",
				{ agent: "a", task: "ask supervisor" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			const runId = original.details?.runId;
			if (typeof runId === "string" && runId.length > 0) {
				runDir = path.join(ASYNC_DIR, runId);
				statusPath = path.join(runDir, "status.json");
				resultPath = path.join(RESULTS_DIR, `${runId}.json`);
			}
			assert.ok(runId, "expected foreground run id");
			assert.ok(statusPath, "expected foreground status path");
			fs.writeFileSync(statusPath, "{not-json", "utf-8");

			const cancelled = await executor.execute(
				"foreground-paused-cancel-failure",
				{ action: "interrupt", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(cancelled.isError, true);
			assert.match(cancelled.content[0]?.text ?? "", /Foreground supervisor lifecycle update failed/);
			assert.doesNotMatch(cancelled.content[0]?.text ?? "", /Failed to (inspect|read|parse) async status file/);
			assert.doesNotMatch(cancelled.content[0]?.text ?? "", /status\.json|\/tmp\/|\/private\//);
		} finally {
			if (resultPath) fs.rmSync(resultPath, { force: true });
			if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("resume action keeps exact foreground validation errors over async prefix matches", async () => {
		const base = `exact-invalid-${Date.now()}`;
		const asyncSession = path.join(tempDir, "async-exact-prefix.jsonl");
		fs.writeFileSync(asyncSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, `${base}-async`);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: `${base}-async`,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(base, {
				runId: base,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed" }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-foreground",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Foreground run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action keeps exact async validation errors over foreground prefix matches", async () => {
		const base = `exact-invalid-async-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-exact-prefix.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, base);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: base,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-async",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Async run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports async ambiguity even when foreground has one prefix match", async () => {
		const base = `namespace-ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-prefix.jsonl");
		const firstAsyncSession = path.join(tempDir, "async-a.jsonl");
		const secondAsyncSession = path.join(tempDir, "async-b.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(firstAsyncSession, "", "utf-8");
		fs.writeFileSync(secondAsyncSession, "", "utf-8");
		const firstAsyncDir = path.join(ASYNC_DIR, `${base}-async-a`);
		const secondAsyncDir = path.join(ASYNC_DIR, `${base}-async-b`);
		try {
			for (const [asyncDir, runId, sessionFile] of [[firstAsyncDir, `${base}-async-a`, firstAsyncSession], [secondAsyncDir, `${base}-async-b`, secondAsyncSession]] as const) {
				fs.mkdirSync(asyncDir, { recursive: true });
				fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
					runId,
					mode: "single",
					state: "complete",
					startedAt: 100,
					lastUpdate: 200,
					cwd: tempDir,
					steps: [{ agent: "a", status: "complete", sessionFile }],
				}, null, 2), "utf-8");
			}
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-async-prefix-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Ambiguous subagent run id prefix/);
		} finally {
			fs.rmSync(firstAsyncDir, { recursive: true, force: true });
			fs.rmSync(secondAsyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports ambiguous ids across remembered foreground and async runs", async () => {
		const base = `ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground.jsonl");
		const asyncSession = path.join(tempDir, "async.jsonl");
		const asyncId = `${base}-async`;
		const foregroundId = `${base}-foreground`;
		const asyncDir = path.join(ASYNC_DIR, asyncId);
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(asyncSession, "", "utf-8");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: asyncId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(foregroundId, {
				runId: foregroundId,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /ambiguous between foreground run/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("mixed foreground outcomes produce failed native grouped status and counts", async () => {
		mockPi.onCall({ matchArgIncludes: "task-a", output: "Parallel child success", exitCode: 0 });
		mockPi.onCall({ matchArgIncludes: "task-b", output: "Parallel child failure", stderr: "Parallel child failure", exitCode: 1 });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-mixed-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Status: failed/);
		assert.match(result.content[0]?.text ?? "", /Children: 1 completed, 1 failed/);
		assert.match(result.content[0]?.text ?? "", /1\/2\. a — completed/);
		assert.match(result.content[0]?.text ?? "", /2\/2\. b — failed/);
		assert.match(result.content[0]?.text ?? "", /Parallel child failure/);
	});
});
