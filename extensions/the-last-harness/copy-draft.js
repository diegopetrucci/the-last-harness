import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { TLH_COPY_DRAFT_SHORTCUT } from "./constants.js";
const COPY_DRAFT_HINT_WIDGET_KEY = "tlh.copy-draft-hint";
function formatShortcutForHint(shortcut) {
    return shortcut
        .split("+")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("+");
}
const RAW_HINT_TEXT = `↳ ${formatShortcutForHint(TLH_COPY_DRAFT_SHORTCUT)} to copy draft`;
export function isDraftNonTrivial(draft) {
    return draft.trim().length > 0 && (draft.includes("\n") || draft.length >= 200);
}
export function installCopyDraftHint(ctx) {
    if (!ctx.hasUI ||
        typeof ctx.ui.onTerminalInput !== "function" ||
        typeof ctx.ui.setWidget !== "function") {
        return () => { };
    }
    let hintVisible = false;
    let disposed = false;
    const unsubscribe = ctx.ui.onTerminalInput((_input) => {
        queueMicrotask(() => {
            if (disposed)
                return;
            const draft = ctx.ui.getEditorText();
            const shouldShow = isDraftNonTrivial(draft);
            if (shouldShow === hintVisible) {
                return;
            }
            hintVisible = shouldShow;
            const hintText = typeof ctx.ui.theme?.fg === "function"
                ? ctx.ui.theme.fg("dim", RAW_HINT_TEXT)
                : RAW_HINT_TEXT;
            ctx.ui.setWidget(COPY_DRAFT_HINT_WIDGET_KEY, shouldShow ? [hintText] : undefined, {
                placement: "belowEditor",
            });
        });
        return undefined;
    });
    return () => {
        disposed = true;
        try {
            unsubscribe();
        }
        catch {
        }
        try {
            ctx.ui.setWidget(COPY_DRAFT_HINT_WIDGET_KEY, undefined, { placement: "belowEditor" });
        }
        catch {
        }
        hintVisible = false;
    };
}
export function createCopyDraftHandler(dependencies = {}) {
    const copy = dependencies.copyFn ?? copyToClipboard;
    return async (ctx) => {
        if (!ctx.hasUI) {
            return;
        }
        const text = ctx.ui.getEditorText();
        if (text.trim().length === 0) {
            ctx.ui.notify("No draft to copy", "info");
            return;
        }
        try {
            await copy(text);
            ctx.ui.notify("Draft copied to clipboard");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Could not copy draft: ${message}`, "error");
        }
    };
}
