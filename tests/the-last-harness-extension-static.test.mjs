import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import ts from "typescript";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const extensionsDir = fileURLToPath(new URL("../extensions/", import.meta.url));
const PI_EXTENSION_FILE_ENTRYPOINT_EXTENSIONS = new Set([".ts", ".js"]);
const PI_EXTENSION_DIRECTORY_ENTRYPOINT_FILES = ["package.json", "index.ts", "index.js"];

const extensionSource = readFileSync(new URL("../extensions/the-last-harness.ts", import.meta.url), "utf8");
const annotateGitDiffSource = readFileSync(
	new URL("../extensions/annotate-git-diff/index.ts", import.meta.url),
	"utf8",
);
const annotateGitDiffUiSource = readFileSync(new URL("../extensions/annotate-git-diff/ui.ts", import.meta.url), "utf8");
const annotateGitDiffAppSource = readFileSync(
	new URL("../extensions/annotate-git-diff/web/app.js", import.meta.url),
	"utf8",
);
const annotateGitDiffHtmlSource = readFileSync(
	new URL("../extensions/annotate-git-diff/web/index.html", import.meta.url),
	"utf8",
);
const attributionSource = readFileSync(
	new URL("../extensions/the-last-harness/attribution.ts", import.meta.url),
	"utf8",
);
const attributionCommandSource = readFileSync(
	new URL("../extensions/the-last-harness/attribution-command.ts", import.meta.url),
	"utf8",
);
const changelogSource = readFileSync(new URL("../extensions/the-last-harness/changelog.ts", import.meta.url), "utf8");
const experimentalSource = readFileSync(
	new URL("../extensions/the-last-harness/experimental.ts", import.meta.url),
	"utf8",
);
const experimentalCommandSource = readFileSync(
	new URL("../extensions/the-last-harness/experimental-command.ts", import.meta.url),
	"utf8",
);
const ticketWorkflowUiFacadeSource = readFileSync(
	new URL("../extensions/the-last-harness/ticket-workflow-ui-facade.ts", import.meta.url),
	"utf8",
);
const footerFirstLineSource = readFileSync(
	new URL("../extensions/the-last-harness/footer-first-line.ts", import.meta.url),
	"utf8",
);
const footerGitCacheSource = readFileSync(
	new URL("../extensions/the-last-harness/footer-git-cache.ts", import.meta.url),
	"utf8",
);
const subscriptionUsageFacadeSource = readFileSync(
	new URL("../extensions/the-last-harness/subscription-usage-facade.ts", import.meta.url),
	"utf8",
);
const primaryRuntimeSource = readFileSync(
	new URL("../extensions/the-last-harness/primary-agent-runtime.ts", import.meta.url),
	"utf8",
);
const effortSource = readFileSync(new URL("../extensions/the-last-harness/effort.ts", import.meta.url), "utf8");
const effortCommandSource = readFileSync(
	new URL("../extensions/the-last-harness/effort-command.ts", import.meta.url),
	"utf8",
);
const promptsSource = readFileSync(new URL("../extensions/the-last-harness/prompts.ts", import.meta.url), "utf8");
const tokensSource = readFileSync(new URL("../extensions/the-last-harness/tokens.ts", import.meta.url), "utf8");
const usageLimitsSource = readFileSync(
	new URL("../extensions/the-last-harness/usage-limits.ts", import.meta.url),
	"utf8",
);
const usageLimitsCommandSource = readFileSync(
	new URL("../extensions/the-last-harness/usage-limits-command.ts", import.meta.url),
	"utf8",
);
const profileStateSource = readFileSync(
	new URL("../extensions/the-last-harness/profile-state.ts", import.meta.url),
	"utf8",
);
const packageVersionSource = readFileSync(
	new URL("../extensions/the-last-harness/package-version.ts", import.meta.url),
	"utf8",
);
const typesSource = readFileSync(new URL("../extensions/the-last-harness/types.ts", import.meta.url), "utf8");
const annotateLastMessageSource = readFileSync(
	new URL("../extensions/the-last-harness/annotate-last-message.ts", import.meta.url),
	"utf8",
);
const jiti = createJiti(import.meta.url);
const { buildChildSubagentSystemPrompt, buildTlhSystemPrompt, loadPrimaryAgents, loadSubagentMetadata } =
	await jiti.import("../extensions/the-last-harness/prompts.ts");
const { buildReviewHtml } = await jiti.import("../extensions/annotate-git-diff/ui.ts");

function sourceSection(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
	const end = source.indexOf(endMarker, start);
	assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
	return source.slice(start, end);
}

function escapeRegex(value) {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function extractMonacoRuntimeSource(html) {
	const runtimeSourceMatch = html.match(
		/<script>\n([\s\S]*?)\n<\/script>\n<script>\nwindow\.__reviewMonacoWorkerSource =/,
	);
	assert.ok(runtimeSourceMatch, "Monaco language/runtime bundle must be inlined");
	return runtimeSourceMatch[1];
}

function resolveAmdModuleId(fromModuleId, target) {
	const normalizedTarget = target.replace(/\.js$/, "");
	if (!normalizedTarget.startsWith(".")) {
		return normalizedTarget;
	}

	const segments = fromModuleId.split("/");
	segments.pop();
	for (const segment of normalizedTarget.split("/")) {
		if (!segment || segment === ".") {
			continue;
		}
		if (segment === "..") {
			assert.ok(segments.length > 0, `cannot resolve Monaco AMD module from ${fromModuleId} via ${target}`);
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join("/");
}

function amdDefineModuleId(statement) {
	if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
		return null;
	}
	if (!ts.isIdentifier(statement.expression.expression) || statement.expression.expression.text !== "define") {
		return null;
	}
	const [moduleIdArgument] = statement.expression.arguments;
	return ts.isStringLiteral(moduleIdArgument) ? moduleIdArgument.text : null;
}

function staticImportSpecifiers(source, fileName = "source.ts") {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	return sourceFile.statements
		.filter(ts.isImportDeclaration)
		.map((statement) => statement.moduleSpecifier)
		.filter(ts.isStringLiteral)
		.map((specifier) => specifier.text);
}

function extractMonacoModuleSource(runtimeSource, moduleId) {
	const moduleMarker = `define("${moduleId}"`;
	const start = runtimeSource.indexOf(moduleMarker);
	assert.notEqual(start, -1, `Monaco module ${moduleId} must be inlined`);
	const moduleAndFollowingSource = runtimeSource.slice(start);
	const moduleAst = ts.createSourceFile(
		"monaco-module.js",
		moduleAndFollowingSource,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.JS,
	);
	const [moduleStatement] = moduleAst.statements;
	assert.equal(amdDefineModuleId(moduleStatement), moduleId, `Monaco module ${moduleId} must be an AMD define() call`);
	return moduleAndFollowingSource.slice(moduleStatement.getStart(moduleAst), moduleStatement.end);
}

function discoverBasicLanguageLoaderTarget(runtimeSource, languageId, extensions) {
	const extensionsPattern = extensions.map((extension) => `"${escapeRegex(extension)}"`).join("\\s*,\\s*");
	const loaderPatterns = [
		new RegExp(
			`id:\\s*"${escapeRegex(languageId)}"[\\s\\S]*?extensions:\\s*\\[${extensionsPattern}\\][\\s\\S]*?loader:\\s*\\(\\)\\s*=>[\\s\\S]*?\\[\\s*"([^"]+)"\\s*\\]`,
		),
		new RegExp(
			`id:\\s*"${escapeRegex(languageId)}"[\\s\\S]*?extensions:\\s*\\[${extensionsPattern}\\][\\s\\S]*?loader:\\s*\\(\\)\\s*=>\\s*import\\(\\s*"([^"]+)"\\s*\\)`,
		),
	];
	const modulePattern = /define\("([^"]+)"[\s\S]*?(?=define\("|$)/g;

	for (const moduleMatch of runtimeSource.matchAll(modulePattern)) {
		const [, moduleId] = moduleMatch;
		const moduleSource = moduleMatch[0];
		for (const pattern of loaderPatterns) {
			const match = moduleSource.match(pattern);
			if (match) {
				return { fromModuleId: moduleId, loaderTarget: match[1] };
			}
		}
	}

	assert.fail(`Monaco basic-language registration for ${languageId} must include an inlined loader target`);
}

function assertRepresentativeMonacoLanguageChunkInlined(runtimeSource, _contributionModuleId, { id, extensions }) {
	const { fromModuleId, loaderTarget } = discoverBasicLanguageLoaderTarget(runtimeSource, id, extensions);
	const targetModuleId = resolveAmdModuleId(fromModuleId, loaderTarget);
	const targetModuleSource = extractMonacoModuleSource(runtimeSource, targetModuleId);

	assert.ok(targetModuleSource.trim().length > 256, `Monaco ${id} loader target ${targetModuleId} must be non-empty`);
	assert.match(targetModuleSource, /\.conf\s*=|\bconf:/, `Monaco ${id} chunk must export language configuration`);
	assert.match(
		targetModuleSource,
		/\.language\s*=|\blanguage:/,
		`Monaco ${id} chunk must export tokenizer/runtime data`,
	);
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

function parseInlineJsonStringAssignment(source, assignmentName) {
	const escapedAssignmentName = assignmentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const assignment = source.match(new RegExp(`${escapedAssignmentName} = ("(?:\\\\.|[^"\\\\])*");`));
	assert.ok(assignment, `${assignmentName} assignment must be present`);
	return JSON.parse(assignment[1]);
}

test("package manifest selects only the ordered generated JS entrypoints", () => {
	assert.deepEqual(packageJson.pi?.extensions, [
		"./extensions/notify/index.js",
		"./extensions/annotate-git-diff/index.js",
		"./extensions/the-last-harness.js",
		"./extensions/subagents/src/extension/index.js",
	]);
	assert.deepEqual(existingNestedExtensionEntrypoints("the-last-harness"), []);
	assert.deepEqual(existingNestedExtensionEntrypoints("annotate-git-diff"), [
		"annotate-git-diff/index.ts",
		"annotate-git-diff/index.js",
	]);
	assert.deepEqual(existingNestedExtensionEntrypoints("notify"), ["notify/index.ts", "notify/index.js"]);
	assert.deepEqual(discoverPiExtensionEntrypoints(extensionsDir), [
		"annotate-git-diff/index.js",
		"annotate-git-diff/index.ts",
		"notify/index.js",
		"notify/index.ts",
		"the-last-harness.js",
		"the-last-harness.ts",
	]);
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

test("annotate-git-diff Monaco helper extracts AMD modules across adjacent and whitespace-separated boundaries", () => {
	const adjacentRuntimeSource =
		'define("first", [], function () { return { language: true }; });define("second", [], function () { return { conf: true }; });';
	assert.equal(
		extractMonacoModuleSource(adjacentRuntimeSource, "first"),
		'define("first", [], function () { return { language: true }; });',
	);
	assert.equal(
		extractMonacoModuleSource(adjacentRuntimeSource, "second"),
		'define("second", [], function () { return { conf: true }; });',
	);

	const whitespaceSeparatedRuntimeSource = [
		'define("first", [], function () {',
		"  return { language: true };",
		"});",
		" \t ",
		'  define("second", [], function () {',
		"    return { conf: true };",
		"  });",
	].join("\n");
	assert.equal(
		extractMonacoModuleSource(whitespaceSeparatedRuntimeSource, "first"),
		['define("first", [], function () {', "  return { language: true };", "});"].join("\n"),
	);
	assert.equal(
		extractMonacoModuleSource(whitespaceSeparatedRuntimeSource, "second"),
		['define("second", [], function () {', "    return { conf: true };", "  });"].join("\n"),
	);
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
	assert.doesNotMatch(
		html,
		/file:\/\/[^\s'"]*node_modules/,
		"built HTML must not contain file:// URLs into node_modules",
	);

	// Monaco 0.56 exports the min/vs/index.js AMD entry but not package.json. The
	// packaged bootstrap must use that public entry rather than the legacy
	// editor.main module, whose runtime side effects replace MonacoEnvironment and
	// dynamically append editor.main.css.
	assert.match(annotateGitDiffUiSource, /require\.resolve\("monaco-editor"\)/);
	assert.doesNotMatch(annotateGitDiffUiSource, /require\.resolve\("monaco-editor\/package\.json"\)/);
	assert.match(html, /define\("vs\/index"/, "the public Monaco vs/index module must be inlined");
	assert.doesNotMatch(
		html,
		/define\("vs\/editor\/editor\.main"/,
		"editor.main and its runtime side effects must not be inlined",
	);
	assert.doesNotMatch(html, /document\.createElement\("link"\)/, "Monaco must not dynamically append a CSS link");
	assert.match(html, /"bootstrapError":null/, "packaged review assets should load without a bootstrap error");

	// Monaco editor CSS is inlined (editor.main.css contains '.monaco-editor').
	assert.match(html, /\.monaco-editor/, "editor.main.css content must be inlined");

	// Monaco worker source is inlined as a non-empty bundled script.
	const workerSource = parseInlineJsonStringAssignment(html, "window.__reviewMonacoWorkerSource");
	assert.ok(workerSource.trim().length > 1024, "editor worker bundle must be a non-empty inlined script");
	assert.match(
		workerSource,
		/(?:self|globalThis)\.onmessage\b|onmessage\s*=/,
		"editor worker bundle must register a worker message handler",
	);
	assert.match(workerSource, /\bpostMessage\b/, "editor worker bundle must communicate with the host");

	// No unreplaced template markers.
	assert.doesNotMatch(html, /__INLINE_MONACO_ENTRY_JS__/);
	assert.doesNotMatch(html, /__INLINE_MONACO_EDITOR_CSS__/);
	assert.doesNotMatch(html, /__INLINE_MONACO_WORKER_SOURCE_JSON__/);
	assert.doesNotMatch(
		html,
		/__INLINE_MONACO_BASIC_LANGUAGES_JS__/,
		"__INLINE_MONACO_BASIC_LANGUAGES_JS__ marker must be replaced",
	);

	// Monaco language/runtime assets are inlined as a non-empty bundle without relying on
	// hardcoded internal chunk names, which can differ across Monaco builds.
	const runtimeSource = extractMonacoRuntimeSource(html);
	assert.ok(runtimeSource.trim().length > 1024, "Monaco language/runtime bundle must be non-empty");
	const contributionModuleMatch = runtimeSource.match(/define\("([^"]*basic-languages\/monaco\.contribution)"/);
	assert.ok(contributionModuleMatch, "Monaco basic-language runtime must be inlined");
	const contributionModuleId = contributionModuleMatch[1];
	for (const language of [
		{ id: "typescript", extensions: [".ts", ".tsx", ".cts", ".mts"] },
		{ id: "python", extensions: [".py", ".rpy", ".pyw", ".cpy", ".gyp", ".gypi"] },
		{ id: "go", extensions: [".go"] },
	]) {
		assertRepresentativeMonacoLanguageChunkInlined(runtimeSource, contributionModuleId, language);
	}

	// The asset config must not expose monacoVsBaseUrl. The app must install TLH's
	// blob worker environment before loading vs/index, then use the callback module
	// as the Monaco API instead of relying on editor.main's window.monaco side effect.
	assert.doesNotMatch(html, /monacoVsBaseUrl/);
	const setupMonacoSource = sourceSection(
		annotateGitDiffAppSource,
		"function setupMonaco()",
		"\n\nfunction switchScope",
	);
	assert.ok(setupMonacoSource.indexOf("window.MonacoEnvironment =") < setupMonacoSource.indexOf('["vs/index"]'));
	assert.match(setupMonacoSource, /\["vs\/index"\],[\s\S]*?\(loadedMonacoApi\)\s*=>/);
	assert.match(setupMonacoSource, /monacoApi = loadedMonacoApi;/);
	assert.match(
		setupMonacoSource,
		/loadedMonacoApi\?\.editor[\s\S]*loadedMonacoApi\?\.languages[\s\S]*loadedMonacoApi\.Range/,
	);
	assert.doesNotMatch(setupMonacoSource, /vs\/editor\/editor\.main|monacoApi = window\.monaco/);
});

test("before_agent_start reapplies primary defaults without a one-shot model gate", () => {
	const lifecycleHooks = sourceSection(primaryRuntimeSource, "function registerLifecycleHooks()", "\n\n\treturn {");
	const beforeAgentStart = sourceSection(lifecycleHooks, 'pi.on("before_agent_start"', 'pi.on("tool_call"');
	const applyPrimaryModel = sourceSection(
		primaryRuntimeSource,
		"async function applyPrimaryModel",
		"function currentThinkingSatisfiesPrimaryFloor",
	);
	const currentThinkingSatisfiesPrimaryFloor = sourceSection(
		primaryRuntimeSource,
		"function currentThinkingSatisfiesPrimaryFloor",
		"function applyPrimaryThinking",
	);
	const applyPrimaryThinking = sourceSection(
		primaryRuntimeSource,
		"function applyPrimaryThinking",
		"async function applyPrimaryDefaults",
	);
	const applyPrimaryDefaults = sourceSection(
		primaryRuntimeSource,
		"async function applyPrimaryDefaults",
		"async function applyPrimaryModeChange",
	);

	assert.doesNotMatch(primaryRuntimeSource, /primaryModelAttempted/);
	assert.match(beforeAgentStart, /await applyPrimaryDefaults\(ctx\);/);
	assert.match(applyPrimaryDefaults, /getUnfilteredAvailableModels\(ctx\.modelRegistry\)/);
	assert.match(
		applyPrimaryDefaults,
		/selectProviderAwareAgentDefaults\(primary, availableModels, ctx\.model\?\.provider\)/,
	);
	assert.match(applyPrimaryDefaults, /resolvePrimaryAutoApplySetting\(primaryConfig, primary, "applyModel"\)/);
	assert.match(applyPrimaryDefaults, /resolvePrimaryAutoApplySetting\(primaryConfig, primary, "applyThinking"\)/);
	assert.match(applyPrimaryModel, /ctx\.model\?\.provider === model\.provider && ctx\.model\?\.id === model\.id/);
	assert.match(currentThinkingSatisfiesPrimaryFloor, /thinkingLevelAtLeast\(currentThinking, primary\.minThinking\)/);
	assert.match(applyPrimaryThinking, /const currentThinking = pi\.getThinkingLevel\(\);/);
	assert.match(applyPrimaryThinking, /currentThinking === thinking/);
	assert.match(applyPrimaryThinking, /currentThinkingSatisfiesPrimaryFloor\(primary, currentThinking\)/);
	assert.match(promptsSource, /preferCurrentOpenaiModel: parseBooleanValue\(frontmatter\.preferCurrentOpenaiModel\)/);
	assert.match(promptsSource, /preferOppositeProvider: parseBooleanValue\(frontmatter\.preferOppositeProvider\)/);
	assert.match(promptsSource, /thinking: agent\.thinking/);
	assert.match(promptsSource, /tlhOpenaiThinking: agent\.tlhOpenaiThinking/);
	assert.match(promptsSource, /preferOppositeProvider: agent\.preferOppositeProvider/);
	assert.match(typesSource, /tlhOpenaiThinking\?: ThinkingLevel;/);
	assert.match(typesSource, /preferOppositeProvider\?: boolean;/);
	assert.match(promptsSource, /applyModel: parseBooleanValue\(frontmatter\.applyModel\)/);
	assert.match(promptsSource, /applyThinking: parseBooleanValue\(frontmatter\.applyThinking\)/);
	assert.match(promptsSource, /lockThinking: parseBooleanValue\(frontmatter\.lockThinking\)/);
	assert.match(promptsSource, /minThinking: parseThinkingLevelValue\(frontmatter\.minThinking\)/);
});

test("before_agent_start activates ticket runtime without disabled-ticket prompt branching", () => {
	const lifecycleHooks = sourceSection(primaryRuntimeSource, "function registerLifecycleHooks()", "\n\n\treturn {");
	const beforeAgentStart = sourceSection(lifecycleHooks, 'pi.on("before_agent_start"', 'pi.on("tool_call"');
	const activePromptBuilder = sourceSection(
		primaryRuntimeSource,
		"function buildActivePrimarySystemPrompt(",
		"function buildLaunchSystemPrompt(",
	);
	const applySessionStart = sourceSection(
		primaryRuntimeSource,
		"async function applySessionStart(",
		"function registerLifecycleHooks()",
	);

	assert.match(primaryRuntimeSource, /function getTlhGlobalSettings\(cwd: string\): TlhSettings/);
	assert.match(beforeAgentStart, /const settings = getTlhGlobalSettings\(ctx\.cwd\);/);
	assert.doesNotMatch(beforeAgentStart, /ticketIntegrationEnabled/);
	assert.match(beforeAgentStart, /activateTlhTicketRuntime\(settings, getAgentDir\(\), ctx\.cwd\);/);
	assert.match(beforeAgentStart, /buildActivePrimarySystemPrompt\(event\.systemPrompt, ctx\.cwd, settings\)/);
	// The per-turn refresh must NOT be reintroduced in before_agent_start.
	assert.doesNotMatch(beforeAgentStart, /sessionExperimentalSnapshot =/);
	// delta/ci prompt guidance reads settings fresh per turn through the shared launch builder.
	assert.match(activePromptBuilder, /buildPrimaryExperimentalPrompt\(primary, settings\.tlh\?\.experimental\)/);
	assert.match(
		activePromptBuilder,
		/buildTlhSystemPrompt\(primary, subagentMetadata, primaryEnabled, sessionExperimentalSnapshot\)/,
	);
	// The embedded snapshot is captured once per session in applySessionStart.
	assert.match(
		applySessionStart,
		/sessionExperimentalSnapshot = getTlhGlobalSettings\(ctx\.cwd\)\.tlh\?\.experimental/,
	);
});

test("primary and child prompts do not include disabled-ticket fallback guidance", () => {
	const primaryAgents = loadPrimaryAgents();
	const architect = primaryAgents.get("architect");
	const rush = primaryAgents.get("rush");
	assert.ok(architect, "architect primary prompt should load");
	assert.ok(rush, "Rush primary prompt should load");
	assert.equal(architect.model, "anthropic/claude-opus-5");
	assert.equal(architect.tlhAnthropicThinking, "high");
	assert.deepEqual(architect.tlhOpenaiModels, ["openai-codex/gpt-5.6-sol"]);
	assert.equal(rush.model, "anthropic/claude-sonnet-4-6");
	assert.deepEqual(rush.tlhOpenaiModels, ["openai-codex/gpt-5.6-luna"]);
	assert.equal(rush.tlhAnthropicThinking, "low");
	assert.equal(rush.tlhOpenaiThinking, "medium");
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
	assert.equal(product.model, "anthropic/claude-opus-5");
	assert.deepEqual(product.tlhOpenaiModels, ["openai-codex/gpt-5.6-sol"]);
	assert.equal(product.tlhAnthropicThinking, "high");
	assert.equal(product.applyModel, true);
	assert.equal(product.applyThinking, true);
	assert.equal(product.lockThinking, true);

	const bugHunter = primaryAgents.get("bug-hunter");
	assert.ok(bugHunter, "bug-hunter primary prompt should load");
	assert.equal(bugHunter.model, "anthropic/claude-opus-5");
	assert.deepEqual(bugHunter.tlhOpenaiModels, ["openai-codex/gpt-5.6-sol"]);
	assert.equal(bugHunter.tlhAnthropicThinking, "high");
	assert.equal(bugHunter.applyModel, true);
	assert.equal(bugHunter.applyThinking, true);
	assert.equal(bugHunter.lockThinking, true);

	assert.match(rush.systemPrompt, /Do not delegate implementation to `developer`/);
	const subagentMetadata = loadSubagentMetadata();
	const developer = subagentMetadata.find((agent) => agent.name === "developer");
	assert.deepEqual(developer?.tlhAnthropicModels, ["anthropic/claude-sonnet-4-6"]);
	assert.deepEqual(developer?.tlhOpenaiModels, ["openai-codex/gpt-5.6-luna"]);
	assert.equal(developer?.tlhAnthropicThinking, "medium");
	assert.equal(developer?.tlhOpenaiThinking, "max");
	for (const name of ["code-reviewer", "oracle", "contrarian"]) {
		const agent = subagentMetadata.find((candidate) => candidate.name === name);
		assert.deepEqual(agent?.tlhAnthropicModels, ["anthropic/claude-opus-5"], `${name} Anthropic default`);
		assert.deepEqual(agent?.tlhOpenaiModels, ["openai-codex/gpt-5.6-sol"], `${name} OpenAI default`);
	}

	const primaryPrompt = buildTlhSystemPrompt(rush, loadSubagentMetadata(), true);
	const legacyFlagPrimaryPrompt = buildTlhSystemPrompt(rush, loadSubagentMetadata(), true, {
		enabledFeatures: ["contrarian"],
	});
	const childPrompt = buildChildSubagentSystemPrompt();

	assert.match(primaryPrompt, /## TLH Allowed Minor Subagents/);
	assert.match(primaryPrompt, /action: "list"`\/`"get"`\/`"resume"/);
	assert.match(primaryPrompt, /omit `agentScope` or use `"user"`/);
	assert.match(primaryPrompt, /action: "resume".*omit `context` or use `"fresh"`/);
	assert.match(primaryPrompt, /TLH minor agents are isolated to the user scope/);
	assert.match(primaryPrompt, /- contrarian:/i);
	assert.match(legacyFlagPrimaryPrompt, /- contrarian:/i);

	for (const prompt of [primaryPrompt, childPrompt]) {
		assert.doesNotMatch(prompt, /## TLH Ticket Integration Disabled/);
		assert.doesNotMatch(prompt, /non-ticket/i);
		assert.doesNotMatch(prompt, /ticket integration is disabled/i);
	}
});

test("allowed-subagents prompt keeps bundled minor-agent listings and scopes embedded guidance to architect", () => {
	const primaryAgents = loadPrimaryAgents();
	const architect = primaryAgents.get("architect");
	const rush = primaryAgents.get("rush");
	const product = primaryAgents.get("product");
	const bugHunter = primaryAgents.get("bug-hunter");
	const subagents = loadSubagentMetadata();

	const embeddedConfig = { enabledFeatures: ["embedded-subagents"] };
	const noEmbeddedConfig = { enabledFeatures: [] };

	// Patterns
	const embeddedClause = /embedded\.<slug>.*subagent.*explicitly names or asks/s;
	const closingRule = /Do not delegate outside this bundled TLH minor-agent list\./;
	const managementGuidance = /TLH minor agents are isolated to the user scope/;
	const sectionHeader = /## TLH Allowed Minor Subagents/;

	// architect + embedded-subagents flag ON: has embedded clause, no closing rule
	const architectOn = buildTlhSystemPrompt(architect, subagents, true, embeddedConfig);
	assert.match(architectOn, sectionHeader, "architect+on: section header present");
	assert.match(architectOn, managementGuidance, "architect+on: management guidance present");
	assert.match(architectOn, embeddedClause, "architect+on: embedded clause present");
	assert.doesNotMatch(architectOn, closingRule, "architect+on: no closing rule");

	// architect + embedded-subagents flag OFF: no embedded clause, has closing rule
	const architectOff = buildTlhSystemPrompt(architect, subagents, true, noEmbeddedConfig);
	assert.match(architectOff, sectionHeader, "architect+off: section header present");
	assert.match(architectOff, managementGuidance, "architect+off: management guidance present");
	assert.doesNotMatch(architectOff, embeddedClause, "architect+off: no embedded clause");
	assert.match(architectOff, closingRule, "architect+off: closing rule present");

	// architect + undefined config: no embedded clause, has closing rule
	const architectUndefined = buildTlhSystemPrompt(architect, subagents, true, undefined);
	assert.doesNotMatch(architectUndefined, embeddedClause, "architect+undefined: no embedded clause");
	assert.match(architectUndefined, closingRule, "architect+undefined: closing rule present");

	// rush / product / bug-hunter: no embedded clause and has closing rule regardless of flag
	for (const primary of [rush, product, bugHunter]) {
		const label = primary?.name ?? "unknown";
		for (const config of [embeddedConfig, noEmbeddedConfig, undefined]) {
			const prompt = buildTlhSystemPrompt(primary, subagents, true, config);
			assert.match(prompt, sectionHeader, `${label}: section header present`);
			assert.match(prompt, managementGuidance, `${label}: management guidance present`);
			assert.doesNotMatch(prompt, embeddedClause, `${label}: no embedded clause`);
			assert.match(prompt, closingRule, `${label}: closing rule present`);
		}
	}

	// All variants include bundled agent listings
	for (const [primary, config] of [
		[architect, embeddedConfig],
		[architect, noEmbeddedConfig],
		[rush, embeddedConfig],
		[rush, noEmbeddedConfig],
		[product, embeddedConfig],
		[bugHunter, embeddedConfig],
	]) {
		const prompt = buildTlhSystemPrompt(primary, subagents, true, config);
		assert.match(prompt, /- developer:/, `${primary?.name}: developer listing present`);
		assert.match(prompt, /- code-reviewer:/, `${primary?.name}: code-reviewer listing present`);
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
	assert.match(extensionSource, /from "\.\/the-last-harness\/effort\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/footer\.js"/);
	assert.doesNotMatch(extensionSource, /from "\.\/the-last-harness\/gnosis\.js"/);
	assert.doesNotMatch(extensionSource, /registerGnosisCommand/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/header\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/model-visibility\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/new-version-notice\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/package-update-notice\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/primary-agent-runtime\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/resources\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/subscription-usage-facade\.js"/);
	assert.doesNotMatch(extensionSource, /from "\.\/the-last-harness\/subscription-usage\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/types\.js"/);
	assert.match(footerFirstLineSource, /from "\.\/footer-git\.js"/);
	assert.match(footerGitCacheSource, /from "\.\/footer-git\.js"/);
	assert.doesNotMatch(footerFirstLineSource, /from "\.\/footer-git\.mjs"/);
	assert.doesNotMatch(footerGitCacheSource, /from "\.\/footer-git\.mjs"/);
	assert.deepEqual(
		staticImportSpecifiers(extensionSource).filter((specifier) =>
			[
				"./the-last-harness/review.js",
				"./the-last-harness/tokens.js",
				"./the-last-harness/annotate-last-message.js",
				"./the-last-harness/changelog.js",
				"./the-last-harness/launch-telemetry.js",
			].includes(specifier),
		),
		[],
		"review, tokens, annotate-last-message, tlh-changelog, and launch telemetry must not be top-level static imports",
	);
	assert.match(extensionSource, /import\("\.\/the-last-harness\/review\.js"\)/);
	assert.match(extensionSource, /import\("\.\/the-last-harness\/tokens\.js"\)/);
	assert.match(extensionSource, /import\("\.\/the-last-harness\/annotate-last-message\.js"\)/);
	assert.match(extensionSource, /import\("\.\/the-last-harness\/changelog\.js"\)/);
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

test("extension lazy-loads review, tokens, annotate-last-message, and tlh-changelog with retryable facades", () => {
	assert.match(
		extensionSource,
		/const REVIEW_COMMAND_DESCRIPTION = "Review code changes via an interactive mode picker";/,
	);
	assert.match(
		extensionSource,
		/const TOKENS_COMMAND_DESCRIPTION = "Generate and open a local TLH token-spend report";/,
	);
	assert.match(
		extensionSource,
		/const ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION = "Open a native annotation window for the latest assistant message";/,
	);
	assert.match(
		extensionSource,
		/const TLH_CHANGELOG_COMMAND_DESCRIPTION = "Show TLH release notes from the packaged changelog";/,
	);
	assert.match(
		extensionSource,
		/function createRetryableLazyImport<TModule>\(loader: \(\) => Promise<TModule>\): \(\) => Promise<TModule> \{/,
	);
	assert.match(
		extensionSource,
		/modulePromise = loader\(\)\.catch\(\(error\) => \{[\s\S]*modulePromise = undefined;[\s\S]*throw error;/,
	);
	assert.match(
		extensionSource,
		/pi\.registerCommand\("review", \{[\s\S]*getArgumentCompletions: \(\) => null,[\s\S]*const handler = await getReviewCommandHandler\(\);/,
	);
	assert.match(
		extensionSource,
		/pi\.registerCommand\("tokens", \{[\s\S]*const handler = await getTokensCommandHandler\(\);/,
	);
	assert.match(
		extensionSource,
		/pi\.registerCommand\("annotate-last-message", \{[\s\S]*const command = await getAnnotateLastMessageCommand\(\);/,
	);
	assert.match(
		extensionSource,
		/pi\.registerCommand\("tlh-changelog", \{[\s\S]*const handler = await getTlhChangelogCommandHandler\(\);[\s\S]*await handler\(pi, args, ctx\);/,
	);
	assert.match(
		extensionSource,
		/annotateLastMessageCommandPromise = loadAnnotateLastMessageModule\(\)[\s\S]*?buildAnnotateLastMessageCommand\(\{/,
	);
	assert.match(
		extensionSource,
		/tlhChangelogCommandHandlerPromise = loadTlhChangelogModule\(\)[\s\S]*handleTlhChangelogCommand/,
	);
	assert.match(
		extensionSource,
		/pi\.on\("session_shutdown", async \(\) => \{[\s\S]*if \(!annotateLastMessageCommandPromise\) \{[\s\S]*return;[\s\S]*const command = await annotateLastMessageCommandPromise;[\s\S]*command\.handleSessionShutdown\(\);/,
	);
	assert.doesNotMatch(
		extensionSource,
		/import\("\.\/the-last-harness\/(?:effort|thinking|experimental|version|attribution)\.js"\)/,
	);
});

test("production annotate-last-message facade wires sendUserMessage through to the command builder", () => {
	// Regression guard: registerAnnotateLastMessageCommand is unused by the shipped extension.
	// The lazy-load facade below is the only production construction path, so it must supply
	// sendUserMessage or submitted annotation feedback is silently dropped.
	const facade = sourceSection(extensionSource, "const getAnnotateLastMessageCommand = () => {", "\n\t};");
	assert.match(facade, /module\.buildAnnotateLastMessageCommand\(\{/);
	assert.match(facade, /sendUserMessage: \(message, options\) => pi\.sendUserMessage\(message, options\),/);

	// The dependency must be required, so a build site that cannot send fails typecheck.
	assert.match(
		annotateLastMessageSource,
		/export type AnnotateLastMessageDependencies = \{\n\tsendUserMessage: \(message: string, options: \{ deliverAs: "followUp" \}\) => void;/,
	);
	assert.match(
		annotateLastMessageSource,
		/dependencies: AnnotateLastMessageDependencies,\n\): AnnotateLastMessageCommand \{/,
	);
	assert.doesNotMatch(annotateLastMessageSource, /dependencies: AnnotateLastMessageDependencies = \{\}/);
	// No optional-call guard papering over a missing dependency.
	assert.match(annotateLastMessageSource, /\n\t\t\t\t\tsendUserMessage\(prompt, \{ deliverAs: "followUp" \}\);/);
	assert.doesNotMatch(annotateLastMessageSource, /sendUserMessage\?\.\(/);
});

test("header and footer install before deferred update side effects", () => {
	const sessionStart = sourceSection(extensionSource, 'pi.on("session_start"', "\n\t});\n}");

	assert.match(extensionSource, /from "\.\/the-last-harness\/footer\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/footer-git-cache\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/header\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/update-check\.js"/);
	assert.doesNotMatch(
		extensionSource,
		/import\("\.\/the-last-harness\/(?:footer|footer-git-cache|header|update-check)\.js"\)/,
	);
	assert.match(sessionStart, /const headerUpdate = getTlhHeaderUpdate\(\);/);
	assert.match(
		sessionStart,
		/void maybeNotifyAvailableTlhUpdate\(ctx, \{[\s\S]*canNotify: \(\) => activeTlhHeaderSessionToken === sessionToken,[\s\S]*\}\)\.catch\(\(\) => undefined\);/,
	);
	assert.match(sessionStart, /persistTlhLastSeenVersion\(\);/);
	assert.doesNotMatch(sessionStart, /scheduleDeferredStartupTask\(\(\) => \{\s*if \(event\.reason === "startup"\)/);
	assert.doesNotMatch(sessionStart, /await (?:collectStartupResources|startupResourceCollector)\(/);
	assert.match(
		sessionStart,
		/if \(typeof ctx\.ui\.setFooter === "function"\) \{[\s\S]*ctx\.ui\.setFooter\([\s\S]*if \(typeof ctx\.ui\.setHeader === "function"\) \{[\s\S]*ctx\.ui\.setHeader\([\s\S]*scheduleDeferredStartupTask\(\(\) => \{[\s\S]*persistTlhLastSeenVersion\(\);[\s\S]*void maybeNotifyAvailableTlhUpdate\(ctx, \{[\s\S]*\}\)\.catch\(\(\) => undefined\);/,
	);
});

test("package version lookup caches the manifest result in-process", () => {
	assert.match(packageVersionSource, /let cachedTlhVersion: string \| undefined;/);
	assert.match(packageVersionSource, /if \(cachedTlhVersion\) \{\s*return cachedTlhVersion;\s*\}/);
	assert.match(packageVersionSource, /cachedTlhVersion = typeof packageJson\.version === "string"/);
});

test("thinking alias shares the effort command thinking-level behavior", () => {
	assert.match(effortSource, /\["effort", "thinking"\] as const/);
	assert.match(effortSource, /description: "Pick the model thinking level"/);
	assert.match(effortSource, /import\("\.\/effort-command\.js"\)/);
	assert.match(effortCommandSource, /Unknown thinking level/);
	assert.match(effortCommandSource, /Thinking level set to/);
	assert.match(effortCommandSource, /Available thinking levels/);
	assert.match(effortCommandSource, /Pick thinking level/);
});

test("extension delegates launch update and telemetry services to feature modules", () => {
	const sessionStart = sourceSection(extensionSource, 'pi.on("session_start"', "\n\t});\n}");

	assert.doesNotMatch(extensionSource, /from "\.\/the-last-harness\/launch-telemetry\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/model-visibility\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/update-check\.js"/);
	assert.match(
		sessionStart,
		/if \(event\.reason === "startup"\) \{[\s\S]*void import\("\.\/the-last-harness\/launch-telemetry\.js"\)[\s\S]*scheduleTlhLaunchTelemetry\(ctx, primaryAgentRuntime\.activePrimaryAgentPrompt\(\)\?\.name\)[\s\S]*\.catch\(\(\) => undefined\);[\s\S]*\}/,
	);
	assert.match(
		sessionStart,
		/await primaryAgentRuntime\.applySessionStart\(ctx\);[\s\S]*if \(event\.reason === "startup"\) \{[\s\S]*scheduleTlhLaunchTelemetry\(ctx, primaryAgentRuntime\.activePrimaryAgentPrompt\(\)\?\.name\)/,
	);
	assert.match(sessionStart, /if \(!ctx\.hasUI\) \{[\s\S]*return;[\s\S]*if \(event\.reason === "startup"\)/);
	assert.match(sessionStart, /const headerUpdate = getTlhHeaderUpdate\(\);/);
	assert.match(
		sessionStart,
		/scheduleDeferredStartupTask\(\(\) => \{[\s\S]*void maybeNotifyAvailableTlhUpdate\(ctx, \{[\s\S]*\}\)\.catch\(\(\) => undefined\);/,
	);
	assert.doesNotMatch(extensionSource, /function maybeSendTlhLaunchTelemetry/);
	assert.doesNotMatch(extensionSource, /function fetchLatestTlhRelease/);
});

test("extension installs TLH model-visibility, package-update, and new-version-notice overrides during activation", () => {
	assert.match(extensionSource, /installTlhModelVisibilityFilter\(\)/);
	assert.match(extensionSource, /installTlhPackageUpdateNotificationOverride\(\)/);
	assert.match(extensionSource, /installTlhNewVersionNotificationOverride\(\)/);
});

test("extension registers synchronous header-session invalidation before async shutdown handlers", () => {
	const invalidationRegistration = 'pi.on("session_shutdown", () => {';
	const firstShutdownHandlerIndex = extensionSource.indexOf('pi.on("session_shutdown"');
	const invalidationHandlerIndex = extensionSource.indexOf(invalidationRegistration);
	const contextCapRegistrationIndex = extensionSource.indexOf("registerContextCap(pi)");
	const annotateShutdownIndex = extensionSource.indexOf('pi.on("session_shutdown", async () => {');

	assert.notEqual(invalidationHandlerIndex, -1, "expected a synchronous header-session invalidation handler");
	assert.equal(
		firstShutdownHandlerIndex,
		invalidationHandlerIndex,
		"header-session invalidation must be the first shutdown handler registered here",
	);
	assert.ok(
		invalidationHandlerIndex < contextCapRegistrationIndex,
		"invalidation must register before context-cap async shutdown work",
	);
	assert.ok(
		invalidationHandlerIndex < annotateShutdownIndex,
		"invalidation must register before annotate async shutdown work",
	);
});

test("extension runs primary session_start work before UI startup in one handler", () => {
	const sessionStart = sourceSection(extensionSource, 'pi.on("session_start"', "\n\t});\n}");
	const lifecycleHooks = sourceSection(primaryRuntimeSource, "function registerLifecycleHooks()", "\n\n\treturn {");

	assert.match(sessionStart, /await primaryAgentRuntime\.applySessionStart\(ctx\);[\s\S]*if \(!ctx\.hasUI\)/);
	assert.match(
		primaryRuntimeSource,
		/async function applySessionStart\(ctx: ExtensionContext\): Promise<void>[\s\S]*activateTlhTicketSessionScope\(ctx\.cwd\);/,
	);
	assert.match(
		primaryRuntimeSource,
		/return\s+\{\s*applySessionStart,\s*currentPrimaryAgentLabel,\s*activePrimaryAgentPrompt:\s*activePrimaryAgent,\s*buildLaunchSystemPrompt,\s*resetPrimaryAgentModelOverride,\s*registerCommands,\s*registerLifecycleHooks,?\s*\};/,
	);
	assert.doesNotMatch(lifecycleHooks, /pi\.on\("session_start"/);
});

test("extension wires switch-primary-agent and active-primary safety", () => {
	const lifecycleHooks = sourceSection(primaryRuntimeSource, "function registerLifecycleHooks()", "\n\n\treturn {");
	const switchPrimaryAgentCommand = sourceSection(
		primaryRuntimeSource,
		'pi.registerCommand("switch-primary-agent"',
		"pi.registerShortcut",
	);
	const shortcut = sourceSection(
		primaryRuntimeSource,
		"pi.registerShortcut(PRIMARY_AGENT_CYCLE_SHORTCUT",
		"async function applySessionStart",
	);
	const toolCall = sourceSection(lifecycleHooks, 'pi.on("tool_call"', "\n\t\t});\n\t}");

	assert.match(promptsSource, /function loadPrimaryAgents\(\): Map<TlhPrimaryAgentSelection, AgentPrompt>/);
	assert.match(switchPrimaryAgentCommand, /default rush/);
	assert.match(
		switchPrimaryAgentCommand,
		/Usage: \/switch-primary-agent architect\|rush\|product\|bug-hunter\|disabled/,
	);
	assert.match(switchPrimaryAgentCommand, /writeTlhPrimaryAgentDefault\(ctx\.cwd, defaultSelection\)/);
	assert.match(shortcut, /architect\/rush\/product\/bug-hunter\/disabled/);
	assert.doesNotMatch(primaryRuntimeSource, /pi\.registerCommand\("agent"/);
	assert.doesNotMatch(primaryRuntimeSource, /pi\.registerCommand\("architect"/);
	assert.doesNotMatch(primaryRuntimeSource, /pi\.registerCommand\("tlh"/);
	assert.doesNotMatch(primaryRuntimeSource, /pi\.registerCommand\("harness"/);
	assert.match(
		toolCall,
		/if \(event\.toolName === "bash"\) \{[\s\S]*resolveTlhCommitAttribution\(getTlhGlobalSettings\(ctx\.cwd\)\.tlh\?\.attribution\)/,
	);
	assert.match(toolCall, /getTlhGitCommitAttributionBlockReason\(event\.input\.command, commitAttributionState\)/);
	assert.match(
		toolCall,
		/applyProviderAwareSubagentModels\(\s*event\.input,\s*subagentsByName,\s*getUnfilteredAvailableModels\(ctx\.modelRegistry\),\s*ctx\.model\?\.provider,\s*ctx\.model,\s*\{\s*agentOverrides: subagentOverrides,\s*onWarning:/,
	);
	assert.match(toolCall, /const selection = currentPrimaryAgentSelection\(\)/);
	assert.match(
		toolCall,
		/const allowedSubagents = allowedSubagentsForExperimentalConfig\(getTlhGlobalSettings\(ctx\.cwd\)\.tlh\?\.experimental\)/,
	);
	assert.match(
		toolCall,
		/if \(!isEnabledPrimaryAgentSelection\(selection\)\) \{[\s\S]*if \(!isSubagentResumeAction\(event\.input\)\) \{[\s\S]*return undefined;[\s\S]*const disabledReason = validateSubagentToolInput\(event\.input, \{ allowedSubagents \}\)/,
	);
	assert.match(toolCall, /if \(selection === "rush" && isSubagentResumeAction\(event\.input\)\)/);
	assert.match(toolCall, /if \(selection === "rush" && subagentCallTargetsAgent\(event\.input, "developer"\)\)/);
	assert.match(
		toolCall,
		/const embeddedFeatureEnabled = isExperimentalFeatureEnabled\(\s*sessionExperimentalSnapshot,\s*EMBEDDED_SUBAGENTS_FEATURE,?\s*\)/,
	);
	assert.match(
		toolCall,
		/if \(embeddedFeatureEnabled\) \{[\s\S]*const embeddedBlockReason = embeddedDelegationBlockedReason\(selection, event\.input\)/,
	);
	assert.match(toolCall, /const allowEmbeddedTargets = embeddedFeatureEnabled && selection === "architect"/);
	assert.match(
		toolCall,
		/const requestedEmbeddedTargets = collectSubagentCallTargetsMatching\(event\.input, isEmbeddedSubagentTarget\)/,
	);
	assert.match(
		toolCall,
		/if \(requestedEmbeddedTargets\.length > 0\) \{[\s\S]*loadAuthorizedEmbeddedSubagentRuntimeNames\(getAgentDir\(\)\)/,
	);
	assert.match(
		toolCall,
		/const reason = validateSubagentToolInput\(event\.input, \{ allowedSubagents, allowEmbeddedTargets \}\)/,
	);
	assert(
		toolCall.indexOf('if (event.toolName === "bash")') < toolCall.indexOf("resolveTlhCommitAttribution"),
		"parent tool_call should resolve attribution only inside the bash branch",
	);
	assert(
		toolCall.indexOf("applyProviderAwareSubagentModels") <
			toolCall.indexOf("!isEnabledPrimaryAgentSelection(selection)"),
		"provider-aware subagent defaults should run before the disabled-primary guard",
	);
	const genericValidationIndex = toolCall.indexOf(
		"const reason = validateSubagentToolInput(event.input, { allowedSubagents, allowEmbeddedTargets })",
	);
	assert(
		toolCall.indexOf("isSubagentResumeAction") < genericValidationIndex,
		"Rush resume guard should run before generic subagent validation",
	);
	assert(
		toolCall.lastIndexOf('subagentCallTargetsAgent(event.input, "developer")') < genericValidationIndex,
		"Rush developer guard should run before generic subagent validation",
	);
	assert(
		toolCall.indexOf("embeddedDelegationBlockedReason") < genericValidationIndex,
		"Embedded delegation block check should run before generic subagent validation",
	);
	assert(
		toolCall.indexOf("allowEmbeddedTargets") < genericValidationIndex,
		"allowEmbeddedTargets computation should appear before generic subagent validation",
	);
	const requestedEmbeddedTargetsIndex = toolCall.indexOf(
		"const requestedEmbeddedTargets = collectSubagentCallTargetsMatching(event.input, isEmbeddedSubagentTarget)",
	);
	const embeddedAuthorizationScanIndex = toolCall.indexOf("loadAuthorizedEmbeddedSubagentRuntimeNames(getAgentDir())");
	assert(
		requestedEmbeddedTargetsIndex < embeddedAuthorizationScanIndex,
		"Embedded target collection should happen before the authorization scan",
	);
	assert(
		toolCall.indexOf("if (requestedEmbeddedTargets.length > 0)") < embeddedAuthorizationScanIndex,
		"Embedded authorization scan should be gated behind an actual embedded target request",
	);
});

test("child runtime wires commit attribution prompt and bash guard without primary controls", () => {
	const childRuntime = sourceSection(
		primaryRuntimeSource,
		"function registerChildSubagentRuntime",
		"\n\nfunction createTlhPrimaryAgentRuntime",
	);
	const registerBlock = sourceSection(
		primaryRuntimeSource,
		"export function registerTlhPrimaryAgentRuntime",
		"const runtime = createTlhPrimaryAgentRuntime",
	);

	assert.match(childRuntime, /pi\.on\("before_agent_start"/);
	assert.match(childRuntime, /const childAgentName = env\.PI_SUBAGENT_CHILD_AGENT;/);
	assert.match(childRuntime, /buildChildExperimentalPrompt\(childAgentName, settings\.tlh\?\.experimental\)/);
	assert.match(childRuntime, /buildTlhCommitAttributionPrompt\(commitAttributionState\)/);
	assert.match(childRuntime, /pi\.on\("tool_call"/);
	assert.match(childRuntime, /if \(event\.toolName !== "bash"\)/);
	assert.match(childRuntime, /getTlhGitCommitAttributionBlockReason\(event\.input\.command, commitAttributionState\)/);
	assert.match(registerBlock, /const env = options\.env \?\? process\.env;/);
	assert.match(registerBlock, /registerChild: \(\) => \{/);
	assert.match(registerBlock, /registerChildSubagentRuntime\(pi, childPromptBuilder, env\);/);
});

test("extension wires subscription usage to lifecycle refreshes and footer", () => {
	const sessionStart = sourceSection(extensionSource, 'pi.on("session_start"', "\n\t});\n}");

	assert.match(extensionSource, /createLazyTlhSubscriptionUsageService\(\)/);
	assert.match(extensionSource, /pi\.on\("model_select"/);
	assert.match(extensionSource, /pi\.on\("turn_end"/);
	assert.match(extensionSource, /subscriptionUsageService\.refresh\(ctx, options\)/);
	assert.match(
		sessionStart,
		/subscriptionUsageService\.registerFooterRenderRequest\(ctx, \(\) => tui\.requestRender\(\)\)/,
	);
	assert.match(sessionStart, /refreshSubscriptionUsage\(ctx\)/);
	assert.match(sessionStart, /subscriptionUsage: subscriptionUsageService/);
	assert.match(sessionStart, /shouldShowWeekly: getCachedTlhUsageWeeklyVisibility/);
	assert.match(sessionStart, /onChange: \(\) => tui\.requestRender\(\)/);
	assert.match(
		sessionStart,
		/typeof footerData\?\.onBranchChange === "function" \? \(cb\) => footerData\.onBranchChange\(cb\) : undefined/,
	);
	assert.match(subscriptionUsageFacadeSource, /import\("\.\/subscription-usage\.js"\)/);
	assert.match(subscriptionUsageFacadeSource, /createTlhSubscriptionUsageService\(\)/);
});

test("extension wires TLH changelog lazy facade and release-notes rendering", () => {
	assert.match(
		extensionSource,
		/pi\.registerCommand\("tlh-changelog", \{[\s\S]*description: TLH_CHANGELOG_COMMAND_DESCRIPTION,[\s\S]*const handler = await getTlhChangelogCommandHandler\(\);/,
	);
	assert.match(
		changelogSource,
		/export const TLH_CHANGELOG_COMMAND_DESCRIPTION = "Show TLH release notes from the packaged changelog";/,
	);
	assert.match(
		changelogSource,
		/export async function handleTlhChangelogCommand\(\s*pi:\s*ExtensionAPI,\s*_args:\s*string,\s*ctx:\s*ExtensionCommandContext,?\s*\):\s*Promise<void>/,
	);
	assert.match(changelogSource, /pi\.registerCommand\("tlh-changelog"/);
	assert.match(changelogSource, /new Markdown\(changelog/);
	assert.match(changelogSource, /ctx\.ui\.custom/);
	assert.match(changelogSource, /pi\.sendMessage\(\{/);
});

test("extension keeps TLH experimental command wiring with registered ticket, ci, and review feature flags", () => {
	const backupWriteHelper = sourceSection(
		profileStateSource,
		"const SETTINGS_BACKUP_SUFFIX_RETRY_LIMIT = 32;",
		"function getSettingsStorageForWrite",
	);
	const lockedWriteHelper = sourceSection(
		profileStateSource,
		"export function withLockedTlhSettingsWrite",
		"export function assertSafeTlhSettingsPath",
	);

	assert.match(extensionSource, /registerExperimentalCommand\(pi\)/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/experimental\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/ticket-workflow-ui-facade\.js"/);
	assert.match(extensionSource, /registerLazyTlhTicketWorkflowUi\(pi\)/);
	assert.doesNotMatch(extensionSource, /from "\.\/the-last-harness\/ticket-workflow-ui\.js"/);
	assert.match(ticketWorkflowUiFacadeSource, /import\("\.\/ticket-workflow-ui\.js"\)/);
	assert.match(ticketWorkflowUiFacadeSource, /createRetryableLazyImport/);
	assert.match(experimentalSource, /pi\.registerCommand\("experimental"/);
	assert.match(experimentalSource, /import\("\.\/experimental-command\.js"\)/);
	assert.match(experimentalSource, /delta-follow-up-reviews/);
	assert.match(experimentalSource, /ci-failure-investigation/);
	assert.doesNotMatch(experimentalSource, /ticket-workflow-ui/);
	assert.doesNotMatch(experimentalSource, /## TLH Experimental Feature: contrarian/);
	assert.doesNotMatch(experimentalSource, /Enables the contrarian minor agent and primary-agent guidance/);
	assert.doesNotMatch(experimentalSource, /run-tests-last/);
	assert.match(
		experimentalCommandSource,
		/withLockedTlhSettingsWrite\(\s*cwd,\s*"Refusing to write experimental settings outside the isolated TLH profile\./,
	);
	assert.doesNotMatch(experimentalCommandSource, /tlhSettingsPathForWrite\(\)/);
	assert.doesNotMatch(experimentalCommandSource, /assertSafeTlhSettingsPath\(settingsPath\)/);
	assert.match(experimentalCommandSource, /settings\.tlh\.experimental\.enabledFeatures = nextEnabledFeatures/);
	assert.match(typesSource, /experimental\?: TlhExperimentalConfig;/);
	assert.match(typesSource, /enabledFeatures\?: string\[];/);
	assert.match(typesSource, /export type TlhExperimentalFeatureId = string;/);
	assert.match(primaryRuntimeSource, /from "\.\/experimental\.js"/);
	assert.match(primaryRuntimeSource, /buildPrimaryExperimentalPrompt\(primary, settings\.tlh\?\.experimental\)/);
	assert.doesNotMatch(extensionSource, /registerTlhCommitAttributionRuntime\(pi\)/);
	assert.match(extensionSource, /registerToggleTlhGitAttributionCommand\(pi\)/);
	assert.match(attributionSource, /import\("\.\/attribution-command\.js"\)/);
	assert.doesNotMatch(attributionSource, /pi\.on\("before_agent_start"/);
	assert.doesNotMatch(attributionSource, /pi\.on\("tool_call"/);
	assert.doesNotMatch(attributionSource, /user_bash/);
	assert.match(attributionSource, /pi\.registerCommand\("toggle-tlh-git-attribution"/);
	assert.doesNotMatch(attributionSource, /pi\.registerCommand\("attribution"/);
	assert.doesNotMatch(attributionSource, /value: "toggle"/);
	assert.match(attributionCommandSource, /Usage: \/toggle-tlh-git-attribution/);
	assert.match(
		attributionCommandSource,
		/withLockedTlhSettingsWrite\(\s*cwd,\s*"Refusing to write attribution settings outside the isolated TLH profile\./,
	);
	assert.doesNotMatch(attributionCommandSource, /tlhSettingsPathForWrite\(\)/);
	assert.doesNotMatch(attributionCommandSource, /assertSafeTlhSettingsPath\(settingsPath\)/);
	assert.match(attributionSource, /TLH_DEFAULT_COMMIT_ATTRIBUTION/);
	assert.match(attributionCommandSource, /settings\.tlh\.attribution = \{ commit: nextEnabled \}/);
	assert.match(attributionCommandSource, /typeof commit !== "boolean"/);
	assert.match(typesSource, /commit\?: boolean;/);
	assert.match(extensionSource, /pi\.registerCommand\("tokens", \{/);
	assert.match(extensionSource, /const handler = await getTokensCommandHandler\(\);/);
	assert.match(tokensSource, /pi\.registerCommand\("tokens"/);
	assert.match(tokensSource, /Usage: \/tokens/);
	assert.match(extensionSource, /registerUsageCommand\(pi\)/);
	assert.match(usageLimitsSource, /import\("\.\/usage-limits-command\.js"\)/);
	assert.match(usageLimitsSource, /pi\.registerCommand\("usage"/);
	assert.match(usageLimitsSource, /value: "weekly on"/);
	assert.match(usageLimitsSource, /value: "weekly off"/);
	assert.match(usageLimitsSource, /value: "weekly toggle"/);
	assert.match(
		usageLimitsCommandSource,
		/withLockedTlhSettingsWrite\(\s*cwd,\s*"Refusing to write usage-limit settings outside the isolated TLH profile\./,
	);
	assert.doesNotMatch(usageLimitsCommandSource, /tlhSettingsPathForWrite\(\)/);
	assert.doesNotMatch(usageLimitsCommandSource, /assertSafeTlhSettingsPath\(settingsPath\)/);
	assert.match(lockedWriteHelper, /const settingsPath = tlhSettingsPathForWrite\(\);/);
	assert.match(lockedWriteHelper, /assertSafeTlhSettingsPath\(settingsPath\);/);
	assert.match(backupWriteHelper, /const SETTINGS_BACKUP_SUFFIX_RETRY_LIMIT = 32;/);
	assert.match(
		backupWriteHelper,
		/function writeCollisionSafeSettingsBackup\(settingsPath: string, current: string\): string \{/,
	);
	assert.match(backupWriteHelper, /const timestamp = settingsBackupTimestamp\(\);/);
	assert.match(
		backupWriteHelper,
		/suffix === 0 \? `\$\{settingsPath\}\.bak-\$\{timestamp\}` : `\$\{settingsPath\}\.bak-\$\{timestamp\}-\$\{suffix\}`/,
	);
	assert.match(
		backupWriteHelper,
		/writeFileSync\(backupPath, current, \{ encoding: "utf8", flag: "wx", mode: 0o600 \}\);/,
	);
	assert.match(backupWriteHelper, /if \(!isRecord\(error\) \|\| error\.code !== "EEXIST"\) \{/);
	assert.match(backupWriteHelper, /throw error;/);
	assert.match(
		backupWriteHelper,
		/Could not create a unique TLH settings backup after \$\{SETTINGS_BACKUP_SUFFIX_RETRY_LIMIT \+ 1\} attempts/,
	);
	assert.match(lockedWriteHelper, /if \(current\) \{/);
	assert.match(lockedWriteHelper, /const backupPath = writeCollisionSafeSettingsBackup\(settingsPath, current\);/);
	assert.match(usageLimitsCommandSource, /settings\.tlh\.usageLimits\.showWeekly = showWeekly/);
	assert.match(usageLimitsCommandSource, /showWeekly === true/);
});
