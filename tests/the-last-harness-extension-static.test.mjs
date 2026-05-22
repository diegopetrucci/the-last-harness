import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const extensionsDir = fileURLToPath(new URL("../extensions/", import.meta.url));
const PI_EXTENSION_FILE_ENTRYPOINT_EXTENSIONS = new Set([".ts", ".js"]);
const PI_EXTENSION_DIRECTORY_ENTRYPOINT_FILES = ["package.json", "index.ts", "index.js"];

const extensionSource = readFileSync(new URL("../extensions/the-last-harness.ts", import.meta.url), "utf8");
const primaryRuntimeSource = readFileSync(new URL("../extensions/the-last-harness/primary-agent-runtime.ts", import.meta.url), "utf8");
const ticketRuntimeSource = readFileSync(new URL("../extensions/the-last-harness/tickets.ts", import.meta.url), "utf8");
const effortSource = readFileSync(new URL("../extensions/the-last-harness/effort.ts", import.meta.url), "utf8");
const promptsSource = readFileSync(new URL("../extensions/the-last-harness/prompts.ts", import.meta.url), "utf8");
const usageLimitsSource = readFileSync(new URL("../extensions/the-last-harness/usage-limits.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const { buildChildSubagentSystemPrompt, buildTlhSystemPrompt, loadPrimaryAgents, loadSubagentMetadata } = await jiti.import(
	"../extensions/the-last-harness/prompts.ts",
);

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
	assert.match(applyPrimaryModel, /selectProviderAwareAgentModel\(primary, ctx\.modelRegistry\.getAvailable\(\), ctx\.model\?\.provider\)/);
	assert.match(applyPrimaryModel, /ctx\.model\?\.provider === model\.provider && ctx\.model\?\.id === model\.id/);
	assert.match(applyPrimaryThinking, /pi\.getThinkingLevel\(\) === primary\.thinking/);
});

test("before_agent_start activates ticket runtime without disabled-ticket prompt branching", () => {
	const beforeAgentStart = sourceSection(primaryRuntimeSource, 'pi.on("before_agent_start"', 'pi.on("tool_call"');

	assert.match(primaryRuntimeSource, /function getTlhGlobalSettings\(cwd: string\): TlhSettings/);
	assert.match(ticketRuntimeSource, /return true;/);
	assert.match(beforeAgentStart, /const settings = getTlhGlobalSettings\(ctx\.cwd\);/);
	assert.doesNotMatch(beforeAgentStart, /ticketIntegrationEnabled/);
	assert.match(beforeAgentStart, /activateTlhTicketRuntime\(settings, getAgentDir\(\)\);/);
	assert.match(beforeAgentStart, /buildTlhSystemPrompt\(activePrimaryAgent\(\), subagentMetadata, primaryEnabled\)/);
});

test("primary and child prompts do not include disabled-ticket fallback guidance", () => {
	const primaryAgents = loadPrimaryAgents();
	const architect = primaryAgents.get("architect");
	assert.ok(architect, "architect primary prompt should load");
	assert.deepEqual(architect.tlhOpenaiModels, ["openai-codex/gpt-5.5", "openai/gpt-5.5"]);
	assert.deepEqual(
		loadSubagentMetadata().find((agent) => agent.name === "developer")?.tlhOpenaiModels,
		["openai-codex/gpt-5.4", "openai/gpt-5.4"],
	);

	const primaryPrompt = buildTlhSystemPrompt(architect, [], true);
	const childPrompt = buildChildSubagentSystemPrompt();

	for (const prompt of [primaryPrompt, childPrompt]) {
		assert.doesNotMatch(prompt, /## TLH Ticket Integration Disabled/);
		assert.doesNotMatch(prompt, /non-ticket/i);
		assert.doesNotMatch(prompt, /ticket integration is disabled/i);
	}
});

test("child startup branch uses the mandatory-ticket child prompt", () => {
	const registerBlock = sourceSection(
		primaryRuntimeSource,
		"export function registerTlhPrimaryAgentRuntime",
		"const runtime = createTlhPrimaryAgentRuntime",
	);

	assert.doesNotMatch(registerBlock, /getTlhGlobalSettings\(process\.cwd\(\)\)/);
	assert.doesNotMatch(registerBlock, /isTlhTicketIntegrationEnabled/);
	assert.match(registerBlock, /buildChildSubagentSystemPrompt\(\)/);
});

test("extension imports extracted shared helpers from nested TypeScript modules", () => {
	assert.match(extensionSource, /from "\.\/the-last-harness\/autocomplete\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/effort\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/footer\.js"/);
	assert.doesNotMatch(extensionSource, /from "\.\/the-last-harness\/gnosis\.js"/);
	assert.doesNotMatch(extensionSource, /registerGnosisCommand/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/header\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/primary-agent-runtime\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/resources\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/subscription-usage\.mjs"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/types\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/usage-limits\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/constants\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/gnosis\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/model-defaults\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/profile-state\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/prompts\.js"/);
	assert.match(primaryRuntimeSource, /from "\.\/tickets\.js"/);
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
	const toolCall = sourceSection(primaryRuntimeSource, 'pi.on("tool_call"', 'return reason ? { block: true, reason } : undefined;');

	assert.match(promptsSource, /function loadPrimaryAgents\(\): Map<TlhPrimaryAgentSelection, AgentPrompt>/);
	assert.match(agentCommand, /default product/);
	assert.match(agentCommand, /writeTlhPrimaryAgentDefault\(ctx\.cwd, defaultSelection\)/);
	assert.match(shortcut, /architect\/product\/bug-hunter\/disabled/);
	assert.match(toolCall, /applyProviderAwareSubagentModels\(event\.input, subagentsByName, ctx\.modelRegistry\.getAvailable\(\), ctx\.model\?\.provider\)/);
	assert.match(toolCall, /!isEnabledPrimaryAgentSelection\(currentPrimaryAgentSelection\(\)\)/);
	assert.match(toolCall, /const reason = validateSubagentToolInput\(event\.input\)/);
	assert(
		toolCall.indexOf("applyProviderAwareSubagentModels") < toolCall.indexOf("!isEnabledPrimaryAgentSelection"),
		"provider-aware subagent defaults should run before the disabled-primary guard",
	);
	assert(
		toolCall.indexOf("!isEnabledPrimaryAgentSelection") < toolCall.indexOf("validateSubagentToolInput"),
		"subagent safety validation should stay behind the enabled-primary guard",
	);
});

test("extension wires subscription usage to lifecycle refreshes and footer", () => {
	const sessionStart = sourceSection(extensionSource, 'pi.on("session_start"', "\n\t});\n}");

	assert.match(extensionSource, /createTlhSubscriptionUsageService\(\)/);
	assert.match(extensionSource, /pi\.on\("model_select"/);
	assert.match(extensionSource, /pi\.on\("turn_end"/);
	assert.match(sessionStart, /refreshSubscriptionUsage\(ctx\)/);
	assert.match(sessionStart, /subscriptionUsage: subscriptionUsageService/);
	assert.match(sessionStart, /shouldShowTlhUsageWeekly\(getTlhUsageLimitsConfig\(ctx\.cwd\)\)/);
	assert.match(sessionStart, /onChange: \(\) => tui\.requestRender\(\)/);
	assert.match(sessionStart, /typeof footerData\?\.onBranchChange === "function" \? \(cb\) => footerData\.onBranchChange\(cb\) : undefined/);
});

test("extension wires usage-limit command to isolated TLH settings", () => {
	assert.match(extensionSource, /registerUsageCommand\(pi\)/);
	assert.match(usageLimitsSource, /pi\.registerCommand\("usage"/);
	assert.match(usageLimitsSource, /value: "weekly on"/);
	assert.match(usageLimitsSource, /value: "weekly off"/);
	assert.match(usageLimitsSource, /value: "weekly toggle"/);
	assert.match(usageLimitsSource, /tlhSettingsPathForWrite\(\)/);
	assert.match(usageLimitsSource, /assertSafeTlhSettingsPath\(settingsPath\)/);
	assert.match(usageLimitsSource, /settings\.tlh\.usageLimits\.showWeekly = showWeekly/);
	assert.match(usageLimitsSource, /showWeekly === true/);
});
