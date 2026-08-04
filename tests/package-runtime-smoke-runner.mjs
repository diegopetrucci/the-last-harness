import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const [packageRoot, cwd, agentDir] = process.argv.slice(2);
assert.ok(packageRoot && cwd && agentDir, "usage: package-runtime-smoke-runner.mjs <package-root> <cwd> <agent-dir>");
const realPackageRoot = realpathSync(packageRoot);

const piEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piPackage = JSON.parse(readFileSync(join(dirname(piEntryPath), "..", "package.json"), "utf8"));
assert.equal(piPackage.version, "0.83.0");

const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	additionalExtensionPaths: [packageRoot],
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});

const expectedEntrypoints = [
	"extensions/annotate-git-diff/index.js",
	"extensions/the-last-harness.js",
	"extensions/subagents/src/extension/index.js",
];
const expectedTlhCommands = [
	"annotate-last-message",
	"effort",
	"experimental",
	"review",
	"switch-primary-agent",
	"thinking",
	"tlh-changelog",
	"toggle-context-cap",
	"toggle-tlh-git-attribution",
	"tokens",
	"usage",
	"version",
	"what-consumed-my-session-limit-and-tokens",
];

function inspectLoad() {
	const result = resourceLoader.getExtensions();
	assert.deepEqual(result.errors, []);
	assert.deepEqual(
		result.extensions.map((extension) => relative(packageRoot, extension.resolvedPath).replaceAll("\\", "/")),
		expectedEntrypoints,
	);
	assert.equal(result.extensions.some((extension) => extension.resolvedPath.endsWith(".ts")), false);

	const [annotateExtension, tlhExtension, subagentExtension] = result.extensions;
	assert.deepEqual([...annotateExtension.commands.keys()], ["annotate-git-diff"]);
	assert.deepEqual([...tlhExtension.commands.keys()].sort(), expectedTlhCommands);
	assert.deepEqual([...subagentExtension.tools.keys()].sort(), ["subagent", "wait"]);

	const allCommandNames = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
	assert.equal(new Set(allCommandNames).size, allCommandNames.length, "package commands must not be registered twice");
	return { result, tlhExtension };
}

function createSessionContext() {
	const installedFactories = { header: [], footer: [] };
	const notifications = [];
	const context = {
		mode: "rpc",
		hasUI: true,
		cwd,
		model: undefined,
		modelRegistry: {
			isUsingOAuth: () => false,
			getApiKeyForProvider: async () => undefined,
			getAvailable: () => [],
			find: () => undefined,
			authStorage: { get: () => undefined },
		},
		sessionManager: {
			getEntries: () => [],
			getCwd: () => cwd,
			getSessionName: () => undefined,
			getBranch: () => [],
			getSessionId: () => "package-smoke-session",
			getSessionFile: () => null,
		},
		getContextUsage: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => false,
		ui: {
			addAutocompleteProvider() {},
			setWidget() {},
			setFooter(factory) {
				installedFactories.footer.push(factory);
			},
			setHeader(factory) {
				installedFactories.header.push(factory);
			},
			notify(message, type) {
				notifications.push({ message, type });
			},
			getEditorText: () => "",
		},
	};
	return { context, installedFactories, notifications };
}

async function runSessionStart(tlhExtension, subagentExtension) {
	const fixture = createSessionContext();
	for (const handler of tlhExtension.handlers.get("session_start") ?? []) {
		await handler({ reason: "reload" }, fixture.context);
	}
	for (const handler of subagentExtension.handlers.get("session_start") ?? []) {
		await handler({ reason: "reload" }, fixture.context);
	}
	assert.equal(fixture.installedFactories.header.length, 1);
	assert.equal(fixture.installedFactories.footer.length, 1);
	assert.equal(typeof fixture.installedFactories.header[0], "function");
	assert.equal(typeof fixture.installedFactories.footer[0], "function");
	return fixture;
}

await resourceLoader.reload();
const first = inspectLoad();
await runSessionStart(first.tlhExtension, first.result.extensions[2]);
assert.equal(first.result.extensions[2].resolvedPath.endsWith("extensions/subagents/src/extension/index.js"), true);

await resourceLoader.reload();
const second = inspectLoad();
assert.notEqual(second.result.extensions[0], first.result.extensions[0]);
assert.notEqual(second.result.extensions[1], first.result.extensions[1]);
assert.notEqual(second.result.extensions[0].commands, first.result.extensions[0].commands);
assert.notEqual(second.result.extensions[1].commands, first.result.extensions[1].commands);
const secondSession = await runSessionStart(second.tlhExtension, second.result.extensions[2]);
const subagentExtension = second.result.extensions[2];
assert.equal(subagentExtension.resolvedPath.endsWith("extensions/subagents/src/extension/index.js"), true);

second.result.runtime.getSessionName = () => undefined;
const subagentTool = subagentExtension.tools.get("subagent").definition;
const failedSubagentResult = await subagentTool.execute(
	"package-smoke-failure",
	{ agent: "__tlh_missing_agent__", task: "exercise Pi 0.83 failure patch" },
	new AbortController().signal,
	undefined,
	secondSession.context,
);
assert.equal(Object.hasOwn(failedSubagentResult, "isError"), false);
assert.match(failedSubagentResult.content[0].text, /Unknown agent/);
assert.equal(failedSubagentResult.details.mode, "single");
const [subagentToolResultHandler] = subagentExtension.handlers.get("tool_result") ?? [];
assert.equal(typeof subagentToolResultHandler, "function");
const failedSubagentPatch = await subagentToolResultHandler({
	type: "tool_result",
	toolName: "subagent",
	toolCallId: "package-smoke-failure",
	input: { agent: "__tlh_missing_agent__", task: "exercise Pi 0.83 failure patch" },
	content: failedSubagentResult.content,
	details: failedSubagentResult.details,
	isError: false,
}, secondSession.context);
assert.deepEqual(failedSubagentPatch, { isError: true });

const sentMessages = [];
second.result.runtime.sendMessage = (message) => sentMessages.push(message);
const changelogNotifications = [];
await second.tlhExtension.commands.get("tlh-changelog").handler("", {
	hasUI: false,
	ui: {
		notify(message, type) {
			changelogNotifications.push({ message, type });
		},
	},
});
assert.deepEqual(changelogNotifications, []);
assert.equal(sentMessages.length, 1);
assert.equal(sentMessages[0].customType, "TLH release notes");
assert.match(sentMessages[0].content, /^# Changelog/m);

const reviewUiPath = join(packageRoot, "extensions", "annotate-git-diff", "ui.js");
const annotateUiPath = join(packageRoot, "extensions", "the-last-harness", "annotate-last-message", "ui.js");
const piArgsPath = join(packageRoot, "extensions", "subagents", "src", "runs", "shared", "pi-args.js");
const { buildPiArgs } = await import(pathToFileURL(piArgsPath).href);
const childPiArgs = buildPiArgs({
	baseArgs: [],
	task: "packaged child path smoke",
	sessionEnabled: false,
	inheritProjectContext: false,
	inheritSkills: false,
	tools: ["subagent"],
}).args;
const childExtensionPaths = childPiArgs.flatMap((arg, index) => arg === "--extension" ? [childPiArgs[index + 1]] : []);
assert.equal(childExtensionPaths.length, 2);
assert.equal(childExtensionPaths.every((path) => path.endsWith(".js") && path.startsWith(realPackageRoot)), true);
assert.equal(childExtensionPaths.some((path) => path.endsWith("subagent-prompt-runtime.js")), true);
assert.equal(childExtensionPaths.some((path) => path.endsWith("fanout-child.js")), true);

const { buildReviewHtml } = await import(pathToFileURL(reviewUiPath).href);
const { buildAnnotateLastMessageHtml } = await import(pathToFileURL(annotateUiPath).href);
const reviewHtml = buildReviewHtml({ files: [], scope: { mode: "all" } });
const annotateHtml = buildAnnotateLastMessageHtml({ text: "packaged generated asset smoke" });
assert.match(reviewHtml, /<!doctype html>/i);
assert.doesNotMatch(reviewHtml, /__INLINE_(?:DATA|JS|ASSET_CONFIG)__/);
assert.match(annotateHtml, /packaged generated asset smoke/);
assert.doesNotMatch(annotateHtml, /__INLINE_(?:DATA|JS)__/);

process.stdout.write(`${JSON.stringify({
	piVersion: piPackage.version,
	entrypoints: expectedEntrypoints,
	commands: expectedTlhCommands,
	factoryExecutions: 2,
	failedSubagentPatched: failedSubagentPatch.isError,
	childExtensionPaths: childExtensionPaths.map((path) => relative(realPackageRoot, path).replaceAll("\\", "/")),
	changelogBytes: sentMessages[0].content.length,
	reviewHtmlBytes: reviewHtml.length,
	annotateHtmlBytes: annotateHtml.length,
})}\n`);
