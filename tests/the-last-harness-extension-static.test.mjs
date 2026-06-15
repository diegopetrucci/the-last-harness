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
const annotateGitDiffSource = readFileSync(new URL("../extensions/annotate-git-diff/index.ts", import.meta.url), "utf8");
const annotateGitDiffAppSource = readFileSync(new URL("../extensions/annotate-git-diff/web/app.js", import.meta.url), "utf8");
const annotateGitDiffHtmlSource = readFileSync(new URL("../extensions/annotate-git-diff/web/index.html", import.meta.url), "utf8");
const attributionSource = readFileSync(new URL("../extensions/the-last-harness/attribution.ts", import.meta.url), "utf8");
const changelogSource = readFileSync(new URL("../extensions/the-last-harness/changelog.ts", import.meta.url), "utf8");
const primaryRuntimeSource = readFileSync(new URL("../extensions/the-last-harness/primary-agent-runtime.ts", import.meta.url), "utf8");
const effortSource = readFileSync(new URL("../extensions/the-last-harness/effort.ts", import.meta.url), "utf8");
const experimentalSource = readFileSync(new URL("../extensions/the-last-harness/experimental.ts", import.meta.url), "utf8");
const promptsSource = readFileSync(new URL("../extensions/the-last-harness/prompts.ts", import.meta.url), "utf8");
const usageLimitsSource = readFileSync(new URL("../extensions/the-last-harness/usage-limits.ts", import.meta.url), "utf8");
const profileStateSource = readFileSync(new URL("../extensions/the-last-harness/profile-state.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../extensions/the-last-harness/types.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const { buildChildSubagentSystemPrompt, buildTlhSystemPrompt, loadPrimaryAgents, loadSubagentMetadata } = await jiti.import(
	"../extensions/the-last-harness/prompts.ts",
);
const { buildReviewHtml } = await jiti.import("../extensions/annotate-git-diff/ui.ts");

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

test("package extension discovery exposes the TLH entrypoints", () => {
	assert.deepEqual(packageJson.pi?.extensions, ["./extensions"]);
	assert.deepEqual(existingNestedExtensionEntrypoints("the-last-harness"), []);
	assert.deepEqual(existingNestedExtensionEntrypoints("annotate-git-diff"), ["annotate-git-diff/index.ts"]);
	assert.deepEqual(discoverPiExtensionEntrypoints(extensionsDir), ["annotate-git-diff/index.ts", "the-last-harness.ts"]);
});

test("annotate-git-diff source registers the renamed command without a legacy alias", () => {
	assert.match(annotateGitDiffSource, /pi\.registerCommand\("annotate-git-diff"/);
	assert.doesNotMatch(annotateGitDiffSource, /pi\.registerCommand\("diff-review"/);
});

test("annotate-git-diff user-facing source copy uses the renamed command", () => {
	assert.match(annotateGitDiffSource, /title: "TLH annotate-git-diff"/);
	assert.doesNotMatch(annotateGitDiffAppSource, /\/diff-review/);
	assert.doesNotMatch(annotateGitDiffHtmlSource, /\/diff-review/);
	assert.match(annotateGitDiffHtmlSource, /<title>TLH annotate-git-diff<\/title>/);
	assert.match(annotateGitDiffHtmlSource, /<code>\/annotate-git-diff<\/code>/);
});

test("annotate-git-diff review HTML inlines Monaco assets without file:// URLs into node_modules", () => {
	// buildReviewHtml must resolve and inline all Monaco assets so that the WKWebView
	// null-origin restriction on file:// URLs is never triggered.
	const html = buildReviewHtml({
		repoRoot: "/test/repo",
		files: [],
		commits: [],
		branchBaseRef: null,
		branchMergeBaseSha: null,
		repositoryHasHead: false,
	});

	// Regression guard: no file:// URL pointing into node_modules must appear in the built HTML.
	assert.doesNotMatch(html, /file:\/\/[^\s'"]*node_modules/, "built HTML must not contain file:// URLs into node_modules");

	// Monaco editor JS is inlined (editor.main.js contains 'vs/editor/edcore.main').
	assert.match(html, /vs\/editor\/edcore\.main/, "editor.main.js content must be inlined");

	// Monaco editor CSS is inlined (editor.main.css contains '.monaco-editor').
	assert.match(html, /\.monaco-editor/, "editor.main.css content must be inlined");

	// Monaco worker source is inlined (workerMain.js contains 'EditorSimpleWorker').
	assert.match(html, /EditorSimpleWorker/, "workerMain.js content must be inlined");

	// No unreplaced template markers.
	assert.doesNotMatch(html, /__INLINE_MONACO_EDITOR_JS__/);
	assert.doesNotMatch(html, /__INLINE_MONACO_EDITOR_CSS__/);
	assert.doesNotMatch(html, /__INLINE_MONACO_WORKER_SOURCE_JSON__/);
	assert.doesNotMatch(html, /__INLINE_MONACO_BASIC_LANGUAGES_JS__/, "__INLINE_MONACO_BASIC_LANGUAGES_JS__ marker must be replaced");

	// Basic-language tokenizers are inlined (representative sample).
	assert.match(html, /define\("vs\/basic-languages\/typescript\/typescript"/, "TypeScript tokenizer must be inlined");
	assert.match(html, /define\("vs\/basic-languages\/python\/python"/, "Python tokenizer must be inlined");
	assert.match(html, /define\("vs\/basic-languages\/go\/go"/, "Go tokenizer must be inlined");

	// The asset config must not expose monacoVsBaseUrl.
	assert.doesNotMatch(html, /monacoVsBaseUrl/);
});

test("before_agent_start reapplies primary defaults without a one-shot model gate", () => {
	const lifecycleHooks = sourceSection(primaryRuntimeSource, "function registerLifecycleHooks()", "\n\n\treturn { applySessionStart");
	const beforeAgentStart = sourceSection(lifecycleHooks, 'pi.on("before_agent_start"', 'pi.on("tool_call"');
	const applyPrimaryModel = sourceSection(primaryRuntimeSource, "async function applyPrimaryModel", "function currentThinkingSatisfiesPrimaryFloor");
	const currentThinkingSatisfiesPrimaryFloor = sourceSection(
		primaryRuntimeSource,
		"function currentThinkingSatisfiesPrimaryFloor",
		"function applyPrimaryThinking",
	);
	const applyPrimaryThinking = sourceSection(primaryRuntimeSource, "function applyPrimaryThinking", "async function applyPrimaryDefaults");
	const applyPrimaryDefaults = sourceSection(primaryRuntimeSource, "async function applyPrimaryDefaults", "async function applyPrimaryModeChange");

	assert.doesNotMatch(primaryRuntimeSource, /primaryModelAttempted/);
	assert.match(beforeAgentStart, /await applyPrimaryDefaults\(ctx\);/);
	assert.match(applyPrimaryDefaults, /selectProviderAwareAgentDefaults\(primary, ctx\.modelRegistry\.getAvailable\(\), ctx\.model\?\.provider\)/);
	assert.match(applyPrimaryDefaults, /resolvePrimaryAutoApplySetting\(primaryConfig, primary, "applyModel"\)/);
	assert.match(applyPrimaryDefaults, /resolvePrimaryAutoApplySetting\(primaryConfig, primary, "applyThinking"\)/);
	assert.match(applyPrimaryModel, /ctx\.model\?\.provider === model\.provider && ctx\.model\?\.id === model\.id/);
	assert.match(currentThinkingSatisfiesPrimaryFloor, /thinkingLevelAtLeast\(currentThinking, primary\.minThinking\)/);
	assert.match(applyPrimaryThinking, /const currentThinking = pi\.getThinkingLevel\(\);/);
	assert.match(applyPrimaryThinking, /currentThinking === thinking/);
	assert.match(applyPrimaryThinking, /currentThinkingSatisfiesPrimaryFloor\(primary, currentThinking\)/);
	assert.match(promptsSource, /preferCurrentOpenaiModel: parseBooleanValue\(frontmatter\.preferCurrentOpenaiModel\)/);
	assert.match(promptsSource, /preferOppositeProvider: parseBooleanValue\(frontmatter\.preferOppositeProvider\)/);
	assert.match(promptsSource, /preferOppositeProvider: agent\.preferOppositeProvider/);
	assert.match(typesSource, /preferOppositeProvider\?: boolean;/);
	assert.match(promptsSource, /applyModel: parseBooleanValue\(frontmatter\.applyModel\)/);
	assert.match(promptsSource, /applyThinking: parseBooleanValue\(frontmatter\.applyThinking\)/);
	assert.match(promptsSource, /lockThinking: parseBooleanValue\(frontmatter\.lockThinking\)/);
	assert.match(promptsSource, /minThinking: parseThinkingLevelValue\(frontmatter\.minThinking\)/);
});

test("before_agent_start activates ticket runtime without disabled-ticket prompt branching", () => {
	const lifecycleHooks = sourceSection(primaryRuntimeSource, "function registerLifecycleHooks()", "\n\n\treturn { applySessionStart");
	const beforeAgentStart = sourceSection(lifecycleHooks, 'pi.on("before_agent_start"', 'pi.on("tool_call"');

	assert.match(primaryRuntimeSource, /function getTlhGlobalSettings\(cwd: string\): TlhSettings/);
	assert.match(beforeAgentStart, /const settings = getTlhGlobalSettings\(ctx\.cwd\);/);
	assert.doesNotMatch(beforeAgentStart, /ticketIntegrationEnabled/);
	assert.match(beforeAgentStart, /activateTlhTicketRuntime\(settings, getAgentDir\(\)\);/);
	assert.match(beforeAgentStart, /buildTlhSystemPrompt\(activePrimaryAgent\(\), subagentMetadata, primaryEnabled\)/);
});

test("primary and child prompts do not include disabled-ticket fallback guidance", () => {
	const primaryAgents = loadPrimaryAgents();
	const architect = primaryAgents.get("architect");
	const rush = primaryAgents.get("rush");
	assert.ok(architect, "architect primary prompt should load");
	assert.ok(rush, "Rush primary prompt should load");
	assert.deepEqual(architect.tlhOpenaiModels, ["openai-codex/gpt-5.5"]);
	assert.deepEqual(rush.tlhOpenaiModels, ["openai-codex/gpt-5.5"]);
	assert.equal(rush.thinking, "low");
	assert.equal(rush.tlhOpenaiThinking, "off");
	assert.equal(rush.preferCurrentOpenaiModel, true);
	assert.equal(architect.preferCurrentOpenaiModel, undefined);
	assert.equal(rush.applyModel, true);
	assert.equal(rush.applyThinking, true);
	assert.equal(rush.lockThinking, true);
	assert.equal(architect.applyModel, true);
	assert.equal(architect.applyThinking, true);
	assert.equal(architect.minThinking, "medium");
	assert.equal(architect.lockThinking, undefined);

	const product = primaryAgents.get("product");
	assert.ok(product, "product primary prompt should load");
	assert.equal(product.applyModel, true);
	assert.equal(product.applyThinking, true);
	assert.equal(product.lockThinking, true);

	const bugHunter = primaryAgents.get("bug-hunter");
	assert.ok(bugHunter, "bug-hunter primary prompt should load");
	assert.equal(bugHunter.applyModel, true);
	assert.equal(bugHunter.applyThinking, true);
	assert.equal(bugHunter.lockThinking, true);

	assert.match(rush.systemPrompt, /Do not delegate implementation to `developer`/);
	assert.deepEqual(
		loadSubagentMetadata().find((agent) => agent.name === "developer")?.tlhOpenaiModels,
		["openai-codex/gpt-5.4"],
	);

	const primaryPrompt = buildTlhSystemPrompt(rush, loadSubagentMetadata(), true);
	const childPrompt = buildChildSubagentSystemPrompt();

	assert.match(primaryPrompt, /## TLH Allowed Minor Subagents/);
	assert.match(primaryPrompt, /action: "list"`\/`"get"`\/`"resume"/);
	assert.match(primaryPrompt, /omit `agentScope` or use `"user"`/);
	assert.match(primaryPrompt, /action: "resume".*omit `context` or use `"fresh"`/);
	assert.match(primaryPrompt, /TLH minor agents are isolated to the user scope/);

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
	assert.match(registerBlock, /buildChildSubagentSystemPrompt\(\)/);
});

test("extension imports extracted shared helpers from nested TypeScript modules", () => {
	assert.match(extensionSource, /from "\.\/the-last-harness\/attribution\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/autocomplete\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/changelog\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/effort\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/footer\.js"/);
	assert.doesNotMatch(extensionSource, /from "\.\/the-last-harness\/gnosis\.js"/);
	assert.doesNotMatch(extensionSource, /registerGnosisCommand/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/header\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/package-update-notice\.js"/);
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

test("thinking alias shares the effort command thinking-level behavior", () => {
	assert.match(effortSource, /\["effort", "thinking"\] as const/);
	assert.match(effortSource, /description: "Pick the model thinking level"/);
	assert.match(effortSource, /Unknown thinking level/);
	assert.match(effortSource, /Thinking level set to/);
	assert.match(effortSource, /Available thinking levels/);
	assert.match(effortSource, /Pick thinking level/);
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

test("extension installs the TLH package-update startup notice override during activation", () => {
	assert.match(extensionSource, /installTlhPackageUpdateNotificationOverride\(\)/);
});

test("extension runs primary session_start work before UI startup in one handler", () => {
	const sessionStart = sourceSection(extensionSource, 'pi.on("session_start"', "\n\t});\n}");
	const lifecycleHooks = sourceSection(primaryRuntimeSource, "function registerLifecycleHooks()", "\n\n\treturn { applySessionStart");

	assert.match(sessionStart, /await primaryAgentRuntime\.applySessionStart\(ctx\);[\s\S]*if \(!ctx\.hasUI\)/);
	assert.match(primaryRuntimeSource, /async function applySessionStart\(ctx: ExtensionContext\): Promise<void>/);
	assert.match(primaryRuntimeSource, /return \{ applySessionStart, currentPrimaryAgentLabel, activePrimaryAgentPrompt: activePrimaryAgent, registerCommands, registerLifecycleHooks \};/);
	assert.doesNotMatch(lifecycleHooks, /pi\.on\("session_start"/);
});

test("extension wires switch-primary-agent and active-primary safety", () => {
	const lifecycleHooks = sourceSection(primaryRuntimeSource, "function registerLifecycleHooks()", "\n\n\treturn { applySessionStart");
	const switchPrimaryAgentCommand = sourceSection(primaryRuntimeSource, 'pi.registerCommand("switch-primary-agent"', 'pi.registerShortcut');
	const shortcut = sourceSection(primaryRuntimeSource, 'pi.registerShortcut(PRIMARY_AGENT_CYCLE_SHORTCUT', 'async function applySessionStart');
	const toolCall = sourceSection(lifecycleHooks, 'pi.on("tool_call"', '\n\t\t});\n\t}');

	assert.match(promptsSource, /function loadPrimaryAgents\(\): Map<TlhPrimaryAgentSelection, AgentPrompt>/);
	assert.match(switchPrimaryAgentCommand, /default rush/);
	assert.match(switchPrimaryAgentCommand, /Usage: \/switch-primary-agent architect\|rush\|product\|bug-hunter\|disabled/);
	assert.match(switchPrimaryAgentCommand, /writeTlhPrimaryAgentDefault\(ctx\.cwd, defaultSelection\)/);
	assert.match(shortcut, /architect\/rush\/product\/bug-hunter\/disabled/);
	assert.doesNotMatch(primaryRuntimeSource, /pi\.registerCommand\("agent"/);
	assert.doesNotMatch(primaryRuntimeSource, /pi\.registerCommand\("architect"/);
	assert.doesNotMatch(primaryRuntimeSource, /pi\.registerCommand\("tlh"/);
	assert.doesNotMatch(primaryRuntimeSource, /pi\.registerCommand\("harness"/);
	assert.match(toolCall, /if \(event\.toolName === "bash"\) \{[\s\S]*resolveTlhCommitAttribution\(getTlhGlobalSettings\(ctx\.cwd\)\.tlh\?\.attribution\)/);
	assert.match(toolCall, /getTlhGitCommitAttributionBlockReason\(event\.input\.command, commitAttributionState\)/);
	assert.match(toolCall, /applyProviderAwareSubagentModels\(event\.input, subagentsByName, ctx\.modelRegistry\.getAvailable\(\), ctx\.model\?\.provider\)/);
	assert.match(toolCall, /const selection = currentPrimaryAgentSelection\(\)/);
	assert.match(toolCall, /if \(selection === "rush" && subagentCallTargetsAgent\(event\.input, "developer"\)\)/);
	assert.match(toolCall, /const reason = validateSubagentToolInput\(event\.input\)/);
	assert(
		toolCall.indexOf('if (event.toolName === "bash")') < toolCall.indexOf("resolveTlhCommitAttribution"),
		"parent tool_call should resolve attribution only inside the bash branch",
	);
	assert(
		toolCall.indexOf("applyProviderAwareSubagentModels") < toolCall.indexOf("!isEnabledPrimaryAgentSelection(selection)"),
		"provider-aware subagent defaults should run before the disabled-primary guard",
	);
	assert(
		toolCall.indexOf('selection === "rush"') < toolCall.indexOf("validateSubagentToolInput"),
		"Rush developer guard should run before generic subagent validation",
	);
});

test("child runtime wires commit attribution prompt and bash guard without primary controls", () => {
	const childRuntime = sourceSection(primaryRuntimeSource, "function registerChildSubagentRuntime", "\n\nfunction createTlhPrimaryAgentRuntime");
	const registerBlock = sourceSection(
		primaryRuntimeSource,
		"export function registerTlhPrimaryAgentRuntime",
		"const runtime = createTlhPrimaryAgentRuntime",
	);

	assert.match(childRuntime, /pi\.on\("before_agent_start"/);
	assert.match(childRuntime, /buildTlhCommitAttributionPrompt\(commitAttributionState\)/);
	assert.match(childRuntime, /pi\.on\("tool_call"/);
	assert.match(childRuntime, /if \(event\.toolName !== "bash"\)/);
	assert.match(childRuntime, /getTlhGitCommitAttributionBlockReason\(event\.input\.command, commitAttributionState\)/);
	assert.match(registerBlock, /registerChild: \(\) => \{/);
	assert.match(registerBlock, /registerChildSubagentRuntime\(pi, childPromptBuilder\);/);
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

test("extension wires TLH changelog command and release-notes rendering", () => {
	assert.match(extensionSource, /registerTlhChangelogCommand\(pi\)/);
	assert.match(changelogSource, /pi\.registerCommand\("tlh-changelog"/);
	assert.match(changelogSource, /new Markdown\(changelog/);
	assert.match(changelogSource, /ctx\.ui\.custom/);
	assert.match(changelogSource, /pi\.sendMessage\(\{/);
});

test("extension wires TLH experimental, attribution, and usage commands to isolated TLH settings", () => {
	const lockedWriteHelper = sourceSection(
		profileStateSource,
		"export function withLockedTlhSettingsWrite",
		"export function assertSafeTlhSettingsPath",
	);

	assert.match(extensionSource, /registerExperimentalCommand\(pi\)/);
	assert.match(experimentalSource, /pi\.registerCommand\("experimental"/);
	assert.match(experimentalSource, /run-tests-last/);
	assert.match(
		experimentalSource,
		/withLockedTlhSettingsWrite\(cwd, "Refusing to write experimental settings outside the isolated TLH profile\./,
	);
	assert.doesNotMatch(experimentalSource, /tlhSettingsPathForWrite\(\)/);
	assert.doesNotMatch(experimentalSource, /assertSafeTlhSettingsPath\(settingsPath\)/);
	assert.match(experimentalSource, /settings\.tlh\.experimental\.enabledFeatures = nextEnabledFeatures/);
	assert.match(typesSource, /enabledFeatures\?: string\[];/);
	assert.doesNotMatch(extensionSource, /registerTlhCommitAttributionRuntime\(pi\)/);
	assert.match(extensionSource, /registerToggleTlhGitAttributionCommand\(pi\)/);
	assert.match(attributionSource, /from "\.\/profile-state\.js"/);
	assert.doesNotMatch(attributionSource, /pi\.on\("before_agent_start"/);
	assert.doesNotMatch(attributionSource, /pi\.on\("tool_call"/);
	assert.doesNotMatch(attributionSource, /user_bash/);
	assert.match(attributionSource, /pi\.registerCommand\("toggle-tlh-git-attribution"/);
	assert.doesNotMatch(attributionSource, /pi\.registerCommand\("attribution"/);
	assert.doesNotMatch(attributionSource, /value: "toggle"/);
	assert.match(attributionSource, /Usage: \/toggle-tlh-git-attribution/);
	assert.match(
		attributionSource,
		/withLockedTlhSettingsWrite\(cwd, "Refusing to write attribution settings outside the isolated TLH profile\./,
	);
	assert.doesNotMatch(attributionSource, /tlhSettingsPathForWrite\(\)/);
	assert.doesNotMatch(attributionSource, /assertSafeTlhSettingsPath\(settingsPath\)/);
	assert.match(attributionSource, /TLH_DEFAULT_COMMIT_ATTRIBUTION/);
	assert.match(attributionSource, /settings\.tlh\.attribution = \{ commit: nextEnabled \}/);
	assert.match(attributionSource, /typeof commit !== "boolean"/);
	assert.match(typesSource, /commit\?: boolean;/);
	assert.match(extensionSource, /registerUsageCommand\(pi\)/);
	assert.match(usageLimitsSource, /from "\.\/profile-state\.js"/);
	assert.match(usageLimitsSource, /pi\.registerCommand\("usage"/);
	assert.match(usageLimitsSource, /value: "weekly on"/);
	assert.match(usageLimitsSource, /value: "weekly off"/);
	assert.match(usageLimitsSource, /value: "weekly toggle"/);
	assert.match(
		usageLimitsSource,
		/withLockedTlhSettingsWrite\(cwd, "Refusing to write usage-limit settings outside the isolated TLH profile\./,
	);
	assert.doesNotMatch(usageLimitsSource, /tlhSettingsPathForWrite\(\)/);
	assert.doesNotMatch(usageLimitsSource, /assertSafeTlhSettingsPath\(settingsPath\)/);
	assert.match(lockedWriteHelper, /const settingsPath = tlhSettingsPathForWrite\(\);/);
	assert.match(lockedWriteHelper, /assertSafeTlhSettingsPath\(settingsPath\);/);
	assert.match(lockedWriteHelper, /const backupPath = current \? `\$\{settingsPath\}\.bak-\$\{settingsBackupTimestamp\(\)\}` : undefined;/);
	assert.match(lockedWriteHelper, /writeFileSync\(backupPath, current, \{ encoding: "utf8", flag: "wx", mode: 0o600 \}\);/);
	assert.match(usageLimitsSource, /settings\.tlh\.usageLimits\.showWeekly = showWeekly/);
	assert.match(usageLimitsSource, /showWeekly === true/);
});
