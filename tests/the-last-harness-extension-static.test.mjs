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
const rtkExtensionSource = readFileSync(new URL("../extensions/rtk.ts", import.meta.url), "utf8");
const rtkExtensionLicenseSource = readFileSync(new URL("../extensions/rtk.APACHE-2.0.txt", import.meta.url), "utf8");
const annotateGitDiffSource = readFileSync(new URL("../extensions/annotate-git-diff/index.ts", import.meta.url), "utf8");
const annotateGitDiffAppSource = readFileSync(new URL("../extensions/annotate-git-diff/web/app.js", import.meta.url), "utf8");
const annotateGitDiffHtmlSource = readFileSync(new URL("../extensions/annotate-git-diff/web/index.html", import.meta.url), "utf8");
const attributionSource = readFileSync(new URL("../extensions/the-last-harness/attribution.ts", import.meta.url), "utf8");
const attributionCommandSource = readFileSync(new URL("../extensions/the-last-harness/attribution-command.ts", import.meta.url), "utf8");
const changelogSource = readFileSync(new URL("../extensions/the-last-harness/changelog.ts", import.meta.url), "utf8");
const experimentalSource = readFileSync(new URL("../extensions/the-last-harness/experimental.ts", import.meta.url), "utf8");
const experimentalCommandSource = readFileSync(new URL("../extensions/the-last-harness/experimental-command.ts", import.meta.url), "utf8");
const ticketWorkflowUiFacadeSource = readFileSync(new URL("../extensions/the-last-harness/ticket-workflow-ui-facade.ts", import.meta.url), "utf8");
const footerFirstLineSource = readFileSync(new URL("../extensions/the-last-harness/footer-first-line.ts", import.meta.url), "utf8");
const footerGitCacheSource = readFileSync(new URL("../extensions/the-last-harness/footer-git-cache.ts", import.meta.url), "utf8");
const subscriptionUsageFacadeSource = readFileSync(new URL("../extensions/the-last-harness/subscription-usage-facade.ts", import.meta.url), "utf8");
const primaryRuntimeSource = readFileSync(new URL("../extensions/the-last-harness/primary-agent-runtime.ts", import.meta.url), "utf8");
const effortSource = readFileSync(new URL("../extensions/the-last-harness/effort.ts", import.meta.url), "utf8");
const effortCommandSource = readFileSync(new URL("../extensions/the-last-harness/effort-command.ts", import.meta.url), "utf8");
const promptsSource = readFileSync(new URL("../extensions/the-last-harness/prompts.ts", import.meta.url), "utf8");
const tokensSource = readFileSync(new URL("../extensions/the-last-harness/tokens.ts", import.meta.url), "utf8");
const usageLimitsSource = readFileSync(new URL("../extensions/the-last-harness/usage-limits.ts", import.meta.url), "utf8");
const usageLimitsCommandSource = readFileSync(new URL("../extensions/the-last-harness/usage-limits-command.ts", import.meta.url), "utf8");
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

function escapeRegex(value) {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function extractMonacoRuntimeSource(html) {
	const runtimeSourceMatch = html.match(/<script>\n([\s\S]*?)\n<\/script>\n<script>\nwindow\.__reviewMonacoWorkerSource =/);
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
	const moduleAst = ts.createSourceFile("monaco-module.js", moduleAndFollowingSource, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
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
	assert.match(targetModuleSource, /\.language\s*=|\blanguage:/, `Monaco ${id} chunk must export tokenizer/runtime data`);
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
		"./extensions/annotate-git-diff/index.js",
		"./extensions/rtk.js",
		"./extensions/the-last-harness.js",
	]);
	assert.deepEqual(existingNestedExtensionEntrypoints("the-last-harness"), []);
	assert.deepEqual(existingNestedExtensionEntrypoints("annotate-git-diff"), [
		"annotate-git-diff/index.ts",
		"annotate-git-diff/index.js",
	]);
	assert.deepEqual(discoverPiExtensionEntrypoints(extensionsDir), [
		"annotate-git-diff/index.js",
		"annotate-git-diff/index.ts",
		"rtk.js",
		"rtk.ts",
		"the-last-harness.js",
		"the-last-harness.ts",
	]);
});


test("vendored RTK extension records Apache provenance and stays rewrite-only", () => {
	assert.match(rtkExtensionSource, /Vendored from rtk-ai\/rtk v0\.42\.4 \(hooks\/pi\/rtk\.ts\), Apache-2\.0\./);
	assert.match(rtkExtensionSource, /See \.\/rtk\.APACHE-2\.0\.txt for the upstream license text and provenance\./);
	assert.match(rtkExtensionLicenseSource, /This file applies to the vendored extension source at extensions\/rtk\.ts\./);
	assert.match(rtkExtensionLicenseSource, /Upstream project: https:\/\/github\.com\/rtk-ai\/rtk/);
	assert.match(rtkExtensionLicenseSource, /Upstream tag: v0\.42\.4/);
	assert.match(rtkExtensionLicenseSource, /Upstream path: hooks\/pi\/rtk\.ts/);
	assert.match(rtkExtensionLicenseSource, /Apache License\s+Version 2\.0, January 2004/);
	assert.match(rtkExtensionSource, /RTK_DISABLED=1 and the isolated-profile setting tlh\.rtk\.disabled/);
	assert.match(rtkExtensionSource, /join\(getAgentDir\(\), "bin", "rtk"\)/);
	assert.match(rtkExtensionSource, /pi\.exec\(command, \["--version"\]/);
	assert.match(rtkExtensionSource, /pi\.exec\(rtkCommand, \["rewrite", cmd\]/);
	assert.doesNotMatch(rtkExtensionSource, /pi\.registerCommand\(/);
	assert.doesNotMatch(rtkExtensionSource, /"\/rtk"/);
	assert.match(typesSource, /export type TlhRtkConfig = \{[\s\S]*disabled\?: boolean;/);
	assert.match(typesSource, /rtk\?: TlhRtkConfig;/);
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
		'  return { language: true };',
		'});',
		' \t ',
		'  define("second", [], function () {',
		'    return { conf: true };',
		'  });',
	].join("\n");
	assert.equal(
		extractMonacoModuleSource(whitespaceSeparatedRuntimeSource, "first"),
		[
			'define("first", [], function () {',
			'  return { language: true };',
			'});',
		].join("\n"),
	);
	assert.equal(
		extractMonacoModuleSource(whitespaceSeparatedRuntimeSource, "second"),
		[
			'define("second", [], function () {',
			'    return { conf: true };',
			'  });',
		].join("\n"),
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
	assert.doesNotMatch(html, /file:\/\/[^\s'"]*node_modules/, "built HTML must not contain file:// URLs into node_modules");

	// Monaco editor JS is inlined (editor.main.js defines 'vs/editor/editor.main').
	assert.match(html, /define\("vs\/editor\/editor\.main"/, "editor.main.js content must be inlined");
	assert.match(html, /"bootstrapError":null/, "packaged review assets should load without a bootstrap error");

	// Monaco editor CSS is inlined (editor.main.css contains '.monaco-editor').
	assert.match(html, /\.monaco-editor/, "editor.main.css content must be inlined");

	// Monaco worker source is inlined as a non-empty bundled script.
	const workerSource = parseInlineJsonStringAssignment(html, "window.__reviewMonacoWorkerSource");
	assert.ok(workerSource.trim().length > 1024, "editor worker bundle must be a non-empty inlined script");
	assert.match(workerSource, /(?:self|globalThis)\.onmessage\b|onmessage\s*=/, "editor worker bundle must register a worker message handler");
	assert.match(workerSource, /\bpostMessage\b/, "editor worker bundle must communicate with the host");

	// No unreplaced template markers.
	assert.doesNotMatch(html, /__INLINE_MONACO_EDITOR_JS__/);
	assert.doesNotMatch(html, /__INLINE_MONACO_EDITOR_CSS__/);
	assert.doesNotMatch(html, /__INLINE_MONACO_WORKER_SOURCE_JSON__/);
	assert.doesNotMatch(html, /__INLINE_MONACO_BASIC_LANGUAGES_JS__/, "__INLINE_MONACO_BASIC_LANGUAGES_JS__ marker must be replaced");

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
	assert.match(applyPrimaryDefaults, /getUnfilteredAvailableModels\(ctx\.modelRegistry\)/);
	assert.match(applyPrimaryDefaults, /selectProviderAwareAgentDefaults\(primary, availableModels, ctx\.model\?\.provider\)/);
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
	assert.match(beforeAgentStart, /buildTlhSystemPrompt\(activePrimaryAgent\(\), subagentMetadata, primaryEnabled, settings\.tlh\?\.experimental\)/);
});

test("primary and child prompts do not include disabled-ticket fallback guidance", () => {
	const primaryAgents = loadPrimaryAgents();
	const architect = primaryAgents.get("architect");
	const rush = primaryAgents.get("rush");
	assert.ok(architect, "architect primary prompt should load");
	assert.ok(rush, "Rush primary prompt should load");
	assert.deepEqual(architect.tlhOpenaiModels, ["openai-codex/gpt-5.6-sol"]);
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
	assert.deepEqual(
		loadSubagentMetadata().find((agent) => agent.name === "code-reviewer")?.tlhOpenaiModels,
		["openai-codex/gpt-5.6-sol"],
	);
	assert.deepEqual(
		loadSubagentMetadata().find((agent) => agent.name === "oracle")?.tlhOpenaiModels,
		["openai-codex/gpt-5.6-sol"],
	);
	assert.deepEqual(
		loadSubagentMetadata().find((agent) => agent.name === "contrarian")?.tlhOpenaiModels,
		["openai-codex/gpt-5.6-sol"],
	);

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
	assert.match(extensionSource, /const REVIEW_COMMAND_DESCRIPTION = "Review code changes via an interactive mode picker";/);
	assert.match(extensionSource, /const TOKENS_COMMAND_DESCRIPTION = "Generate and open a local TLH token-spend report";/);
	assert.match(extensionSource, /const ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION = "Open a native annotation window for the latest assistant message";/);
	assert.match(extensionSource, /const TLH_CHANGELOG_COMMAND_DESCRIPTION = "Show TLH release notes from the packaged changelog";/);
	assert.match(extensionSource, /function createRetryableLazyImport<TModule>\(loader: \(\) => Promise<TModule>\): \(\) => Promise<TModule> \{/);
	assert.match(extensionSource, /modulePromise = loader\(\)\.catch\(\(error\) => \{[\s\S]*modulePromise = undefined;[\s\S]*throw error;/);
	assert.match(extensionSource, /pi\.registerCommand\("review", \{[\s\S]*getArgumentCompletions: \(\) => null,[\s\S]*const handler = await getReviewCommandHandler\(\);/);
	assert.match(extensionSource, /pi\.registerCommand\("tokens", \{[\s\S]*const handler = await getTokensCommandHandler\(\);/);
	assert.match(extensionSource, /pi\.registerCommand\("annotate-last-message", \{[\s\S]*const command = await getAnnotateLastMessageCommand\(\);/);
	assert.match(extensionSource, /pi\.registerCommand\("tlh-changelog", \{[\s\S]*const handler = await getTlhChangelogCommandHandler\(\);[\s\S]*await handler\(pi, args, ctx\);/);
	assert.match(extensionSource, /annotateLastMessageCommandPromise = loadAnnotateLastMessageModule\(\)[\s\S]*buildAnnotateLastMessageCommand\(\)/);
	assert.match(extensionSource, /tlhChangelogCommandHandlerPromise = loadTlhChangelogModule\(\)[\s\S]*handleTlhChangelogCommand/);
	assert.match(extensionSource, /pi\.on\("session_shutdown", async \(\) => \{[\s\S]*if \(!annotateLastMessageCommandPromise\) \{[\s\S]*return;[\s\S]*const command = await annotateLastMessageCommandPromise;[\s\S]*command\.handleSessionShutdown\(\);/);
	assert.doesNotMatch(extensionSource, /import\("\.\/the-last-harness\/(?:effort|thinking|experimental|version|attribution)\.js"\)/);
});

test("header, footer, and update-check stay on the eager startup path pending benchmark-proven deferment", () => {
	const sessionStart = sourceSection(extensionSource, 'pi.on("session_start"', "\n\t});\n}");

	assert.match(extensionSource, /from "\.\/the-last-harness\/footer\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/footer-git-cache\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/header\.js"/);
	assert.match(extensionSource, /from "\.\/the-last-harness\/update-check\.js"/);
	assert.doesNotMatch(extensionSource, /import\("\.\/the-last-harness\/(?:footer|footer-git-cache|header|update-check)\.js"\)/);
	assert.match(sessionStart, /const headerUpdate = getTlhHeaderUpdate\(\);/);
	assert.match(sessionStart, /void maybeNotifyAvailableTlhUpdate\(ctx\)\.catch\(\(\) => undefined\);/);
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
		/if \(event\.reason === "startup"\) \{[\s\S]*void import\("\.\/the-last-harness\/launch-telemetry\.js"\)[\s\S]*scheduleTlhLaunchTelemetry\(ctx\)[\s\S]*\.catch\(\(\) => undefined\);[\s\S]*\}/,
	);
	assert.match(sessionStart, /if \(!ctx\.hasUI\) \{[\s\S]*return;[\s\S]*if \(event\.reason === "startup"\)/);
	assert.match(sessionStart, /const headerUpdate = getTlhHeaderUpdate\(\);/);
	assert.match(sessionStart, /void maybeNotifyAvailableTlhUpdate\(ctx\)\.catch\(\(\) => undefined\);/);
	assert.doesNotMatch(extensionSource, /function maybeSendTlhLaunchTelemetry/);
	assert.doesNotMatch(extensionSource, /function fetchLatestTlhRelease/);
});

test("extension installs TLH model-visibility, package-update, and new-version-notice overrides during activation", () => {
	assert.match(extensionSource, /installTlhModelVisibilityFilter\(\)/);
	assert.match(extensionSource, /installTlhPackageUpdateNotificationOverride\(\)/);
	assert.match(extensionSource, /installTlhNewVersionNotificationOverride\(\)/);
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
	assert.match(toolCall, /applyProviderAwareSubagentModels\(event\.input, subagentsByName, getUnfilteredAvailableModels\(ctx\.modelRegistry\), ctx\.model\?\.provider, ctx\.model\)/);
	assert.match(toolCall, /const selection = currentPrimaryAgentSelection\(\)/);
	assert.match(toolCall, /const allowedSubagents = allowedSubagentsForExperimentalConfig\(getTlhGlobalSettings\(ctx\.cwd\)\.tlh\?\.experimental\)/);
	assert.match(
		toolCall,
		/if \(!isEnabledPrimaryAgentSelection\(selection\)\) \{[\s\S]*if \(!isSubagentResumeAction\(event\.input\)\) \{[\s\S]*return undefined;[\s\S]*const disabledReason = validateSubagentToolInput\(event\.input, \{ allowedSubagents \}\)/,
	);
	assert.match(toolCall, /if \(selection === "rush" && isSubagentResumeAction\(event\.input\)\)/);
	assert.match(toolCall, /if \(selection === "rush" && subagentCallTargetsAgent\(event\.input, "developer"\)\)/);
	assert.match(toolCall, /const reason = validateSubagentToolInput\(event\.input, \{ allowedSubagents \}\)/);
	assert(
		toolCall.indexOf('if (event.toolName === "bash")') < toolCall.indexOf("resolveTlhCommitAttribution"),
		"parent tool_call should resolve attribution only inside the bash branch",
	);
	assert(
		toolCall.indexOf("applyProviderAwareSubagentModels") < toolCall.indexOf("!isEnabledPrimaryAgentSelection(selection)"),
		"provider-aware subagent defaults should run before the disabled-primary guard",
	);
	const genericValidationIndex = toolCall.indexOf("const reason = validateSubagentToolInput(event.input, { allowedSubagents })");
	assert(
		toolCall.indexOf("isSubagentResumeAction") < genericValidationIndex,
		"Rush resume guard should run before generic subagent validation",
	);
	assert(
		toolCall.lastIndexOf('subagentCallTargetsAgent(event.input, "developer")') < genericValidationIndex,
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
	assert.match(sessionStart, /subscriptionUsageService\.registerFooterRenderRequest\(ctx, \(\) => tui\.requestRender\(\)\)/);
	assert.match(sessionStart, /refreshSubscriptionUsage\(ctx\)/);
	assert.match(sessionStart, /subscriptionUsage: subscriptionUsageService/);
	assert.match(sessionStart, /shouldShowTlhUsageWeekly\(getTlhUsageLimitsConfig\(ctx\.cwd\)\)/);
	assert.match(sessionStart, /onChange: \(\) => tui\.requestRender\(\)/);
	assert.match(sessionStart, /typeof footerData\?\.onBranchChange === "function" \? \(cb\) => footerData\.onBranchChange\(cb\) : undefined/);
	assert.match(subscriptionUsageFacadeSource, /import\("\.\/subscription-usage\.js"\)/);
	assert.match(subscriptionUsageFacadeSource, /createTlhSubscriptionUsageService\(\)/);
});

test("extension wires TLH changelog lazy facade and release-notes rendering", () => {
	assert.match(extensionSource, /pi\.registerCommand\("tlh-changelog", \{[\s\S]*description: TLH_CHANGELOG_COMMAND_DESCRIPTION,[\s\S]*const handler = await getTlhChangelogCommandHandler\(\);/);
	assert.match(changelogSource, /export const TLH_CHANGELOG_COMMAND_DESCRIPTION = "Show TLH release notes from the packaged changelog";/);
	assert.match(changelogSource, /export async function handleTlhChangelogCommand\(pi: ExtensionAPI, _args: string, ctx: ExtensionCommandContext\): Promise<void>/);
	assert.match(changelogSource, /pi\.registerCommand\("tlh-changelog"/);
	assert.match(changelogSource, /new Markdown\(changelog/);
	assert.match(changelogSource, /ctx\.ui\.custom/);
	assert.match(changelogSource, /pi\.sendMessage\(\{/);
});

test("extension keeps TLH experimental command wiring with registered ticket, ci, and review feature flags", () => {
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
	assert.match(experimentalSource, /ticket-workflow-ui/);
	assert.doesNotMatch(experimentalSource, /## TLH Experimental Feature: contrarian/);
	assert.doesNotMatch(experimentalSource, /Enables the contrarian minor agent and primary-agent guidance/);
	assert.doesNotMatch(experimentalSource, /run-tests-last/);
	assert.match(
		experimentalCommandSource,
		/withLockedTlhSettingsWrite\(cwd, "Refusing to write experimental settings outside the isolated TLH profile\./,
	);
	assert.doesNotMatch(experimentalCommandSource, /tlhSettingsPathForWrite\(\)/);
	assert.doesNotMatch(experimentalCommandSource, /assertSafeTlhSettingsPath\(settingsPath\)/);
	assert.match(experimentalCommandSource, /settings\.tlh\.experimental\.enabledFeatures = nextEnabledFeatures/);
	assert.match(typesSource, /experimental\?: TlhExperimentalConfig;/);
	assert.match(typesSource, /enabledFeatures\?: string\[];/);
	assert.match(typesSource, /export type TlhExperimentalFeatureId = string;/);
	assert.match(primaryRuntimeSource, /from "\.\/experimental\.js"/);
	assert.match(primaryRuntimeSource, /buildPrimaryExperimentalPrompt\(activePrimaryAgent\(\), settings\.tlh\?\.experimental\)/);
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
		/withLockedTlhSettingsWrite\(cwd, "Refusing to write attribution settings outside the isolated TLH profile\./,
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
		/withLockedTlhSettingsWrite\(cwd, "Refusing to write usage-limit settings outside the isolated TLH profile\./,
	);
	assert.doesNotMatch(usageLimitsCommandSource, /tlhSettingsPathForWrite\(\)/);
	assert.doesNotMatch(usageLimitsCommandSource, /assertSafeTlhSettingsPath\(settingsPath\)/);
	assert.match(lockedWriteHelper, /const settingsPath = tlhSettingsPathForWrite\(\);/);
	assert.match(lockedWriteHelper, /assertSafeTlhSettingsPath\(settingsPath\);/);
	assert.match(lockedWriteHelper, /if \(current\) \{/);
	assert.match(lockedWriteHelper, /const backupPath = `\$\{settingsPath\}\.bak-\$\{settingsBackupTimestamp\(\)\}`;/);
	assert.match(lockedWriteHelper, /writeFileSync\(backupPath, current, \{ encoding: "utf8", flag: "wx", mode: 0o600 \}\);/);
	assert.match(usageLimitsCommandSource, /settings\.tlh\.usageLimits\.showWeekly = showWeekly/);
	assert.match(usageLimitsCommandSource, /showWeekly === true/);
});
