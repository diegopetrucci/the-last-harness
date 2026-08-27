import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

import { TLH_COPY_DRAFT_SHORTCUT } from "./constants.js";

type CopyDraftDependencies = {
  copyFn?: (text: string) => Promise<void>;
};

const COPY_DRAFT_HINT_WIDGET_KEY = "tlh.copy-draft-hint";

function formatShortcutForHint(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("+");
}

const RAW_HINT_TEXT = `↳ ${formatShortcutForHint(TLH_COPY_DRAFT_SHORTCUT)} to copy draft`;

export function isDraftNonTrivial(draft: string): boolean {
  return draft.trim().length > 0 && (draft.includes("\n") || draft.length >= 200);
}

export function installCopyDraftHint(ctx: ExtensionContext): () => void {
  if (
    !ctx.hasUI ||
    typeof ctx.ui.onTerminalInput !== "function" ||
    typeof ctx.ui.setWidget !== "function"
  ) {
    return () => {};
  }

  let hintVisible = false;
  let disposed = false;

  const unsubscribe = ctx.ui.onTerminalInput((_input) => {
    queueMicrotask(() => {
      if (disposed) return;
      const draft = ctx.ui.getEditorText();
      const shouldShow = isDraftNonTrivial(draft);
      if (shouldShow === hintVisible) {
        return;
      }
      hintVisible = shouldShow;
      const hintText =
        typeof ctx.ui.theme?.fg === "function"
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
    } catch {
      // Pi may already have cleared extension listeners while resetting its UI.
    }
    try {
      ctx.ui.setWidget(COPY_DRAFT_HINT_WIDGET_KEY, undefined, { placement: "belowEditor" });
    } catch {
      // Pi may already have reset its UI during session shutdown.
    }
    hintVisible = false;
  };
}

export function createCopyDraftHandler(
  dependencies: CopyDraftDependencies = {},
): (ctx: ExtensionContext) => Promise<void> {
  const copy = dependencies.copyFn ?? copyToClipboard;

  return async (ctx: ExtensionContext): Promise<void> => {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not copy draft: ${message}`, "error");
    }
  };
}
