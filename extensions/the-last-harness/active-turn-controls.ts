import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

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

export function shouldRouteAltEnterToSubmit(keybindings: Pick<KeybindingsManager, "getKeys">, data: string) {
	return usesSwappedTlhActiveTurnControls(keybindings) && matchesKey(data, TLH_ACTIVE_TURN_STEER_KEY);
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

		if (!shouldRouteAltEnterToSubmit(this.tlhKeybindings, data)) {
			super.handleInput(data);
			return;
		}

		if (this.handleCustomEditorPriorityInput(data)) {
			return;
		}

		Editor.prototype.handleInput.call(this, "\r");
	}
}
