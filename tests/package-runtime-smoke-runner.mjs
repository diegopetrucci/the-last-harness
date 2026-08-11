import assert from "node:assert/strict";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const [packageRoot, cwd, agentDir] = process.argv.slice(2);
assert.ok(packageRoot && cwd && agentDir, "usage: package-runtime-smoke-runner.mjs <package-root> <cwd> <agent-dir>");
const realPackageRoot = realpathSync(packageRoot);
const configuredSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
assert.deepEqual(configuredSettings.packages, [realPackageRoot]);

const piEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piPackage = JSON.parse(readFileSync(join(dirname(piEntryPath), "..", "package.json"), "utf8"));
assert.equal(piPackage.version, "0.84.1");

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
	"subagent-settings",
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

class FakeEvents {
	#handlers = new Map();

	on(event, handler) {
		const handlers = this.#handlers.get(event) ?? [];
		handlers.push(handler);
		this.#handlers.set(event, handlers);
		return () => {
			const current = this.#handlers.get(event) ?? [];
			this.#handlers.set(
				event,
				current.filter((candidate) => candidate !== handler),
			);
		};
	}

	async emit(event, data) {
		await Promise.all((this.#handlers.get(event) ?? []).map((handler) => handler(data)));
	}

	listenerCount(event) {
		return (this.#handlers.get(event) ?? []).length;
	}
}

const packagedEvents = new FakeEvents();
const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	eventBus: packagedEvents,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function installPackedChildShim() {
	const shimPath = join(cwd, "packed-pi-shim");
	const childCliPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"extensions",
		"subagents",
		"test",
		"support",
		"real-session-child-cli.mjs",
	);
	writeFileSync(shimPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(childCliPath)} "$@"\n`);
	chmodSync(shimPath, 0o755);
	return shimPath;
}

async function runPackedChildSmoke(subagentExtension, sessionContext) {
	const marker = "PACKED_FAUX_CHILD_MARKER";
	const extensionEvidencePath = join(cwd, "packed-child-extensions.json");
	const shimPath = installPackedChildShim();
	const childEnv = {
		PI_SUBAGENT_PI_BINARY: shimPath,
		PI_SUBAGENTS_E2E_CHILD_TEXT: marker,
		PI_SUBAGENTS_E2E_EXTENSIONS_FILE: extensionEvidencePath,
	};
	const previousChildEnv = Object.fromEntries(Object.keys(childEnv).map((key) => [key, process.env[key]]));
	try {
		Object.assign(process.env, childEnv);
		const subagentTool = subagentExtension.tools.get("subagent").definition;
		const result = await subagentTool.execute(
			"packed-child-execution",
			{ agent: "worker", task: "Return the deterministic faux child marker", context: "fresh", agentScope: "user" },
			new AbortController().signal,
			undefined,
			sessionContext,
		);
		assert.equal(result.isError, undefined);
		const text = result.content
			.filter((entry) => entry.type === "text")
			.map((entry) => entry.text)
			.join("\n");
		assert.match(text, new RegExp(marker));
		const evidence = JSON.parse(readFileSync(extensionEvidencePath, "utf8"));
		assert.deepEqual(evidence.errors, []);
		const expected = [
			join(realPackageRoot, "extensions", "subagents", "src", "runs", "shared", "subagent-prompt-runtime.js"),
		];
		const resolvedChildExtensionPaths = evidence.resolvedPaths.map((path) => realpathSync(path));
		assert.deepEqual(resolvedChildExtensionPaths, expected);
		assert.ok(resolvedChildExtensionPaths.every((path) => path.startsWith(realPackageRoot) && path.endsWith(".js")));
		return {
			marker,
			childExtensionPaths: resolvedChildExtensionPaths.map((path) =>
				relative(realPackageRoot, path).replaceAll("\\", "/"),
			),
		};
	} finally {
		for (const [key, value] of Object.entries(previousChildEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function inspectLoad() {
	const result = resourceLoader.getExtensions();
	assert.deepEqual(result.errors, []);
	const resolvedEntrypoints = result.extensions.map((extension) => realpathSync(extension.resolvedPath));
	assert.deepEqual(
		resolvedEntrypoints.map((path) => relative(realPackageRoot, path).replaceAll("\\", "/")),
		expectedEntrypoints,
	);
	assert.equal(
		resolvedEntrypoints.some((path) => path.endsWith(".ts")),
		false,
	);
	const resolvedPackageRoots = result.extensions.map((extension) => {
		assert.equal(extension.sourceInfo?.scope, "user");
		assert.equal(extension.sourceInfo?.origin, "package");
		assert.equal(realpathSync(extension.sourceInfo.source), realPackageRoot);
		return realpathSync(extension.sourceInfo.baseDir);
	});
	assert.deepEqual([...new Set(resolvedPackageRoots)], [realPackageRoot]);

	const [annotateExtension, tlhExtension, subagentExtension] = result.extensions;
	assert.deepEqual([...annotateExtension.commands.keys()], ["annotate-git-diff"]);
	assert.deepEqual([...tlhExtension.commands.keys()].sort(), expectedTlhCommands);
	assert.deepEqual([...subagentExtension.tools.keys()].sort(), ["subagent"]);

	const allCommandNames = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
	assert.equal(new Set(allCommandNames).size, allCommandNames.length, "package commands must not be registered twice");
	const allToolNames = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
	const toolCounts = {
		subagent: allToolNames.filter((name) => name === "subagent").length,
	};
	assert.deepEqual(toolCounts, { subagent: 1 }, "loaded package entrypoints must expose one subagent surface");
	return {
		result,
		tlhExtension,
		toolCounts,
		packageResolution: {
			configuredPackage: realPackageRoot,
			resolvedPackageRoots: [...new Set(resolvedPackageRoots)],
			entrypointCount: resolvedEntrypoints.length,
			scope: subagentExtension.sourceInfo.scope,
			origin: subagentExtension.sourceInfo.origin,
		},
	};
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
const defaultOff = inspectLoad();
await runSessionStart(defaultOff.tlhExtension, defaultOff.result.extensions[2]);

await resourceLoader.reload();
const first = inspectLoad();
await runSessionStart(first.tlhExtension, first.result.extensions[2]);
assert.equal(first.result.extensions[2].resolvedPath.endsWith("extensions/subagents/src/extension/index.js"), true);

await resourceLoader.reload();
const second = inspectLoad();
assert.notEqual(second.result.extensions[0], first.result.extensions[0]);
assert.notEqual(second.result.extensions[1], first.result.extensions[1]);
assert.notEqual(second.result.extensions[2], first.result.extensions[2]);
assert.notEqual(second.result.extensions[0].commands, first.result.extensions[0].commands);
assert.notEqual(second.result.extensions[1].commands, first.result.extensions[1].commands);
assert.notEqual(second.result.extensions[2].tools, first.result.extensions[2].tools);
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
const failedSubagentPatch = await subagentToolResultHandler(
	{
		type: "tool_result",
		toolName: "subagent",
		toolCallId: "package-smoke-failure",
		input: { agent: "__tlh_missing_agent__", task: "exercise Pi 0.83 failure patch" },
		content: failedSubagentResult.content,
		details: failedSubagentResult.details,
		isError: false,
	},
	secondSession.context,
);
assert.deepEqual(failedSubagentPatch, { isError: true });
const childEnvSentinels = {
	PI_SUBAGENT_PI_BINARY: "restore-packed-pi-binary",
	PI_SUBAGENTS_E2E_CHILD_TEXT: "restore-packed-child-text",
	PI_SUBAGENTS_E2E_EXTENSIONS_FILE: "restore-packed-extensions-file",
};
Object.assign(process.env, childEnvSentinels);
let packagedChild;
let childEnvRestored;
try {
	packagedChild = await runPackedChildSmoke(subagentExtension, secondSession.context);
	childEnvRestored = Object.entries(childEnvSentinels).every(([key, value]) => process.env[key] === value);
	assert.equal(childEnvRestored, true);
} finally {
	for (const key of Object.keys(childEnvSentinels)) delete process.env[key];
}

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

const reviewUiPath = join(realPackageRoot, "extensions", "annotate-git-diff", "ui.js");
const annotateUiPath = join(realPackageRoot, "extensions", "the-last-harness", "annotate-last-message", "ui.js");
const piArgsPath = join(realPackageRoot, "extensions", "subagents", "src", "runs", "shared", "pi-args.js");
const { buildPiArgs } = await import(pathToFileURL(piArgsPath).href);
const childPiArgs = buildPiArgs({
	baseArgs: [],
	task: "packaged child path smoke",
	sessionEnabled: false,
	inheritProjectContext: false,
	inheritSkills: false,
	tools: ["subagent"],
}).args;
const childExtensionPaths = childPiArgs.flatMap((arg, index) =>
	arg === "--extension" ? [childPiArgs[index + 1]] : [],
);
const builtChildExtensionPaths = childExtensionPaths.map((path) => realpathSync(path));
assert.equal(builtChildExtensionPaths.length, 1);
assert.equal(
	builtChildExtensionPaths.every((path) => path.endsWith(".js") && path.startsWith(realPackageRoot)),
	true,
);
assert.equal(
	builtChildExtensionPaths.some((path) => path.endsWith("subagent-prompt-runtime.js")),
	true,
);
assert.equal(
	builtChildExtensionPaths.every((path) => !path.endsWith("fanout-child.js")),
	true,
);

const { buildReviewHtml } = await import(pathToFileURL(reviewUiPath).href);
const { buildAnnotateLastMessageHtml } = await import(pathToFileURL(annotateUiPath).href);
const reviewHtml = buildReviewHtml({ files: [], scope: { mode: "all" } });
const annotateHtml = buildAnnotateLastMessageHtml({ text: "packaged generated asset smoke" });
assert.match(reviewHtml, /<!doctype html>/i);
assert.doesNotMatch(reviewHtml, /__INLINE_(?:DATA|JS|ASSET_CONFIG)__/);
assert.match(annotateHtml, /packaged generated asset smoke/);
assert.doesNotMatch(annotateHtml, /__INLINE_(?:DATA|JS)__/);

for (const handler of subagentExtension.handlers.get("session_shutdown") ?? []) {
	await handler({ type: "session_shutdown", reason: "quit" }, secondSession.context);
}

process.stdout.write(
	`${JSON.stringify({
		piVersion: piPackage.version,
		entrypoints: expectedEntrypoints,
		commands: expectedTlhCommands,
		packageResolution: second.packageResolution,
		toolCounts: second.toolCounts,
		factoryExecutions: 3,
		failedSubagentPatched: failedSubagentPatch.isError,
		childExecution: packagedChild,
		childEnvRestored,
		childExtensionPaths: packagedChild.childExtensionPaths,
		builtChildExtensionPaths: builtChildExtensionPaths.map((path) =>
			relative(realPackageRoot, path).replaceAll("\\", "/"),
		),
		changelogBytes: sentMessages[0].content.length,
		reviewHtmlBytes: reviewHtml.length,
		annotateHtmlBytes: annotateHtml.length,
	})}\n`,
);
