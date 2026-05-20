import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const extensionsDir = fileURLToPath(new URL("../extensions/", import.meta.url));
const PI_EXTENSION_FILE_ENTRYPOINT_EXTENSIONS = new Set([".ts", ".js"]);
const PI_EXTENSION_DIRECTORY_ENTRYPOINT_FILES = ["package.json", "index.ts", "index.js"];

const extensionSource = readFileSync(new URL("../extensions/the-last-harness.ts", import.meta.url), "utf8");
const primaryRuntimeSource = readFileSync(new URL("../extensions/the-last-harness/primary-agent-runtime.ts", import.meta.url), "utf8");
const effortSource = readFileSync(new URL("../extensions/the-last-harness/effort.ts", import.meta.url), "utf8");
const promptsSource = readFileSync(new URL("../extensions/the-last-harness/prompts.ts", import.meta.url), "utf8");

function sourceSection(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
	const end = source.indexOf(endMarker, start);
	assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
	return source.slice(start, end);
}

function discoverPiExtensionEntrypoints(extensionDirectory) {
	const entrypoints = [];

	for (const entry of readdirSync(extensionDirectory, { withFileTypes: true })) {
		if (entry.isFile() && PI_EXTENSION_FILE_ENTRYPOINT_EXTENSIONS.has(extname(entry.name))) {
			entrypoints.push(entry.name);
			continue;
		}

		if (!entry.isDirectory()) {
			continue;
		}

		for (const entrypointFile of PI_EXTENSION_DIRECTORY_ENTRYPOINT_FILES) {
			if (existsSync(join(extensionDirectory, entry.name, entrypointFile))) {
				entrypoints.push(`${entry.name}/${entrypointFile}`);
			}
		}
	}

	return entrypoints.sort();
}

function existingNestedExtensionEntrypoints(directoryName) {
	return PI_EXTENSION_DIRECTORY_ENTRYPOINT_FILES.map((entrypointFile) => `${directoryName}/${entrypointFile}`).filter(
		(relativePath) => existsSync(join(extensionsDir, relativePath)),
	);
}

test("package extension discovery exposes only the top-level TLH entrypoint", () => {
	assert.deepEqual(packageJson.pi?.extensions, ["./extensions"]);
	assert.deepEqual(existingNestedExtensionEntrypoints("the-last-harness"), []);
	assert.deepEqual(discoverPiExtensionEntrypoints(extensionsDir), ["the-last-harness.ts"]);
});

test("before_agent_start reapplies primary defaults without a one-shot model gate", () => {
	const beforeAgentStart = sourceSection(primaryRuntimeSource, 'pi.on("before_agent_start"', 'pi.on("tool_call"');
	const applyPrimaryModel = sourceSection(primaryRuntimeSource, "async function applyPrimaryModel", "function applyPrimaryThinking");
	const applyPrimaryThinking = sourceSection(primaryRuntimeSource, "function applyPrimaryThinking", "async function applyPrimaryDefaults");

	assert.doesNotMatch(primaryRuntimeSource, /primaryModelAttempted/);
	assert.match(beforeAgentStart, /await applyPrimaryDefaults\(ctx\);/);
	assert.match(applyPrimaryModel, /ctx\.model\?\.provider === model\.provider && ctx\.model\?\.id === model\.id/);
	assert.match(applyPrimaryThinking, /pi\.getThinkingLevel\(\) === primary\.thinking/);
});

test("extension imports extracted shared helpers from nested TypeScript modules", () => {
	assert.match(extensionSource, /from "\.\/the-last-harness\/autocomplete\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/effort\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/footer\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/gnosis\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/header\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/primary-agent-runtime\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/resources\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/types\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/constants\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/gnosis\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/profile-state\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/prompts\.js"/);
	assert.match(effortSource, /from "\.\/thinking\.js"/);
	assert.match(promptsSource, /from "\.\/package-version\.js"/);
	assert.doesNotMatch(extensionSource, /function safeTlhProfileFilePath/);
	assert.doesNotMatch(extensionSource, /const HARNESS_PROMPT =/);
	assert.doesNotMatch(extensionSource, /function buildTlhSystemPrompt/);
	assert.doesNotMatch(extensionSource, /function createTlhFooter/);
	assert.doesNotMatch(extensionSource, /function createTlhHeader/);
	assert.doesNotMatch(extensionSource, /function collectStartupResources/);
	assert.doesNotMatch(extensionSource, /function writeTlhPrimaryAgentDefault/);
	assert.doesNotMatch(extensionSource, /async function applyPrimaryModel/);
});

test("extension delegates launch update and telemetry services to feature modules", () => {
	const sessionStart = sourceSection(extensionSource, 'pi.on("session_start"', "\n\t});\n}");

	assert.match(extensionSource, /from "\.\/the-last-harness\/launch-telemetry\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/update-check\.js"/);
	assert.match(sessionStart, /scheduleTlhLaunchTelemetry\(ctx\)/);
	assert.match(sessionStart, /maybeNotifyAvailableTlhUpdate\(ctx\)/);
	assert.doesNotMatch(extensionSource, /function maybeSendTlhLaunchTelemetry/);
	assert.doesNotMatch(extensionSource, /function fetchLatestTlhRelease/);
});

test("extension runs primary session_start work before UI startup in one handler", () => {
	const sessionStart = sourceSection(extensionSource, 'pi.on("session_start"', "\n\t});\n}");
	const lifecycleHooks = sourceSection(primaryRuntimeSource, "function registerLifecycleHooks()", "\n\n\treturn { applySessionStart");

	assert.match(sessionStart, /await primaryAgentRuntime\.applySessionStart\(ctx\);[\s\S]*if \(!ctx\.hasUI\)/);
	assert.match(primaryRuntimeSource, /async function applySessionStart\(ctx: ExtensionContext\): Promise<void>/);
	assert.match(primaryRuntimeSource, /return \{ applySessionStart, currentPrimaryAgentLabel, registerCommands, registerLifecycleHooks \};/);
	assert.doesNotMatch(lifecycleHooks, /pi\.on\("session_start"/);
});

test("extension wires multi-primary commands and active-primary safety", () => {
	const agentCommand = sourceSection(primaryRuntimeSource, 'pi.registerCommand("agent"', 'pi.registerShortcut');
	const shortcut = sourceSection(primaryRuntimeSource, 'pi.registerShortcut(PRIMARY_AGENT_CYCLE_SHORTCUT', 'pi.registerCommand("architect"');
	const toolCall = sourceSection(primaryRuntimeSource, 'pi.on("tool_call"', "const reason = validateSubagentToolInput");

	assert.match(promptsSource, /function loadPrimaryAgents\(\): Map<TlhPrimaryAgentSelection, AgentPrompt>/);
	assert.match(agentCommand, /default product/);
	assert.match(agentCommand, /writeTlhPrimaryAgentDefault\(ctx\.cwd, defaultSelection\)/);
	assert.match(shortcut, /architect\/product\/bug-hunter\/disabled/);
	assert.match(toolCall, /!isEnabledPrimaryAgentSelection\(currentPrimaryAgentSelection\(\)\)/);
});
