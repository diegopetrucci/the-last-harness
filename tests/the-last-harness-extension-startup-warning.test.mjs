import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { __testing, default: theLastHarness } = await jiti.import("../extensions/the-last-harness.ts");
const { TLH_STARTUP_TIPS } = await jiti.import("../extensions/the-last-harness/startup-tip.ts");
const { getTlhVersion } = await jiti.import("../extensions/the-last-harness/package-version.ts");

const TLH_HEADER_TOGGLE_SHORTCUT = "ctrl+shift+e";

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const PINNED_TAG_INSTALL_STATE = {
	repo: "diegopetrucci/the-last-harness",
	track: "pinned-tag",
	ref: "v0.10.0",
	packageSource: "git:github.com/diegopetrucci/the-last-harness@v0.10.0",
	packageSourceIsDefault: true,
};

const PINNED_TAG_LOCAL_INSTALL_STATE = {
	...PINNED_TAG_INSTALL_STATE,
	packageSource: "../the-last-harness",
	packageSourceIsDefault: false,
};

const LATEST_STABLE_INSTALL_STATE = {
	...PINNED_TAG_INSTALL_STATE,
	track: "latest-release",
};

const TEST_CONTEXT_MODEL = { contextWindow: 100_000 };

function createPi() {
	const handlers = new Map();
	const shortcuts = new Map();
	return {
		handlers,
		shortcuts,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		registerShortcut(shortcut, options) {
			shortcuts.set(shortcut, options);
		},
		appendEntry() {},
		getAllTools: () => [],
		getActiveTools: () => [],
		getThinkingLevel: () => "medium",
		setThinkingLevel() {},
		setModel: async () => true,
	};
}

function writeProjectSkill(cwd, name = "project-skill") {
	mkdirSync(join(cwd, ".pi", "skills", name), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "skills", name, "SKILL.md"),
		`---
name: ${name}
description: ${name}
---
${name} content
`,
		"utf8",
	);
}

function createCtx({
	cwd,
	notifications,
	hasUI = true,
	onSetHeader,
	onSetFooter,
	projectTrusted,
	model,
	systemPrompt = "",
}) {
	return {
		hasUI,
		cwd,
		model,
		modelRegistry: {
			isUsingOAuth: () => false,
			getApiKeyForProvider: async () => undefined,
			find: () => undefined,
			authStorage: { get: () => undefined },
		},
		sessionManager: {
			getEntries: () => [],
			getCwd: () => cwd,
			getSessionName: () => undefined,
			getBranch: () => undefined,
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => systemPrompt,
		ui: {
			addAutocompleteProvider() {},
			setFooter(factory) {
				onSetFooter?.(factory);
			},
			setHeader(factory) {
				onSetHeader?.(factory);
			},
			notify(message, type) {
				notifications.push({ message, type });
			},
			getEditorText: () => "",
		},
		isIdle: () => true,
		isProjectTrusted: () => projectTrusted,
	};
}

function startupSnapshot(resources, promptMetadata = { contextFiles: [], skills: [] }) {
	return { resources, promptMetadata };
}

function restoreEnv(previousEnv) {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

function withProcessPath(path, callback) {
	const previousPath = process.env.PATH;
	process.env.PATH = path;
	try {
		return callback();
	} finally {
		restoreEnv({ PATH: previousPath });
	}
}

function writeProfileFixture(agentDir, installState) {
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" }, telemetry: { enabled: false }, updateCheck: { enabled: false } } }, null, 2)}\n`,
	);
	writeFileSync(join(agentDir, "tlh", "install-state.json"), `${JSON.stringify(installState, null, 2)}\n`);
}

function startupTipLine(headerLines) {
	return headerLines?.find((line) => line.startsWith("Tip: "));
}

function writeStartupState(agentDir, state) {
	writeFileSync(join(agentDir, "tlh", "startup-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function readStartupState(agentDir) {
	return JSON.parse(readFileSync(join(agentDir, "tlh", "startup-state.json"), "utf8"));
}

async function createExtensionHarness({
	installState,
	setupWorkspace,
	startupResourceCollector,
	deferredStartupTaskScheduler,
}) {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-startup-warning-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "workspace");
	const emptyBinDir = join(tempDir, "empty-bin");
	const previousEnv = {
		PATH: process.env.PATH,
		PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
		TLH_SKIP_TELEMETRY: process.env.TLH_SKIP_TELEMETRY,
	};

	delete process.env.PI_SUBAGENT_CHILD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.TLH_SKIP_UPDATE_CHECK = "1";
	process.env.TLH_SKIP_TELEMETRY = "1";
	mkdirSync(cwd, { recursive: true });
	mkdirSync(emptyBinDir, { recursive: true });
	setupWorkspace?.(cwd);
	writeProfileFixture(agentDir, installState);
	__testing.reset();
	const scheduleDeferredTask = deferredStartupTaskScheduler ?? ((task) => setImmediate(task));
	__testing.setDeferredStartupTaskSchedulerForTests((task) => {
		scheduleDeferredTask(() => withProcessPath(emptyBinDir, task));
	});
	if (startupResourceCollector) {
		__testing.setStartupResourceCollectorForTests(startupResourceCollector);
	}

	const pi = createPi();
	withProcessPath(emptyBinDir, () => theLastHarness(pi));
	const sessionStartHandlers = pi.handlers.get("session_start") ?? [];
	const sessionShutdownHandlers = pi.handlers.get("session_shutdown") ?? [];
	assert.ok(sessionStartHandlers.length > 0, "session_start handler must be registered by the extension");

	return {
		agentDir,
		cwd,
		emptyBinDir,
		shortcuts: pi.shortcuts,
		async shutdownSession(ctx) {
			for (const handler of sessionShutdownHandlers) {
				await handler({}, ctx);
			}
		},
		async startSession({ reason, hasUI = true, projectTrusted, model, systemPrompt } = {}) {
			const notifications = [];
			let headerFactory;
			let footerFactory;
			let requestRenderCalls = 0;
			const ctx = createCtx({
				cwd,
				notifications,
				hasUI,
				projectTrusted,
				model,
				systemPrompt,
				onSetHeader(factory) {
					headerFactory = factory;
				},
				onSetFooter(factory) {
					footerFactory = factory;
				},
			});
			for (const handler of sessionStartHandlers) {
				await handler({ reason }, ctx);
			}
			return {
				ctx,
				notifications,
				headerFactory,
				footerFactory,
				buildHeader() {
					return headerFactory
						? headerFactory(
								{
									requestRender() {
										requestRenderCalls += 1;
									},
								},
								theme,
							)
						: undefined;
				},
				buildFooter() {
					return footerFactory ? footerFactory({ requestRender() {} }, theme, undefined) : undefined;
				},
				requestRenderCalls: () => requestRenderCalls,
			};
		},
		cleanup() {
			__testing.reset();
			restoreEnv(previousEnv);
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

async function runSessionStart({
	reason,
	installState,
	hasUI = true,
	projectTrusted,
	setupWorkspace,
	startupResourceCollector,
	deferredStartupTaskScheduler,
	model,
	systemPrompt,
}) {
	const harness = await createExtensionHarness({
		installState,
		setupWorkspace,
		startupResourceCollector,
		deferredStartupTaskScheduler,
	});

	try {
		const session = await harness.startSession({ reason, hasUI, projectTrusted, model, systemPrompt });
		await new Promise((resolve) => setImmediate(resolve));
		const header = session.buildHeader();
		const headerLines = header?.render(200);
		const footer = session.buildFooter();
		const footerLines = footer?.render(100);
		footer?.dispose?.();
		return {
			notifications: session.notifications,
			header,
			headerLines,
			footer,
			footerLines,
			shortcuts: harness.shortcuts,
			ctx: session.ctx,
			requestRenderCalls: session.requestRenderCalls,
		};
	} finally {
		harness.cleanup();
	}
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("interactive startup renders the non-latest track warning in the TLH header", async () => {
	const { notifications, headerLines } = await runSessionStart({
		reason: "startup",
		installState: PINNED_TAG_INSTALL_STATE,
	});

	assert.deepEqual(notifications, []);
	assert.ok(headerLines);
	assert.ok(headerLines.includes("Warning: running TLH from v0.10.0 track"));
});

test("interactive startup prefers the pinned ref label over a local package-source label", async () => {
	const { notifications, headerLines } = await runSessionStart({
		reason: "startup",
		installState: PINNED_TAG_LOCAL_INSTALL_STATE,
	});

	assert.deepEqual(notifications, []);
	assert.ok(headerLines);
	assert.ok(headerLines.includes("Warning: running TLH from v0.10.0 track"));
});

test("interactive startup renders one curated startup tip and reuses the same selection within the process", async () => {
	const firstStartup = await runSessionStart({ reason: "startup", installState: LATEST_STABLE_INSTALL_STATE });
	const secondStartup = await runSessionStart({ reason: "startup", installState: LATEST_STABLE_INSTALL_STATE });

	const firstTipLine = startupTipLine(firstStartup.headerLines);
	const secondTipLine = startupTipLine(secondStartup.headerLines);

	assert.ok(firstTipLine, "expected a startup tip in the TLH startup header");
	assert.ok(secondTipLine, "expected a startup tip in the TLH startup header");
	assert.ok(
		TLH_STARTUP_TIPS.some((tip) => firstTipLine === `Tip: ${tip}`),
		"expected the startup tip to come from the curated TLH list",
	);
	assert.equal(firstTipLine, secondTipLine, "expected the startup tip selection to stay stable within one process");
});

test("interactive startup stays quiet for latest-stable installs", async () => {
	const { notifications, headerLines } = await runSessionStart({
		reason: "startup",
		installState: LATEST_STABLE_INSTALL_STATE,
	});
	assert.deepEqual(notifications, []);
	assert.ok(headerLines);
	assert.equal(
		headerLines.some((line) => line.startsWith("Warning:")),
		false,
	);
});

test("non-startup session reasons do not render the install-track warning or startup tip in the TLH header", async () => {
	for (const reason of ["reload", "new", "resume", "fork", "restore"]) {
		const { notifications, headerLines } = await runSessionStart({ reason, installState: PINNED_TAG_INSTALL_STATE });
		assert.deepEqual(notifications, [], `expected no install warning notification for ${reason}`);
		assert.ok(headerLines, `expected TLH header for ${reason}`);
		assert.equal(
			headerLines.some((line) => line.startsWith("Warning:")),
			false,
			`expected no install-track warning in header for ${reason}`,
		);
		assert.equal(startupTipLine(headerLines), undefined, `expected no startup tip in header for ${reason}`);
	}
});

test("Ctrl+Shift+E toggles the TLH header without changing the default collapsed startup state", async () => {
	const { header, headerLines, shortcuts, ctx, requestRenderCalls } = await runSessionStart({
		reason: "startup",
		installState: PINNED_TAG_INSTALL_STATE,
	});

	assert.ok(header);
	assert.ok(headerLines);
	assert.ok(headerLines.includes("Press Ctrl+Shift+E to show loaded context files, skills, prompts, and extensions"));

	const shortcut = shortcuts.get(TLH_HEADER_TOGGLE_SHORTCUT);
	assert.ok(shortcut, "expected TLH header toggle shortcut to be registered");

	const shortcutCtx = { ...ctx };
	assert.notStrictEqual(shortcutCtx, ctx);

	await shortcut.handler(shortcutCtx);
	const expandedLines = header.render(200);
	assert.equal(
		expandedLines.includes("Press Ctrl+Shift+E to show loaded context files, skills, prompts, and extensions"),
		false,
	);
	assert.ok(expandedLines.includes("Warning: running TLH from v0.10.0 track"));
	assert.equal(requestRenderCalls(), 1);

	await shortcut.handler(shortcutCtx);
	assert.ok(
		header.render(200).includes("Press Ctrl+Shift+E to show loaded context files, skills, prompts, and extensions"),
	);
	assert.equal(requestRenderCalls(), 2);
});

test("startup resources use the active session trust decision", async () => {
	const { header } = await runSessionStart({
		reason: "restore",
		installState: LATEST_STABLE_INSTALL_STATE,
		projectTrusted: true,
		setupWorkspace(cwd) {
			writeProjectSkill(cwd);
		},
	});

	assert.ok(header);
	header.setExpanded(true);
	const expandedLines = header.render(200);
	assert.ok(expandedLines.includes("[Skills]"));
	assert.ok(expandedLines.some((line) => line.includes("project-skill")));
});

test("non-startup UI sessions defer lastSeen persistence until after header installation", async () => {
	const scheduledTasks = [];
	const harness = await createExtensionHarness({
		installState: LATEST_STABLE_INSTALL_STATE,
		deferredStartupTaskScheduler(task) {
			scheduledTasks.push(task);
		},
	});
	const initialState = {
		lastSeenVersion: "0.1.0",
		updateCheck: {
			checkedAt: "2026-07-17T12:00:00.000Z",
			lastNotifiedVersion: "8.8.8",
		},
	};
	writeStartupState(harness.agentDir, initialState);

	try {
		const session = await harness.startSession({ reason: "restore", projectTrusted: true });
		assert.ok(session.headerFactory, "expected the header to be installed synchronously for restore");
		assert.equal(scheduledTasks.length, 1);
		assert.deepEqual(
			readStartupState(harness.agentDir),
			initialState,
			"persistence must not run before the deferred task",
		);

		scheduledTasks[0]();
		assert.deepEqual(readStartupState(harness.agentDir), {
			lastSeenVersion: getTlhVersion(),
			updateCheck: initialState.updateCheck,
		});
	} finally {
		harness.cleanup();
	}
});

test("startup installs the header before delayed resource collection resolves and re-renders once on success", async () => {
	const scheduledTasks = [];
	const deferredResources = createDeferred();
	let collectorCalls = 0;
	let collectorPath;
	const harness = await createExtensionHarness({
		installState: LATEST_STABLE_INSTALL_STATE,
		deferredStartupTaskScheduler(task) {
			scheduledTasks.push(task);
		},
		startupResourceCollector: async () => {
			collectorCalls += 1;
			collectorPath = process.env.PATH;
			return deferredResources.promise;
		},
	});

	try {
		const session = await harness.startSession({
			reason: "restore",
			projectTrusted: true,
			model: TEST_CONTEXT_MODEL,
			systemPrompt: "Pi base prompt",
		});
		assert.ok(session.headerFactory, "expected TLH header installation before resource collection completes");
		assert.equal(scheduledTasks.length, 1, "expected one startup resource collection to be scheduled");
		const header = session.buildHeader();
		assert.ok(header);
		header.setExpanded(true);
		assert.equal(
			header.render(200).includes("[Skills]"),
			false,
			"expected initial header render to use the empty snapshot",
		);
		assert.equal(session.requestRenderCalls(), 0);

		await scheduledTasks[0]();
		assert.equal(collectorCalls, 1);
		assert.equal(collectorPath, harness.emptyBinDir, "deferred task should run with the isolated PATH");
		deferredResources.resolve(
			startupSnapshot({ context: [], skills: ["project-skill"], prompts: [], extensions: [], themes: [] }),
		);
		await deferredResources.promise;
		await Promise.resolve();

		assert.equal(
			session.requestRenderCalls(),
			1,
			"expected one render request after the current session snapshot hydrated",
		);
		assert.ok(header.render(200).includes("[Skills]"));
		assert.ok(header.render(200).some((line) => line.includes("project-skill")));
		header.setExpanded(false);
		assert.ok(
			header.render(200).some((line) => line.startsWith("Context at launch: TLH ")),
			"expected deferred hydration to add the launch allocation before the first turn",
		);
	} finally {
		harness.cleanup();
	}
});

test("stale startup resource completion stays isolated from the replacement session", async () => {
	const scheduledTasks = [];
	const firstDeferred = createDeferred();
	const secondDeferred = createDeferred();
	let collectorCalls = 0;
	const harness = await createExtensionHarness({
		installState: LATEST_STABLE_INSTALL_STATE,
		deferredStartupTaskScheduler(task) {
			scheduledTasks.push(task);
		},
		startupResourceCollector: async () => {
			collectorCalls += 1;
			return collectorCalls === 1 ? firstDeferred.promise : secondDeferred.promise;
		},
	});

	try {
		const firstSession = await harness.startSession({
			reason: "restore",
			projectTrusted: true,
			model: TEST_CONTEXT_MODEL,
			systemPrompt: "First Pi base prompt",
		});
		const firstHeader = firstSession.buildHeader();
		assert.ok(firstHeader);
		firstHeader.setExpanded(true);
		const secondSession = await harness.startSession({
			reason: "restore",
			projectTrusted: true,
			model: TEST_CONTEXT_MODEL,
			systemPrompt: "Second Pi base prompt",
		});
		const secondHeader = secondSession.buildHeader();
		assert.ok(secondHeader);
		secondHeader.setExpanded(true);
		assert.equal(scheduledTasks.length, 2, "expected one scheduled collection per UI session");

		await scheduledTasks[0]();
		firstDeferred.resolve(
			startupSnapshot({ context: [], skills: ["stale-skill"], prompts: [], extensions: [], themes: [] }),
		);
		await firstDeferred.promise;
		await Promise.resolve();

		assert.equal(firstSession.requestRenderCalls(), 0, "stale session completion must not request a render");
		assert.equal(
			secondSession.requestRenderCalls(),
			0,
			"stale session completion must not request a replacement-session render",
		);
		assert.equal(
			firstHeader.render(200).some((line) => line.includes("stale-skill")),
			false,
		);
		assert.equal(
			secondHeader.render(200).some((line) => line.includes("stale-skill")),
			false,
		);
		firstHeader.setExpanded(false);
		secondHeader.setExpanded(false);
		assert.equal(
			firstHeader.render(200).some((line) => line.startsWith("Context at launch:")),
			false,
			"stale hydration must not add an allocation to the replaced header",
		);
		assert.equal(
			secondHeader.render(200).some((line) => line.startsWith("Context at launch:")),
			false,
			"stale hydration must not add an allocation to the replacement header",
		);
		secondHeader.setExpanded(true);

		await scheduledTasks[1]();
		secondDeferred.resolve(
			startupSnapshot({ context: [], skills: ["current-skill"], prompts: [], extensions: [], themes: [] }),
		);
		await secondDeferred.promise;
		await Promise.resolve();

		assert.equal(secondSession.requestRenderCalls(), 1, "current session completion should request one render");
		assert.ok(secondHeader.render(200).some((line) => line.includes("current-skill")));
		secondHeader.setExpanded(false);
		assert.ok(secondHeader.render(200).some((line) => line.startsWith("Context at launch: TLH ")));
	} finally {
		harness.cleanup();
	}
});

test("non-UI replacement invalidates pending startup resource hydration", async () => {
	const scheduledTasks = [];
	const deferredResources = createDeferred();
	const harness = await createExtensionHarness({
		installState: LATEST_STABLE_INSTALL_STATE,
		deferredStartupTaskScheduler(task) {
			scheduledTasks.push(task);
		},
		startupResourceCollector: async () => deferredResources.promise,
	});

	try {
		const uiSession = await harness.startSession({ reason: "restore", projectTrusted: true });
		const header = uiSession.buildHeader();
		assert.ok(header);
		header.setExpanded(true);
		assert.equal(scheduledTasks.length, 1);
		scheduledTasks[0]();

		const nonUiSession = await harness.startSession({ reason: "restore", hasUI: false, projectTrusted: true });
		assert.equal(nonUiSession.headerFactory, undefined);
		deferredResources.resolve(
			startupSnapshot({ context: [], skills: ["stale-after-non-ui"], prompts: [], extensions: [], themes: [] }),
		);
		await deferredResources.promise;
		await Promise.resolve();

		assert.equal(uiSession.requestRenderCalls(), 0, "replaced UI session must not request a render");
		assert.equal(
			header.render(200).some((line) => line.includes("stale-after-non-ui")),
			false,
		);
	} finally {
		harness.cleanup();
	}
});

test("session shutdown invalidates pending startup resource hydration", async () => {
	const scheduledTasks = [];
	const deferredResources = createDeferred();
	const harness = await createExtensionHarness({
		installState: LATEST_STABLE_INSTALL_STATE,
		deferredStartupTaskScheduler(task) {
			scheduledTasks.push(task);
		},
		startupResourceCollector: async () => deferredResources.promise,
	});

	try {
		const session = await harness.startSession({ reason: "restore", projectTrusted: true });
		const header = session.buildHeader();
		assert.ok(header);
		header.setExpanded(true);
		assert.equal(scheduledTasks.length, 1);
		scheduledTasks[0]();

		await harness.shutdownSession(session.ctx);
		deferredResources.resolve(
			startupSnapshot({
				context: [],
				skills: ["stale-after-shutdown"],
				prompts: [],
				extensions: [],
				themes: [],
			}),
		);
		await deferredResources.promise;
		await Promise.resolve();

		assert.equal(session.requestRenderCalls(), 0, "disposed session must not request a render");
		assert.equal(
			header.render(200).some((line) => line.includes("stale-after-shutdown")),
			false,
		);
		const shortcut = harness.shortcuts.get(TLH_HEADER_TOGGLE_SHORTCUT);
		await shortcut.handler(session.ctx);
		assert.equal(session.requestRenderCalls(), 0, "shutdown must clear the active header shortcut target");
	} finally {
		harness.cleanup();
	}
});

test("startup without UI does not show the install-track notice", async () => {
	const { notifications, headerLines } = await runSessionStart({
		reason: "startup",
		installState: PINNED_TAG_INSTALL_STATE,
		hasUI: false,
	});
	assert.deepEqual(notifications, []);
	assert.equal(headerLines, undefined);
});

test("production footer wiring: non-release install renders install-track notice as last footer line on startup", async () => {
	const { footerLines } = await runSessionStart({ reason: "startup", installState: PINNED_TAG_INSTALL_STATE });

	assert.ok(footerLines, "expected a footer to be rendered");
	const nonEmptyLines = footerLines.filter((line) => line.trim().length > 0);
	assert.ok(nonEmptyLines.length > 0, "expected at least one non-empty footer line");
	assert.equal(nonEmptyLines.at(-1), "TLH v0.10.0");
});

test("production footer wiring: footer always shows install-track notice but header only shows it on startup", async () => {
	const { footerLines, headerLines } = await runSessionStart({
		reason: "resume",
		installState: PINNED_TAG_INSTALL_STATE,
	});

	assert.ok(footerLines, "expected a footer to be rendered");
	const nonEmptyFooterLines = footerLines.filter((line) => line.trim().length > 0);
	assert.ok(nonEmptyFooterLines.length > 0, "expected at least one non-empty footer line");
	assert.equal(nonEmptyFooterLines.at(-1), "TLH v0.10.0", "footer must always show the install-track notice");

	assert.ok(headerLines, "expected a header to be rendered");
	assert.equal(
		headerLines.some((line) => line.startsWith("Warning:")),
		false,
		"header must NOT show the install-track warning for non-startup reasons",
	);
});

test("production footer wiring: latest-stable install has no TLH track notice in footer", async () => {
	const { footerLines } = await runSessionStart({ reason: "startup", installState: LATEST_STABLE_INSTALL_STATE });

	assert.ok(footerLines, "expected a footer to be rendered");
	assert.equal(
		footerLines.some((line) => line.startsWith("TLH ")),
		false,
		"footer must not show a TLH track notice for latest-stable installs",
	);
});
