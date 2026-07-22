import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const [packageRoot, cwd, agentDir] = process.argv.slice(2);
assert.ok(packageRoot && cwd && agentDir, "usage: package-runtime-smoke-runner.mjs <package-root> <cwd> <agent-dir>");

const piEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piPackage = JSON.parse(readFileSync(join(dirname(piEntryPath), "..", "package.json"), "utf8"));
assert.equal(piPackage.version, "0.81.1");

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
	"extensions/rtk.js",
	"extensions/the-last-harness.js",
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

	const [annotateExtension, rtkExtension, tlhExtension] = result.extensions;
	assert.deepEqual([...annotateExtension.commands.keys()], ["annotate-git-diff"]);
	assert.equal(rtkExtension.handlers.get("tool_call")?.length, 1);
	assert.deepEqual([...tlhExtension.commands.keys()].sort(), expectedTlhCommands);

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
		},
		getContextUsage: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => false,
		ui: {
			addAutocompleteProvider() {},
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

async function runSessionStart(tlhExtension) {
	const fixture = createSessionContext();
	for (const handler of tlhExtension.handlers.get("session_start") ?? []) {
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
await runSessionStart(first.tlhExtension);

await resourceLoader.reload();
const second = inspectLoad();
assert.notEqual(second.result.extensions[0], first.result.extensions[0]);
assert.notEqual(second.result.extensions[1], first.result.extensions[1]);
assert.notEqual(second.result.extensions[2], first.result.extensions[2]);
assert.notEqual(second.result.extensions[0].commands, first.result.extensions[0].commands);
assert.notEqual(second.result.extensions[1].handlers, first.result.extensions[1].handlers);
assert.notEqual(second.result.extensions[2].commands, first.result.extensions[2].commands);
await runSessionStart(second.tlhExtension);

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
	changelogBytes: sentMessages[0].content.length,
	reviewHtmlBytes: reviewHtml.length,
	annotateHtmlBytes: annotateHtml.length,
})}\n`);
