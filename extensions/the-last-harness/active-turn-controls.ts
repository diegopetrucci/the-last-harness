import { CustomEditor, type EditorFactory, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const TLH_ACTIVE_TURN_QUEUE_KEY = "enter";
const TLH_ACTIVE_TURN_STEER_KEY = "alt+enter";

function hasKey(keys: readonly string[], expectedKey: string) {
	return keys.some((key) => key.toLowerCase() === expectedKey);
}

function formatKeyText(key: string) {
	return key
		.split("/")
		.map((binding) =>
			binding
				.split("+")
				.map((part) => (process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: readonly string[], fallback: string) {
	return keys.length > 0 ? formatKeyText(keys.join("/")) : fallback;
}

export function usesSwappedTlhActiveTurnControls(keybindings: Pick<KeybindingsManager, "getKeys">) {
	const followUpKeys = keybindings.getKeys("app.message.followUp").map((key) => key.toLowerCase());
	return hasKey(followUpKeys, TLH_ACTIVE_TURN_QUEUE_KEY) && !hasKey(followUpKeys, TLH_ACTIVE_TURN_STEER_KEY);
}

export function getTlhActiveTurnHintKeys(keybindings: Pick<KeybindingsManager, "getKeys">) {
	if (usesSwappedTlhActiveTurnControls(keybindings)) {
		const queueKeys = keybindings.getKeys("app.message.followUp");
		return {
			queueKey: formatKeys(queueKeys, TLH_ACTIVE_TURN_QUEUE_KEY),
			steerKey: formatKeyText(TLH_ACTIVE_TURN_STEER_KEY),
			swapped: true,
		};
	}

	return {
		queueKey: formatKeys(keybindings.getKeys("app.message.followUp"), "alt+enter"),
		steerKey: formatKeys(keybindings.getKeys("tui.input.submit"), "enter"),
		swapped: false,
	};
}

function shouldUseIdleEnterSubmitPath(
	keybindings: Pick<KeybindingsManager, "getKeys" | "matches">,
	isIdle: () => boolean,
	data: string,
) {
	return (
		usesSwappedTlhActiveTurnControls(keybindings) &&
		isIdle() &&
		matchesKey(data, TLH_ACTIVE_TURN_QUEUE_KEY) &&
		keybindings.matches(data, "app.message.followUp")
	);
}

export function shouldRouteAltEnterToSubmit(
	keybindings: Pick<KeybindingsManager, "getKeys">,
	isIdle: boolean,
	data: string,
) {
	return !isIdle && usesSwappedTlhActiveTurnControls(keybindings) && matchesKey(data, TLH_ACTIVE_TURN_STEER_KEY);
}

type TlhComposableEditor = EditorComponent & {
	actionHandlers?: Map<string, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	isShowingAutocomplete?: () => boolean;
};

function hasActionHandlers(editor: TlhComposableEditor): editor is TlhComposableEditor & { actionHandlers: Map<string, () => void> } {
	return editor.actionHandlers instanceof Map;
}

function isShowingAutocomplete(editor: TlhComposableEditor): boolean {
	return editor.isShowingAutocomplete?.() ?? false;
}

function hasIdleEnterAppActionBeforeFollowUp(
	editor: TlhComposableEditor,
	keybindings: Pick<KeybindingsManager, "matches">,
	data: string,
): boolean {
	if (keybindings.matches(data, "app.clipboard.pasteImage")) {
		return true;
	}

	if (keybindings.matches(data, "app.interrupt") && !isShowingAutocomplete(editor)) {
		return true;
	}

	if (keybindings.matches(data, "app.exit") && editor.getText().length === 0) {
		return true;
	}

	if (!hasActionHandlers(editor)) {
		return false;
	}

	for (const action of editor.actionHandlers.keys()) {
		if (action === "app.interrupt" || action === "app.exit") {
			continue;
		}

		if (action === "app.message.followUp") {
			break;
		}

		if (keybindings.matches(data, action)) {
			return true;
		}
	}

	return false;
}

function isUpstreamEditor(editor: EditorComponent): editor is TlhComposableEditor & Editor {
	const candidate = editor as Partial<Editor> & {
		state?: { lines?: unknown; cursorLine?: unknown; cursorCol?: unknown };
	};

	return (
		typeof candidate.submitValue === "function" &&
		typeof candidate.addNewLine === "function" &&
		typeof candidate.handleBackspace === "function" &&
		typeof candidate.isShowingAutocomplete === "function" &&
		typeof candidate.requestAutocomplete === "function" &&
		Array.isArray(candidate.state?.lines) &&
		typeof candidate.state?.cursorLine === "number" &&
		typeof candidate.state?.cursorCol === "number"
	);
}

function handleComposedEditorPriorityInput(
	editor: TlhComposableEditor,
	keybindings: Pick<KeybindingsManager, "matches">,
	data: string,
): boolean {
	if (editor.onExtensionShortcut?.(data)) {
		return true;
	}

	if (keybindings.matches(data, "app.clipboard.pasteImage")) {
		editor.onPasteImage?.();
		return true;
	}

	if (keybindings.matches(data, "app.interrupt")) {
		if (!isShowingAutocomplete(editor)) {
			const handler = editor.onEscape ?? (hasActionHandlers(editor) ? editor.actionHandlers.get("app.interrupt") : undefined);
			if (handler) {
				handler();
				return true;
			}
		}
		Editor.prototype.handleInput.call(editor, data);
		return true;
	}

	if (keybindings.matches(data, "app.exit")) {
		if (editor.getText().length === 0) {
			const handler = editor.onCtrlD ?? (hasActionHandlers(editor) ? editor.actionHandlers.get("app.exit") : undefined);
			handler?.();
			return true;
		}
		Editor.prototype.handleInput.call(editor, data);
		return true;
	}

	if (!hasActionHandlers(editor)) {
		return false;
	}

	for (const [action, handler] of editor.actionHandlers) {
		if (action !== "app.interrupt" && action !== "app.exit" && keybindings.matches(data, action)) {
			handler();
			return true;
		}
	}

	return false;
}

export function createTlhActiveTurnEditorFactory(
	previousEditorFactory: EditorFactory | undefined,
	isIdle: () => boolean,
): EditorFactory {
	return (tui, theme, keybindings) => {
		if (!previousEditorFactory) {
			return new TlhActiveTurnEditor(tui, theme, keybindings, isIdle);
		}

		const previousEditor = previousEditorFactory(tui, theme, keybindings);
		if (!isUpstreamEditor(previousEditor)) {
			return previousEditor;
		}

		const previousHandleInput = previousEditor.handleInput.bind(previousEditor);

		previousEditor.handleInput = (data: string) => {
			if (
				shouldUseIdleEnterSubmitPath(keybindings, isIdle, data) &&
				!hasIdleEnterAppActionBeforeFollowUp(previousEditor, keybindings, data)
			) {
				Editor.prototype.handleInput.call(previousEditor, data);
				return;
			}

			if (!shouldRouteAltEnterToSubmit(keybindings, isIdle(), data)) {
				previousHandleInput(data);
				return;
			}

			if (handleComposedEditorPriorityInput(previousEditor, keybindings, data)) {
				return;
			}

			Editor.prototype.handleInput.call(previousEditor, "\r");
		};

		return previousEditor;
	};
}

export class TlhActiveTurnEditor extends CustomEditor {
	private readonly tlhKeybindings: KeybindingsManager;
	private readonly tlhIsIdle: () => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, isIdle: () => boolean = () => false) {
		super(tui, theme, keybindings);
		this.tlhKeybindings = keybindings;
		this.tlhIsIdle = isIdle;
	}

	private hasIdleEnterAppActionBeforeFollowUp(data: string): boolean {
		if (this.tlhKeybindings.matches(data, "app.clipboard.pasteImage")) {
			return true;
		}

		if (this.tlhKeybindings.matches(data, "app.interrupt") && !this.isShowingAutocomplete()) {
			return true;
		}

		if (this.tlhKeybindings.matches(data, "app.exit") && this.getText().length === 0) {
			return true;
		}

		for (const action of this.actionHandlers.keys()) {
			if (action === "app.interrupt" || action === "app.exit") {
				continue;
			}

			if (action === "app.message.followUp") {
				break;
			}

			if (this.tlhKeybindings.matches(data, action)) {
				return true;
			}
		}

		return false;
	}

	private handleCustomEditorPriorityInput(data: string): boolean {
		if (this.onExtensionShortcut?.(data)) {
			return true;
		}

		if (this.tlhKeybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return true;
		}

		if (this.tlhKeybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return true;
				}
			}
			Editor.prototype.handleInput.call(this, data);
			return true;
		}

		if (this.tlhKeybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				handler?.();
				return true;
			}
			Editor.prototype.handleInput.call(this, data);
			return true;
		}

		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.tlhKeybindings.matches(data, action)) {
				handler();
				return true;
			}
		}

		return false;
	}

	override handleInput(data: string): void {
		if (
			shouldUseIdleEnterSubmitPath(this.tlhKeybindings, this.tlhIsIdle, data) &&
			!this.hasIdleEnterAppActionBeforeFollowUp(data)
		) {
			Editor.prototype.handleInput.call(this, data);
			return;
		}

		if (!shouldRouteAltEnterToSubmit(this.tlhKeybindings, this.tlhIsIdle(), data)) {
			super.handleInput(data);
			return;
		}

		if (this.handleCustomEditorPriorityInput(data)) {
			return;
		}

		Editor.prototype.handleInput.call(this, "\r");
	}
}
