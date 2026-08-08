import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { default: theLastHarness } = await jiti.import("../extensions/the-last-harness.ts");

class ScriptedEventStream {
	#queue = [];
	#waiting = [];
	#done = false;
	#resolveResult;
	#result = new Promise((resolve) => {
		this.#resolveResult = resolve;
	});

	push(event) {
		if (this.#done) return;
		if (event.type === "done" || event.type === "error") {
			this.#done = true;
			this.#resolveResult(event.type === "done" ? event.message : event.error);
		}
		const waiter = this.#waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.#queue.push(event);
	}

	end() {
		this.#done = true;
		for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator]() {
		while (true) {
			if (this.#queue.length > 0) yield this.#queue.shift();
			else if (this.#done) return;
			else {
				const next = await new Promise((resolve) => this.#waiting.push(resolve));
				if (next.done) return;
				yield next.value;
			}
		}
	}

	result() {
		return this.#result;
	}
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...options,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
	return result.stdout.trim();
}

function createHermeticGitEnv(root) {
	const gitHome = join(root, "git-home");
	const xdgConfigHome = join(root, "git-xdg");
	const globalGitConfig = join(root, "gitconfig");
	mkdirSync(gitHome, { recursive: true });
	mkdirSync(xdgConfigHome, { recursive: true });
	writeFileSync(globalGitConfig, "", "utf8");
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (
			key === "GIT_CONFIG" ||
			key.startsWith("GIT_CONFIG_") ||
			[
				"GIT_DIR",
				"GIT_WORK_TREE",
				"GIT_COMMON_DIR",
				"GIT_INDEX_FILE",
				"GIT_OBJECT_DIRECTORY",
				"GIT_ALTERNATE_OBJECT_DIRECTORIES",
				"GIT_CEILING_DIRECTORIES",
				"GIT_DISCOVERY_ACROSS_FILESYSTEM",
				"GIT_NAMESPACE",
				"GIT_ATTR_NOSYSTEM",
				"GIT_ATTRIBUTES_FILE",
				"GIT_OPTIONAL_LOCKS",
			].includes(key)
		) {
			delete env[key];
		}
	}
	return {
		...env,
		HOME: gitHome,
		XDG_CONFIG_HOME: xdgConfigHome,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: globalGitConfig,
		GIT_TERMINAL_PROMPT: "0",
	};
}

function createHermeticRuntimeEnv(fixture, overrides = {}) {
	return {
		...fixture.gitEnv,
		PI_CODING_AGENT_DIR: fixture.agentDir,
		PATH: fixture.fakebin,
		...overrides,
	};
}

function setupFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "tlh-hermetic-workflow-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	const fakebin = join(root, "fakebin");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	mkdirSync(fakebin, { recursive: true });

	mkdirSync(join(workspace, "src"), { recursive: true });
	writeFileSync(join(workspace, "src", "index.mjs"), "export const existing = () => 'existing';\n");
	mkdirSync(join(workspace, "test"), { recursive: true });
	writeFileSync(
		join(workspace, "test", "existing.test.mjs"),
		`import test from "node:test";\nimport assert from "node:assert/strict";\nimport { existing } from "../src/index.mjs";\n\ntest("existing export works", () => {\n\tassert.equal(existing(), "existing");\n});\n`,
	);
	writeFileSync(join(workspace, "package.json"), '{\n  "type": "module"\n}\n');
	writeFileSync(join(workspace, "README.md"), "# Fixture\n");

	const gitEnv = createHermeticGitEnv(root);
	const emptyHooksDir = join(root, "empty-git-hooks");
	mkdirSync(emptyHooksDir, { recursive: true });

	run("git", ["init"], { cwd: workspace, env: gitEnv });
	run("git", ["checkout", "-b", "main"], { cwd: workspace, env: gitEnv });
	run("git", ["config", "user.email", "tests@example.com"], { cwd: workspace, env: gitEnv });
	run("git", ["config", "user.name", "TLH Tests"], { cwd: workspace, env: gitEnv });
	run("git", ["add", "."], { cwd: workspace, env: gitEnv });
	run(
		"git",
		["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${emptyHooksDir}`, "commit", "--no-verify", "-m", "fixture"],
		{
			cwd: workspace,
			env: gitEnv,
		},
	);

	writeFakeTk(join(fakebin, "tk"));
	const gnProbe = join(root, "fake-gn-probed");
	writeFileSync(join(fakebin, "gn"), `#!/bin/sh\nprintf probed > ${JSON.stringify(gnProbe)}\nexit 1\n`);
	chmodSync(join(fakebin, "gn"), 0o755);
	symlinkSync(process.execPath, join(fakebin, "node"));
	const gitPath = run("which", ["git"]);
	symlinkSync(gitPath, join(fakebin, "git"));

	return { root, home, agentDir, workspace, fakebin, gitEnv, gnProbe };
}

function writeFakeTk(path) {
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			'import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
			'import { join } from "node:path";',
			"",
			"const cwd = process.cwd();",
			'const ticketsDir = join(cwd, ".tickets");',
			"const args = process.argv.slice(2);",
			"const command = args[0];",
			"",
			"function ensureTicketsDir() {",
			"  mkdirSync(ticketsDir, { recursive: true });",
			"}",
			"",
			"function ticketPath(id) {",
			"  return join(ticketsDir, id + '.json');",
			"}",
			"",
			"function load(id) {",
			"  const file = ticketPath(id);",
			"  if (!existsSync(file)) {",
			"    process.stderr.write('ticket not found: ' + id + '\\n');",
			"    process.exit(1);",
			"  }",
			"  return JSON.parse(readFileSync(file, 'utf8'));",
			"}",
			"",
			"function save(ticket) {",
			"  ensureTicketsDir();",
			"  writeFileSync(ticketPath(ticket.id), JSON.stringify(ticket, null, 2) + '\\n');",
			"}",
			"",
			"if (!command || command === 'help' || command === '--help' || command === '-h') {",
			"  process.stdout.write('Usage: tk <command> [args]\\n');",
			"  process.exit(0);",
			"}",
			"",
			"if (command === 'create') {",
			"  ensureTicketsDir();",
			"  const title = args[1] ?? 'untitled';",
			"  const description = args[args.indexOf('-d') + 1] ?? '';",
			"  const acceptance = args[args.indexOf('--acceptance') + 1] ?? '';",
			"  const id = 'tlh-test-1';",
			"  const ticket = { id, title, description, acceptance, status: 'open' };",
			"  save(ticket);",
			"  process.stdout.write(id + '\\n');",
			"  process.exit(0);",
			"}",
			"",
			"if (command === 'show') {",
			"  const ticket = load(args[1]);",
			"  process.stdout.write(['---', 'id: ' + ticket.id, 'status: ' + ticket.status, '---', '# ' + ticket.title, ticket.description, '', 'Acceptance:', ticket.acceptance].join('\\n') + '\\n');",
			"  process.exit(0);",
			"}",
			"",
			"if (command === 'close') {",
			"  const ticket = load(args[1]);",
			"  ticket.status = 'closed';",
			"  save(ticket);",
			"  process.stdout.write(ticket.id + '\\n');",
			"  process.exit(0);",
			"}",
			"",
			"if (command === 'delete') {",
			"  rmSync(ticketPath(args[1]), { force: true });",
			"  process.stdout.write(args[1] + '\\n');",
			"  process.exit(0);",
			"}",
			"",
			"process.stderr.write('unsupported tk command: ' + command + '\\n');",
			"process.exit(1);",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

function registerScriptedProviders(modelRegistry, scriptState) {
	const models = {
		anthropic: ["claude-opus-5", "claude-sonnet-4-6"],
		"openai-codex": ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"],
	};
	for (const [provider, ids] of Object.entries(models)) {
		modelRegistry.registerProvider(provider, {
			baseUrl: `https://${provider}.example.invalid/v1`,
			apiKey: "scripted",
			api: "openai-completions",
			streamSimple(model) {
				return scriptedStream(model, scriptState);
			},
			models: ids.map((id) => ({
				id,
				name: `${provider}/${id}`,
				api: "openai-completions",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			})),
		});
	}
}

function currentRole() {
	return process.env.PI_SUBAGENT_CHILD_AGENT?.trim() || "architect";
}

function scriptedRoleForModel(model) {
	if (model.provider === "anthropic" && model.id === "claude-opus-5") {
		return "architect";
	}
	if (model.provider === "openai-codex" && model.id === "gpt-5.4") {
		return "developer";
	}
	if (model.provider === "openai-codex" && (model.id === "gpt-5.5" || model.id === "gpt-5.6-sol")) {
		return "code-reviewer";
	}
	return currentRole();
}

function scriptedStream(model, scriptState) {
	const stream = new ScriptedEventStream();
	const role = scriptedRoleForModel(model);
	const key = role;
	const step = scriptState.steps.get(key) ?? 0;
	scriptState.steps.set(key, step + 1);
	scriptState.providerCalls.push({ role, step, model: `${model.provider}/${model.id}` });

	queueMicrotask(() => {
		const output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		try {
			stream.push({ type: "start", partial: output });
			const response = scriptedResponseFor(role, step, scriptState.ticketId);
			if (response.type === "text") {
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				output.content[0].text = response.text;
				stream.push({ type: "text_delta", contentIndex: 0, delta: response.text, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: response.text, partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
			} else {
				output.stopReason = "toolUse";
				const toolCall = {
					type: "toolCall",
					id: `${role}-tool-${step}`,
					name: response.toolName,
					arguments: response.args,
				};
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(response.args), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
				stream.push({ type: "done", reason: "toolUse", message: output });
			}
			stream.end();
		} catch (error) {
			output.stopReason = "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
		}
	});

	return stream;
}

function scriptedResponseFor(role, step, ticketId) {
	if (role === "architect") {
		if (step === 0) {
			return {
				type: "text",
				text: "Plan:\n1. Create a tk ticket for the approved change.\n2. Delegate implementation to developer.\n3. Run an independent code review.\n4. Close and delete the ticket, then report validation. Reply with exactly approved to continue.",
			};
		}
		if (step === 1) {
			return {
				type: "tool",
				toolName: "bash",
				args: {
					command: `tk create "Add greeting helper" -d "Add formatGreeting(name), export it from src/index.mjs, and cover it with a node:test." --acceptance "Run node test/greeting.test.mjs"`,
				},
			};
		}
		if (step === 2) {
			return {
				type: "tool",
				toolName: "subagent",
				args: {
					agent: "developer",
					prompt: `Implement ticket ${ticketId}. Run tk show ${ticketId} first. Only add the greeting helper export and its targeted test. Run the ticket-scoped validation command from the ticket.`,
				},
			};
		}
		if (step === 3) {
			return {
				type: "tool",
				toolName: "subagent",
				args: {
					agent: "code-reviewer",
					prompt: `Review ticket ${ticketId} against the current diff. Inspect git status, git diff --no-color, and the relevant files.`,
				},
			};
		}
		if (step === 4) {
			return {
				type: "tool",
				toolName: "bash",
				args: {
					command: `tk close ${ticketId} && tk delete ${ticketId}`,
				},
			};
		}
		return {
			type: "text",
			text: "Implemented the approved plan via the normal architect workflow: created a tk ticket, delegated implementation to developer, completed an independent code review with no blockers, ran the ticket-scoped test, and cleaned up the closed ticket.",
		};
	}

	if (role === "developer") {
		if (step === 0) {
			return { type: "tool", toolName: "bash", args: { command: `tk show ${ticketId}` } };
		}
		if (step === 1) {
			return {
				type: "tool",
				toolName: "write",
				args: {
					path: "src/greeting.mjs",
					content: "export function formatGreeting(name) {\n\treturn `Hello, ${name}!`;\n}\n",
				},
			};
		}
		if (step === 2) {
			return {
				type: "tool",
				toolName: "write",
				args: {
					path: "src/index.mjs",
					content: "export const existing = () => 'existing';\nexport { formatGreeting } from './greeting.mjs';\n",
				},
			};
		}
		if (step === 3) {
			return {
				type: "tool",
				toolName: "write",
				args: {
					path: "test/greeting.test.mjs",
					content: `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatGreeting } from "../src/index.mjs";\n\ntest("formatGreeting formats the provided name", () => {\n\tassert.equal(formatGreeting("Ada"), "Hello, Ada!");\n});\n`,
				},
			};
		}
		if (step === 4) {
			return { type: "tool", toolName: "bash", args: { command: "node test/greeting.test.mjs" } };
		}
		return {
			type: "text",
			text: `Summary:\n- Added formatGreeting(name) in src/greeting.mjs.\n- Exported the helper from src/index.mjs.\n- Added test/greeting.test.mjs and ran node test/greeting.test.mjs successfully.`,
		};
	}

	if (step === 0) {
		return {
			type: "tool",
			toolName: "bash",
			args: { command: "git status --short --untracked-files=all && printf '\n---DIFF---\n' && git diff --no-color" },
		};
	}
	if (step === 1) {
		return {
			type: "tool",
			toolName: "read",
			args: { path: "src/greeting.mjs" },
		};
	}
	if (step === 2) {
		return {
			type: "tool",
			toolName: "read",
			args: { path: "test/greeting.test.mjs" },
		};
	}
	return {
		type: "text",
		text: "No blockers. Reviewed git status, the full unstaged diff, src/greeting.mjs, and test/greeting.test.mjs. Residual risk is low because the change is isolated and covered by a targeted node:test.",
	};
}

function flattenText(message) {
	return (message?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function createLoggingExtension(logs, prompts, role) {
	return function loggingExtension(pi) {
		pi.on("tool_call", (event) => {
			logs.push({ role, toolName: event.toolName, input: structuredClone(event.input) });
		});
		pi.on("before_agent_start", (event) => {
			prompts.push({ role, systemPrompt: event.systemPrompt });
			return event;
		});
	};
}

function sortedToolNames(toolInfos) {
	return toolInfos.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
}

const EXPECTED_ACTIVE_TOOLS = {
	architect: ["bash", "edit", "find", "grep", "ls", "read", "subagent", "write"],
	developer: ["bash", "edit", "find", "grep", "ls", "read", "write"],
	"code-reviewer": ["bash", "find", "grep", "ls", "read"],
};

test("hermetic core architect workflow runs end-to-end with deterministic subagent boundaries", {
	skip: process.platform === "win32",
}, async (t) => {
	const poisonedGitRoot = mkdtempSync(join(tmpdir(), "tlh-hermetic-git-poison-"));
	t.after(() => rmSync(poisonedGitRoot, { recursive: true, force: true }));
	const poisonedHome = join(poisonedGitRoot, "home");
	const poisonedXdg = join(poisonedGitRoot, "xdg");
	const poisonedHooks = join(poisonedGitRoot, "hooks");
	mkdirSync(poisonedHome, { recursive: true });
	mkdirSync(poisonedXdg, { recursive: true });
	mkdirSync(poisonedHooks, { recursive: true });
	writeFileSync(
		join(poisonedHome, ".gitconfig"),
		`[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[core]\n\thooksPath = ${poisonedHooks}\n`,
		"utf8",
	);
	writeFileSync(join(poisonedHooks, "pre-commit"), "#!/bin/sh\nexit 42\n", { encoding: "utf8", mode: 0o755 });
	const fixture = await withEnv(
		{
			HOME: poisonedHome,
			XDG_CONFIG_HOME: poisonedXdg,
			GIT_CONFIG_COUNT: "3",
			GIT_CONFIG_KEY_0: "commit.gpgsign",
			GIT_CONFIG_VALUE_0: "true",
			GIT_CONFIG_KEY_1: "gpg.program",
			GIT_CONFIG_VALUE_1: "false",
			GIT_CONFIG_KEY_2: "core.hooksPath",
			GIT_CONFIG_VALUE_2: poisonedHooks,
		},
		async () => setupFixture(t),
	);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(fixture.agentDir, "auth.json"),
		allowModelNetwork: false,
	});
	const modelRegistry = new ModelRegistry(modelRuntime);
	const scriptState = { steps: new Map(), ticketId: "tlh-test-1", providerCalls: [] };
	registerScriptedProviders(modelRegistry, scriptState);

	const toolLogs = [];
	const promptLogs = [];
	const sessionRoles = [];

	const fakeGnResult = spawnSync("gn", ["help", "plan"], {
		env: createHermeticRuntimeEnv(fixture),
		encoding: "utf8",
	});
	assert.equal(fakeGnResult.status, 1, fakeGnResult.stderr || fakeGnResult.stdout || String(fakeGnResult.error));
	assert.equal(existsSync(fixture.gnProbe), true);

	const subagentTool = defineTool({
		name: "subagent",
		label: "Subagent",
		description: "Run a deterministic child session for the requested TLH minor agent.",
		parameters: {
			type: "object",
			properties: {
				agent: { type: "string" },
				prompt: { type: "string" },
				model: { type: "string" },
				agentScope: { type: "string" },
				context: { type: "string" },
			},
			required: ["agent", "prompt"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const role = params.agent;
			assert.match(role, /^(developer|code-reviewer)$/);
			const subagentEnv = createHermeticRuntimeEnv(fixture, {
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_CHILD_AGENT: role,
			});
			const { session } = await withEnv(subagentEnv, async () => {
				const resourceLoader = new DefaultResourceLoader({
					cwd: fixture.workspace,
					agentDir: fixture.agentDir,
					extensionFactories: [theLastHarness, createLoggingExtension(toolLogs, promptLogs, role)],
					noContextFiles: true,
					noPromptTemplates: true,
					noSkills: true,
					noThemes: true,
					systemPrompt: "You are running a deterministic hermetic workflow test.",
					appendSystemPrompt: [],
				});
				await resourceLoader.reload();
				const modelKey = params.model?.includes("/")
					? params.model.split("/")
					: role === "developer"
						? ["openai-codex", "gpt-5.4"]
						: ["openai-codex", "gpt-5.6-sol"];
				// Strip thinking suffix (e.g. ':max') appended by TLH before registry lookup
				const registryId = modelKey[1]?.includes(":") ? modelKey[1].split(":")[0] : modelKey[1];
				const model = modelRegistry.find(modelKey[0], registryId);
				assert.ok(model, `expected subagent model ${modelKey.join("/")}`);
				return createAgentSession({
					cwd: fixture.workspace,
					agentDir: fixture.agentDir,
					modelRuntime,
					model,
					resourceLoader,
					sessionManager: SessionManager.inMemory(fixture.workspace),
					tools: EXPECTED_ACTIVE_TOOLS[role],
					customTools: [subagentTool],
					sessionStartEvent: { reason: "startup", sessionName: role },
				});
			});
			try {
				await withEnv(
					{
						...subagentEnv,
						NODE_TEST_CONTEXT: undefined,
					},
					async () => {
						await session.prompt(params.prompt);
					},
				);
				const finalAssistant = session.state.messages.filter((message) => message.role === "assistant").at(-1);
				sessionRoles.push({
					role,
					systemPrompt: session.systemPrompt,
					activeTools: [...session.getActiveToolNames()].sort((left, right) => left.localeCompare(right)),
					allTools: sortedToolNames(session.getAllTools()),
					toolResults: session.state.messages.filter((message) => message.role === "toolResult"),
				});
				return {
					content: [{ type: "text", text: flattenText(finalAssistant) }],
					details: { role },
				};
			} finally {
				session.dispose();
			}
		},
	});

	const resourceLoader = new DefaultResourceLoader({
		cwd: fixture.workspace,
		agentDir: fixture.agentDir,
		extensionFactories: [theLastHarness, createLoggingExtension(toolLogs, promptLogs, "architect")],
		noContextFiles: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
		systemPrompt: "You are running a deterministic hermetic workflow test.",
		appendSystemPrompt: [],
	});
	await resourceLoader.reload();
	const architectModel = modelRegistry.find("anthropic", "claude-opus-5");
	assert.ok(architectModel);

	const { session } = await withEnv(createHermeticRuntimeEnv(fixture), async () =>
		createAgentSession({
			cwd: fixture.workspace,
			agentDir: fixture.agentDir,
			modelRuntime,
			model: architectModel,
			resourceLoader,
			sessionManager: SessionManager.create(fixture.workspace, join(fixture.agentDir, "sessions")),
			tools: EXPECTED_ACTIVE_TOOLS.architect,
			customTools: [subagentTool],
			sessionStartEvent: { reason: "startup", sessionName: "architect" },
		}),
	);

	try {
		sessionRoles.push({
			role: "architect",
			systemPrompt: session.systemPrompt,
			activeTools: [...session.getActiveToolNames()].sort((left, right) => left.localeCompare(right)),
			allTools: sortedToolNames(session.getAllTools()),
		});
		await withEnv({ ...createHermeticRuntimeEnv(fixture), NODE_TEST_CONTEXT: undefined }, async () => {
			await session.prompt(
				"Add a reusable formatGreeting(name) helper exported from src/index.mjs, cover it with a targeted node:test, and use the normal TLH architect workflow.",
			);
			await session.prompt("approved");
		});

		const architectMessages = session.state.messages.filter((message) => message.role === "assistant");
		const finalArchitectText = flattenText(architectMessages.at(-1));
		const gitStatus = run("git", ["status", "--short", "--untracked-files=all"], {
			cwd: fixture.workspace,
			env: fixture.gitEnv,
		});
		const gitDiff = run("git", ["diff", "--no-color"], { cwd: fixture.workspace, env: fixture.gitEnv });
		const validationResult = spawnSync(process.execPath, ["--test", "test/greeting.test.mjs"], {
			cwd: fixture.workspace,
			encoding: "utf8",
		});
		assert.equal(
			validationResult.status,
			0,
			validationResult.stderr || validationResult.stdout || String(validationResult.error),
		);
		const ticketsDir = join(fixture.workspace, ".tickets");
		const diagnostics = JSON.stringify(
			{
				toolLogs,
				providerCalls: scriptState.providerCalls,
				sessionRoles,
				promptLogCount: promptLogs.length,
				gitStatus,
				gitDiff,
			},
			null,
			2,
		);

		assert.match(finalArchitectText, /created a tk ticket/i, diagnostics);
		assert.match(finalArchitectText, /independent code review/i, diagnostics);
		assert.equal(validationResult.status, 0);
		assert.match(gitStatus, /M src\/index\.mjs/, diagnostics);
		assert.match(gitStatus, /\?\? src\/greeting\.mjs/, diagnostics);
		assert.match(gitStatus, /\?\? test\/greeting\.test\.mjs/, diagnostics);
		assert.doesNotMatch(gitStatus, /\.tickets/, diagnostics);
		assert.equal(
			readFileSync(join(fixture.workspace, "src", "greeting.mjs"), "utf8"),
			"export function formatGreeting(name) {\n\treturn `Hello, ${name}!`;\n}\n",
		);
		assert.match(readFileSync(join(fixture.workspace, "src", "index.mjs"), "utf8"), /formatGreeting/);
		assert.match(gitDiff, /\+export \{ formatGreeting \} from '\.\/greeting\.mjs';/, diagnostics);
		assert.equal(
			scriptState.providerCalls.some((entry) => entry.role === "architect" && entry.step === 1),
			true,
			diagnostics,
		);
		assert.equal(
			scriptState.providerCalls.some((entry) => entry.role === "architect" && entry.step === 2),
			true,
			diagnostics,
		);
		assert.equal(
			scriptState.providerCalls.some((entry) => entry.role === "code-reviewer"),
			true,
			diagnostics,
		);
		assert.equal(
			scriptState.providerCalls.some(
				(entry) => entry.role === "code-reviewer" && entry.model === "openai-codex/gpt-5.6-sol",
			),
			true,
			diagnostics,
		);
		const architectTools = toolLogs.filter((entry) => entry.role === "architect");
		const developerTools = toolLogs.filter((entry) => entry.role === "developer");
		const reviewerTools = toolLogs.filter((entry) => entry.role === "code-reviewer");
		const architectRun = sessionRoles.find((entry) => entry.role === "architect");
		const developerRun = sessionRoles.find((entry) => entry.role === "developer");
		const reviewerRun = sessionRoles.find((entry) => entry.role === "code-reviewer");
		assert.deepEqual(architectRun?.activeTools, EXPECTED_ACTIVE_TOOLS.architect, diagnostics);
		assert.deepEqual(developerRun?.activeTools, EXPECTED_ACTIVE_TOOLS.developer, diagnostics);
		assert.deepEqual(reviewerRun?.activeTools, EXPECTED_ACTIVE_TOOLS["code-reviewer"], diagnostics);
		assert.equal(architectRun?.allTools.includes("write"), true, diagnostics);
		assert.equal(architectRun?.allTools.includes("edit"), true, diagnostics);
		assert.equal(developerRun?.allTools.includes("write"), true, diagnostics);
		assert.equal(developerRun?.allTools.includes("edit"), true, diagnostics);
		assert.equal(reviewerRun?.allTools.includes("write"), false, diagnostics);
		assert.equal(reviewerRun?.allTools.includes("edit"), false, diagnostics);
		assert.equal(
			architectTools.some((entry) => ["write", "edit"].includes(entry.toolName)),
			false,
			diagnostics,
		);
		assert.equal(
			reviewerTools.some((entry) => ["write", "edit"].includes(entry.toolName)),
			false,
			diagnostics,
		);
		assert.equal(
			developerTools.some((entry) => entry.toolName === "write" && entry.input.path === "src/greeting.mjs"),
			true,
			diagnostics,
		);
		assert.equal(
			developerTools.some((entry) => entry.toolName === "write" && entry.input.path === "test/greeting.test.mjs"),
			true,
			diagnostics,
		);
		assert.equal(
			architectTools.some((entry) => entry.toolName === "subagent" && entry.input.agent === "developer"),
			true,
			diagnostics,
		);
		assert.equal(
			architectTools.some((entry) => entry.toolName === "subagent" && entry.input.agent === "code-reviewer"),
			true,
			diagnostics,
		);
		assert.equal(
			reviewerTools.some((entry) => ["write", "edit", "subagent"].includes(entry.toolName)),
			false,
			diagnostics,
		);
		assert.equal(
			reviewerTools.some((entry) => entry.toolName === "read" && entry.input.path === "src/greeting.mjs"),
			true,
			diagnostics,
		);
		assert.equal(
			reviewerTools.some((entry) => entry.toolName === "read" && entry.input.path === "test/greeting.test.mjs"),
			true,
			diagnostics,
		);
		assert.equal(
			developerTools.some(
				(entry) => entry.toolName === "bash" && entry.input.command === "node test/greeting.test.mjs",
			),
			true,
			diagnostics,
		);
		const developerBashResults = developerRun?.toolResults.filter((result) => result.toolName === "bash") ?? [];
		assert.equal(developerBashResults.length, 2, diagnostics);
		assert.equal(
			developerBashResults.every((result) => result.isError === false),
			true,
			diagnostics,
		);
		assert.equal(
			developerBashResults.some((result) =>
				result.content.some((block) => block.type === "text" && /pass 1/.test(block.text)),
			),
			true,
			diagnostics,
		);
		const reviewerBashResults = reviewerRun?.toolResults.filter((result) => result.toolName === "bash") ?? [];
		assert.equal(reviewerBashResults.length, 1, diagnostics);
		assert.equal(
			reviewerBashResults.every((result) => result.isError === false),
			true,
			diagnostics,
		);
		const reviewerBashText = reviewerBashResults
			.flatMap((result) => result.content.filter((block) => block.type === "text").map((block) => block.text))
			.join("\n");
		assert.match(reviewerBashText, /M src\/index\.mjs/, diagnostics);
		assert.match(reviewerBashText, /\?\? src\/greeting\.mjs/, diagnostics);
		assert.match(reviewerBashText, /\?\? test\/greeting\.test\.mjs/, diagnostics);
		assert.match(reviewerBashText, /---DIFF---/, diagnostics);
		assert.match(reviewerBashText, /\+export \{ formatGreeting \} from '\.\/greeting\.mjs';/, diagnostics);
		const reviewerReadResults = reviewerRun?.toolResults.filter((result) => result.toolName === "read") ?? [];
		assert.equal(reviewerReadResults.length, 2, diagnostics);
		assert.equal(
			reviewerReadResults.every((result) => result.isError === false),
			true,
			diagnostics,
		);
		const reviewerReadTexts = reviewerReadResults.map((result) =>
			result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		);
		assert.equal(
			reviewerReadTexts.some(
				(text) => /export function formatGreeting\(name\)/.test(text) && /Hello, \$\{name\}!/.test(text),
			),
			true,
			diagnostics,
		);
		assert.equal(
			reviewerReadTexts.some(
				(text) =>
					/import \{ formatGreeting \} from "\.\.\/src\/index\.mjs";/.test(text) &&
					/assert\.equal\(formatGreeting\("Ada"\), "Hello, Ada!"\);/.test(text),
			),
			true,
			diagnostics,
		);
		assert.equal(
			sessionRoles.some(
				(entry) => entry.role === "developer" && /TLH Child Subagent Defaults/.test(entry.systemPrompt),
			),
			true,
			diagnostics,
		);
		assert.equal(
			sessionRoles.some(
				(entry) => entry.role === "code-reviewer" && /TLH Child Subagent Defaults/.test(entry.systemPrompt),
			),
			true,
			diagnostics,
		);
		assert.equal(
			promptLogs.some((entry) => /switch-primary-agent/.test(entry.systemPrompt)),
			false,
			diagnostics,
		);
		assert.equal(
			readFileSync(join(fixture.workspace, "test", "greeting.test.mjs"), "utf8").includes("formatGreeting"),
			true,
		);
		assert.deepEqual(
			readdirSync(ticketsDir, { withFileTypes: true }).map((entry) => entry.name),
			[],
			diagnostics,
		);
	} finally {
		session.dispose();
	}
});
