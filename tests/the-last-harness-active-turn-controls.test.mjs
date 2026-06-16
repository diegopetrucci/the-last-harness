import assert from "node:assert/strict";
import test from "node:test";

import { KeybindingsManager, getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { KEYBINDINGS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhFooter } = await jiti.import("../extensions/the-last-harness/footer.ts");
const {
	TlhActiveTurnEditor,
	shouldRouteAltEnterToSubmit,
	usesSwappedTlhActiveTurnControls,
} = await jiti.import("../extensions/the-last-harness/active-turn-controls.ts");

const theme = {
	fg: (_color, text) => text,
};

const editorTheme = {
	borderColor: (text) => text,
	selectList: {},
};

const footerData = {
	getGitBranch: () => undefined,
	getAvailableProviderCount: () => 1,
	getExtensionStatuses: () => new Map(),
};

const pi = {
	getThinkingLevel: () => "medium",
};

function createFooterCtx() {
	return {
		hasUI: true,
		cwd: "/tmp/the-last-harness",
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4-20250514",
			contextWindow: 200000,
		},
		sessionManager: {
			getEntries: () => [],
			getCwd: () => "/tmp/the-last-harness",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 12.3 }),
		ui: {
			getEditorText: () => "Keep going",
		},
		isIdle: () => false,
	};
}

async function withKeybindings(config, fn) {
	const previous = getKeybindings();
	const next = new KeybindingsManager(KEYBINDINGS, config);
	setKeybindings(next);
	try {
		return await fn(next);
	} finally {
		setKeybindings(previous);
	}
}

function createEditor(keybindings, isIdle = () => false) {
	return new TlhActiveTurnEditor({ requestRender() {} }, editorTheme, keybindings, isIdle);
}

function createSlashAutocompleteProvider() {
	return {
		async getSuggestions() {
			return {
				prefix: "/rev",
				items: [
					{ value: "/review", label: "/review" },
					{ value: "/revert", label: "/revert" },
				],
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const currentLine = lines[cursorLine] ?? "";
			return {
				lines: [currentLine.slice(0, cursorCol - prefix.length) + item.value + currentLine.slice(cursorCol)],
				cursorLine,
				cursorCol: cursorCol - prefix.length + item.value.length,
			};
		},
	};
}

async function flushEditorTasks() {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

test("active-turn footer hint shows Enter queue before Alt+Enter steer for TLH defaults", { concurrency: false }, async () => {
	await withKeybindings({ "app.message.followUp": "enter" }, async () => {
		const footer = createTlhFooter(pi, createFooterCtx(), theme, () => "architect", footerData, {});
		const altLabel = process.platform === "darwin" ? "option+enter" : "alt+enter";
		assert.equal(footer.render(120).at(-1), `enter queue follow-up · ${altLabel} steer`);
	});
});

test("idle Enter uses the normal editor submit path and confirms slash autocomplete before submitting", async () => {
	await withKeybindings({ "app.message.followUp": "enter" }, async (keybindings) => {
		const editor = createEditor(keybindings, () => true);
		let followUpCalls = 0;
		let submitted;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.onAction("app.message.followUp", () => {
			followUpCalls += 1;
			const text = (editor.getExpandedText?.() ?? editor.getText()).trim();
			if (!text) {
				return;
			}
			editor.setText("");
			editor.onSubmit?.(text);
		});
		editor.setAutocompleteProvider(createSlashAutocompleteProvider());
		editor.setText("/rev");
		editor.requestAutocomplete({ force: true, explicitTab: false });
		await flushEditorTasks();

		assert.equal(editor.isShowingAutocomplete(), true);

		editor.handleInput("\r");

		assert.equal(followUpCalls, 0);
		assert.equal(submitted, "/review");
		assert.equal(editor.getText(), "");
	});
});

test("idle Enter defers to empty-editor app.exit before bypassing follow-up", async () => {
	await withKeybindings({ "app.message.followUp": "enter", "app.exit": "enter" }, async (keybindings) => {
		const editor = createEditor(keybindings, () => true);
		let exitCalls = 0;
		let followUpCalls = 0;
		let submitted;
		editor.onCtrlD = () => {
			exitCalls += 1;
		};
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.onAction("app.message.followUp", () => {
			followUpCalls += 1;
		});

		editor.handleInput("\r");

		assert.equal(exitCalls, 1);
		assert.equal(followUpCalls, 0);
		assert.equal(submitted, undefined);
	});
});

test("idle Alt+Enter preserves upstream newline insertion when TLH defaults swap follow-up to Enter", async () => {
	await withKeybindings({ "app.message.followUp": "enter" }, async (keybindings) => {
		const editor = createEditor(keybindings, () => true);
		let submitted;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setText("/review --help");

		editor.handleInput("\x1b\r");

		assert.equal(submitted, undefined);
		assert.equal(editor.getText(), "/review --help\n");
	});
});

test("active-turn editor routes Alt+Enter through the normal submit path when TLH defaults swap follow-up to Enter", async () => {
	await withKeybindings({ "app.message.followUp": "enter" }, async (keybindings) => {
		const editor = createEditor(keybindings);
		let submitted;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setText("/review --help");

		editor.handleInput("\x1b\r");

		assert.equal(submitted, "/review --help");
		assert.equal(editor.getText(), "");
	});
});

test("active-turn steering defers to extension shortcuts before Alt+Enter submit", async () => {
	await withKeybindings({ "app.message.followUp": "enter" }, async (keybindings) => {
		assert.equal(shouldRouteAltEnterToSubmit(keybindings, false, "\x1b\r"), true);
		assert.equal(shouldRouteAltEnterToSubmit(keybindings, true, "\x1b\r"), false);

		const editor = createEditor(keybindings);
		let shortcutCalls = 0;
		let submitted;
		editor.onExtensionShortcut = (data) => {
			shortcutCalls += 1;
			assert.equal(data, "\x1b\r");
			return true;
		};
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setText("/review --help");

		editor.handleInput("\x1b\r");

		assert.equal(shortcutCalls, 1);
		assert.equal(submitted, undefined);
		assert.equal(editor.getText(), "/review --help");
	});
});

test("active-turn steering defers to special app bindings before Alt+Enter submit", async () => {
	await withKeybindings({ "app.message.followUp": "enter", "app.exit": "alt+enter" }, async (keybindings) => {
		const editor = createEditor(keybindings);
		let exitCalls = 0;
		let submitted;
		editor.onCtrlD = () => {
			exitCalls += 1;
		};
		editor.onSubmit = (text) => {
			submitted = text;
		};

		editor.handleInput("\x1b\r");

		assert.equal(exitCalls, 1);
		assert.equal(submitted, undefined);
	});
});

test("active-turn steering override stays disabled when a user owns a different follow-up binding", () => {
	const keybindings = new KeybindingsManager(KEYBINDINGS, { "app.message.followUp": "ctrl+j" });

	assert.equal(usesSwappedTlhActiveTurnControls(keybindings), false);
	assert.equal(shouldRouteAltEnterToSubmit(keybindings, false, "\x1b\r"), false);
});
