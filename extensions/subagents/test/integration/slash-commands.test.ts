import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

type RegisteredSlashCommand = {
	handler(args: string, ctx: unknown): Promise<void>;
	getArgumentCompletions?: (prefix: string) => unknown;
};

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			events: EventBus;
			registerCommand(name: string, spec: RegisteredSlashCommand): void;
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
			sendMessage(message: unknown): void;
		},
		state: {
			baseCwd: string;
			currentSessionId: string | null;
			asyncJobs: Map<string, unknown>;
			cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
			lastUiContext: unknown;
			poller: NodeJS.Timeout | null;
			completionSeen: Map<string, number>;
			watcher: unknown;
			watcherRestartTimer: ReturnType<typeof setTimeout> | null;
			resultFileCoalescer: { schedule(file: string, delayMs?: number): boolean; clear(): void };
		},
	) => void;
}

interface SlashLiveStateModule {
	clearSlashSnapshots?: typeof import("../../src/slash/slash-live-state.ts").clearSlashSnapshots;
}

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

const { registerSlashCommands } = (await import("../../src/slash/slash-commands.ts")) as RegisterSlashCommandsModule;
const { clearSlashSnapshots } = (await import("../../src/slash/slash-live-state.ts")) as SlashLiveStateModule;
const available = true;

function createEventBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
			return () => {
				const current = handlers.get(event) ?? [];
				handlers.set(
					event,
					current.filter((entry) => entry !== handler),
				);
			};
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) handler(data);
		},
	};
}

function createState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
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
}

function createCommandContext(
	overrides: Partial<{
		cwd: string;
		hasUI: boolean;
		custom: (...args: unknown[]) => Promise<unknown>;
		notify: (message: string, type?: string) => void;
		confirm: (title: string, message: string) => Promise<boolean>;
		setStatus: (key: string, text: string | undefined) => void;
		setToolsExpanded: (expanded: boolean) => void;
		sessionManager: unknown;
		modelRegistry: {
			getAvailable: () => Array<{ provider: string; id: string }>;
			find?: (provider: string, id: string) => unknown;
		};
	}> = {},
) {
	return {
		cwd: overrides.cwd ?? process.cwd(),
		hasUI: overrides.hasUI ?? false,
		ui: {
			notify: overrides.notify ?? (() => {}),
			confirm: overrides.confirm ?? (async () => false),
			setStatus: overrides.setStatus ?? (() => {}),
			setToolsExpanded: overrides.setToolsExpanded ?? (() => {}),
			onTerminalInput: () => () => {},
			custom: overrides.custom ?? (async () => undefined),
		},
		modelRegistry: overrides.modelRegistry ?? { getAvailable: () => [], find: () => undefined },
		sessionManager: overrides.sessionManager ?? {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
	};
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-home-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function registerCommands(
	cwd: string,
	sent: unknown[] = [],
	piOverrides: Partial<{
		exec: (command: string) => Promise<unknown>;
	}> = {},
) {
	const commands = new Map<string, RegisteredSlashCommand>();
	const pi = {
		events: createEventBus(),
		registerCommand(name: string, spec: RegisteredSlashCommand) {
			commands.set(name, spec);
		},
		registerShortcut() {},
		sendMessage(message: unknown) {
			sent.push(message);
		},
		...piOverrides,
	};
	registerSlashCommands!(pi as never, createState(cwd));
	return { commands, pi };
}

async function captureSlashCommandParams(
	commandName: string,
	args: string,
	cwd: string,
): Promise<{ params: unknown; notifications: string[] }> {
	return withIsolatedHome(async () => {
		const { commands, pi } = registerCommands(cwd);
		let requestedParams: unknown;
		const notifications: string[] = [];
		pi.events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			pi.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			pi.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: `${commandName} finished` }],
					details: { mode: "single", results: [] },
				},
				isError: false,
			});
		});
		await commands.get(commandName)!.handler(
			args,
			createCommandContext({
				cwd,
				notify: (message) => {
					notifications.push(message);
				},
			}),
		);
		return { params: requestedParams, notifications };
	});
}

describe("slash command registration", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("registers only the approved diagnostic slash commands", async () => {
		await withIsolatedHome(async () => {
			const { commands } = registerCommands(process.cwd());
			assert.deepEqual([...commands.keys()].sort(), ["subagent-cost", "subagents-doctor", "subagents-fleet"]);
		});
	});

	it("does not register removed workflow or mutating profile commands", async () => {
		await withIsolatedHome(async () => {
			const { commands } = registerCommands(process.cwd());
			for (const removed of [
				"run",
				"chain",
				"parallel",
				"run-chain",
				"subagents-load-profile",
				"subagents-refresh-provider-models",
				"subagents-generate-profiles",
				"subagents-status",
				"subagents-models",
				"subagents-profiles",
				"subagents-check-profile",
			]) {
				assert.equal(commands.has(removed), false, `${removed} should not be registered`);
			}
		});
	});
});

describe("subagent cost slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	it("reports parent and child usage from the current session branch", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, RegisteredSlashCommand>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: RegisteredSlashCommand) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};
		const parentUsage = {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		};
		const childUsage = { input: 20, output: 10, cacheRead: 2, cacheWrite: 1, cost: 0.004, turns: 1 };
		const slashChildUsage = { input: 30, output: 15, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 2 };
		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagent-cost")!.handler(
			"",
			createCommandContext({
				sessionManager: {
					getBranch: () => [
						{ type: "message", message: { role: "assistant", usage: parentUsage } },
						{
							type: "message",
							message: {
								role: "toolResult",
								toolName: "subagent",
								details: {
									mode: "single",
									results: [
										{
											agent: "worker",
											task: "fix",
											exitCode: 0,
											messages: [],
											usage: childUsage,
											sessionFile: "/tmp/worker.jsonl",
										},
									],
								},
							},
						},
						{
							type: "custom_message",
							customType: SLASH_RESULT_TYPE,
							details: {
								requestId: "slash-1",
								result: {
									content: [{ type: "text", text: "done" }],
									details: {
										mode: "single",
										results: [{ agent: "reviewer", task: "review", exitCode: 0, messages: [], usage: slashChildUsage }],
									},
								},
							},
						},
					],
				},
			}),
		);

		const output = String((sent[0] as { content?: unknown }).content ?? "");
		assert.match(output, /Parent: ↑100 ↓50 \$0\.0030/);
		assert.match(output, /Child 1 \(worker\): ↑20 ↓10 \$0\.0040/);
		assert.match(output, /Session: \/tmp\/worker\.jsonl/);
		assert.match(output, /Child 2 \(reviewer\): ↑30 ↓15 \$0\.0050/);
		assert.match(output, /Children: ↑50 ↓25 \$0\.0090/);
		assert.match(output, /Total: ↑150 ↓75 \$0\.0120/);
	});
});

describe("subagents-doctor slash command", {
	skip: !available ? "slash-commands.ts not importable" : undefined,
}, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("routes to the doctor tool action", async () => {
		const { params } = await captureSlashCommandParams("subagents-doctor", "", process.cwd());
		assert.deepEqual(params, { action: "doctor" });
	});

	it("routes fleet to the read-only status view", async () => {
		const { params } = await captureSlashCommandParams("subagents-fleet", "", process.cwd());
		assert.deepEqual(params, { action: "status", view: "fleet" });
	});

	it("uses Ctrl+Shift+D for live progress without changing Pi expansion", async () => {
		await withIsolatedHome(async () => {
			const { commands, pi } = registerCommands(process.cwd());
			const statuses: Array<string | undefined> = [];
			let expansionChanges = 0;
			pi.events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
				const requestId = (data as { requestId: string }).requestId;
				pi.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
				pi.events.emit("subagent:slash:update", {
					requestId,
					currentTool: "read",
					toolCount: 2,
					progress: [],
				});
				pi.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
					requestId,
					result: { content: [{ type: "text", text: "done" }], details: { mode: "single", results: [] } },
					isError: false,
				});
			});
			await commands.get("subagents-doctor")!.handler(
				"",
				createCommandContext({
					hasUI: true,
					setStatus: (_key, text) => statuses.push(text),
					setToolsExpanded: () => {
						expansionChanges++;
					},
				}),
			);
			assert.ok(statuses.includes("2 tools read | Ctrl+Shift+D live detail"));
			assert.equal(expansionChanges, 0);
		});
	});

	it("does not register the removed subagents-status overlay command", async () => {
		await withIsolatedHome(async () => {
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) {
					commands.set(name, spec);
				},
				registerShortcut() {},
				sendMessage(_message: unknown) {},
			};

			registerSlashCommands!(pi, createState(process.cwd()));
			assert.equal(commands.has("subagents-status"), false);
		});
	});
});
