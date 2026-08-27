import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createCopyDraftHandler, isDraftNonTrivial, installCopyDraftHint } = await jiti.import(
  "../extensions/the-last-harness/copy-draft.ts",
);

function makeCtx(editorText, hasUI = true) {
  const notifications = [];
  const ctx = {
    hasUI,
    ui: {
      getEditorText() {
        return editorText;
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      pasteToEditor(_text) {
        throw new Error("pasteToEditor must not be called by copy-draft");
      },
    },
  };
  return { ctx, notifications };
}

function makeHintCtx(overrides = {}) {
  const {
    hasUI = true,
    hasOnTerminalInput = true,
    hasSetWidget = true,
    hasTheme = true,
  } = overrides;
  const inputListeners = [];
  const widgetCalls = [];
  const themeCalls = [];
  let currentText = "";

  const ui = {
    getEditorText() {
      return currentText;
    },
  };

  if (hasOnTerminalInput) {
    ui.onTerminalInput = (handler) => {
      inputListeners.push(handler);
      return () => {
        const idx = inputListeners.indexOf(handler);
        if (idx !== -1) inputListeners.splice(idx, 1);
      };
    };
  }

  if (hasSetWidget) {
    ui.setWidget = (key, lines, opts) => {
      widgetCalls.push({ key, lines, opts });
    };
  }

  if (hasTheme) {
    ui.theme = {
      fg(color, text) {
        themeCalls.push({ color, text });
        return text; // passthrough so text assertions still work
      },
    };
  }

  const ctx = { hasUI, ui };

  return {
    ctx,
    inputListeners,
    widgetCalls,
    themeCalls,
    setText(text) {
      currentText = text;
    },
    triggerInput() {
      for (const handler of inputListeners.slice()) {
        handler({});
      }
    },
  };
}

function flushMicrotasks() {
  return Promise.resolve();
}

// ─── createCopyDraftHandler tests ────────────────────────────────────────────

test("copy-draft: !hasUI returns without doing anything", async () => {
  const copyFn = async (_text) => {
    throw new Error("copyFn must not be called when !hasUI");
  };
  const handler = createCopyDraftHandler({ copyFn });
  const { ctx, notifications } = makeCtx("some draft", false);
  await handler(ctx);
  assert.equal(notifications.length, 0);
});

test("copy-draft: empty draft notifies 'No draft to copy'", async () => {
  const copyFn = async (_text) => {
    throw new Error("copyFn must not be called for empty draft");
  };
  const handler = createCopyDraftHandler({ copyFn });
  const { ctx, notifications } = makeCtx("");
  await handler(ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, "No draft to copy");
  assert.equal(notifications[0].type, "info");
});

test("copy-draft: whitespace-only draft notifies 'No draft to copy'", async () => {
  const copyFn = async (_text) => {
    throw new Error("copyFn must not be called for whitespace-only draft");
  };
  const handler = createCopyDraftHandler({ copyFn });
  const { ctx, notifications } = makeCtx("   \n\t  ");
  await handler(ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, "No draft to copy");
  assert.equal(notifications[0].type, "info");
});

test("copy-draft: success path copies exact text and notifies", async () => {
  const draftText = "Hello, world! This is my unsent draft.";
  const copied = [];
  const copyFn = async (text) => {
    copied.push(text);
  };
  const handler = createCopyDraftHandler({ copyFn });
  const { ctx, notifications } = makeCtx(draftText);
  await handler(ctx);
  assert.deepEqual(copied, [draftText]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, "Draft copied to clipboard");
});

test("copy-draft: success path copies untrimmed text", async () => {
  const draftText = "  leading and trailing spaces  ";
  const copied = [];
  const copyFn = async (text) => {
    copied.push(text);
  };
  const handler = createCopyDraftHandler({ copyFn });
  const { ctx, notifications } = makeCtx(draftText);
  await handler(ctx);
  assert.deepEqual(copied, [draftText]);
  assert.equal(notifications[0].message, "Draft copied to clipboard");
});

test("copy-draft: copy rejection notifies with error type and prefixed message", async () => {
  const copyFn = async (_text) => {
    throw new Error("Clipboard write failed");
  };
  const handler = createCopyDraftHandler({ copyFn });
  const { ctx, notifications } = makeCtx("some draft text");
  await handler(ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, "Could not copy draft: Clipboard write failed");
  assert.equal(notifications[0].type, "error");
});

test("copy-draft: copy rejection with non-Error converts to string with prefix", async () => {
  const copyFn = async (_text) => {
    throw "string error";
  };
  const handler = createCopyDraftHandler({ copyFn });
  const { ctx, notifications } = makeCtx("some draft text");
  await handler(ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, "Could not copy draft: string error");
  assert.equal(notifications[0].type, "error");
});

// ─── isDraftNonTrivial tests ──────────────────────────────────────────────────

test("isDraftNonTrivial: empty string is trivial", () => {
  assert.equal(isDraftNonTrivial(""), false);
});

test("isDraftNonTrivial: whitespace-only short string is trivial", () => {
  assert.equal(isDraftNonTrivial("   \t  "), false);
});

test("isDraftNonTrivial: 199-char string (no newline) is trivial", () => {
  assert.equal(isDraftNonTrivial("a".repeat(199)), false);
});

test("isDraftNonTrivial: 200-char string (no newline) is non-trivial", () => {
  assert.equal(isDraftNonTrivial("a".repeat(200)), true);
});

test("isDraftNonTrivial: 201-char string (no newline) is non-trivial", () => {
  assert.equal(isDraftNonTrivial("a".repeat(201)), true);
});

test("isDraftNonTrivial: single newline is trivial (whitespace-only)", () => {
  assert.equal(isDraftNonTrivial("\n"), false);
});

test("isDraftNonTrivial: whitespace-only multi-line is trivial (two shift+enters)", () => {
  assert.equal(isDraftNonTrivial("\n\n"), false);
  assert.equal(isDraftNonTrivial("  \n  "), false);
});

test("isDraftNonTrivial: multi-line string with content is non-trivial", () => {
  assert.equal(isDraftNonTrivial("line one\nline two"), true);
});

test("isDraftNonTrivial: short string with embedded newline is non-trivial", () => {
  assert.equal(isDraftNonTrivial("a\nb"), true);
});

test("isDraftNonTrivial: 199 whitespace chars (no newline) is trivial", () => {
  assert.equal(isDraftNonTrivial(" ".repeat(199)), false);
});

test("isDraftNonTrivial: 200 whitespace chars (no newline) is trivial", () => {
  assert.equal(isDraftNonTrivial(" ".repeat(200)), false);
});

// ─── installCopyDraftHint tests ───────────────────────────────────────────────

test("installCopyDraftHint: no-op when !hasUI", () => {
  const { ctx, inputListeners, widgetCalls } = makeHintCtx({ hasUI: false });
  const teardown = installCopyDraftHint(ctx);
  assert.equal(typeof teardown, "function");
  assert.equal(inputListeners.length, 0);
  teardown();
  assert.equal(widgetCalls.length, 0);
});

test("installCopyDraftHint: no-op when onTerminalInput missing", () => {
  const { ctx, inputListeners, widgetCalls } = makeHintCtx({ hasOnTerminalInput: false });
  const teardown = installCopyDraftHint(ctx);
  assert.equal(inputListeners.length, 0);
  teardown();
  assert.equal(widgetCalls.length, 0);
});

test("installCopyDraftHint: no-op when setWidget missing", () => {
  const { ctx, inputListeners, widgetCalls } = makeHintCtx({ hasSetWidget: false });
  const teardown = installCopyDraftHint(ctx);
  assert.equal(inputListeners.length, 0);
  teardown();
  assert.equal(widgetCalls.length, 0);
});

test("installCopyDraftHint: subscribes one input listener", () => {
  const { ctx, inputListeners } = makeHintCtx();
  const teardown = installCopyDraftHint(ctx);
  assert.equal(inputListeners.length, 1);
  teardown();
});

test("installCopyDraftHint: handler returns undefined (never consumes input)", () => {
  const { ctx, inputListeners } = makeHintCtx();
  const teardown = installCopyDraftHint(ctx);
  const result = inputListeners[0]({});
  assert.equal(result, undefined);
  teardown();
});

test("installCopyDraftHint: sets widget when draft becomes non-trivial", async () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);
  helper.setText("a".repeat(200));
  helper.triggerInput();
  await flushMicrotasks();
  assert.equal(helper.widgetCalls.length, 1);
  assert.equal(helper.widgetCalls[0].key, "tlh.copy-draft-hint");
  assert.ok(Array.isArray(helper.widgetCalls[0].lines));
  assert.ok(helper.widgetCalls[0].lines[0].includes("to copy draft"));
  assert.deepEqual(helper.widgetCalls[0].opts, { placement: "belowEditor" });
  teardown();
});

test("installCopyDraftHint: clears widget when draft reverts to trivial", async () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);

  // Make non-trivial first
  helper.setText("a".repeat(200));
  helper.triggerInput();
  await flushMicrotasks();
  assert.equal(helper.widgetCalls.length, 1);

  // Revert to trivial
  helper.setText("short");
  helper.triggerInput();
  await flushMicrotasks();
  assert.equal(helper.widgetCalls.length, 2);
  assert.equal(helper.widgetCalls[1].key, "tlh.copy-draft-hint");
  assert.equal(helper.widgetCalls[1].lines, undefined);
  assert.deepEqual(helper.widgetCalls[1].opts, { placement: "belowEditor" });

  teardown();
});

test("installCopyDraftHint: no redundant setWidget calls when state unchanged (trivial)", async () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);

  helper.setText("short");
  helper.triggerInput();
  await flushMicrotasks();
  helper.triggerInput();
  await flushMicrotasks();
  // Hint was never visible; no setWidget calls expected
  assert.equal(helper.widgetCalls.length, 0);

  teardown();
});

test("installCopyDraftHint: no redundant setWidget calls when state unchanged (non-trivial)", async () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);

  helper.setText("a".repeat(200));
  helper.triggerInput();
  await flushMicrotasks();
  assert.equal(helper.widgetCalls.length, 1);

  // Another keystroke with same non-trivial draft: no extra call
  helper.triggerInput();
  await flushMicrotasks();
  assert.equal(helper.widgetCalls.length, 1);

  teardown();
});

test("installCopyDraftHint: teardown unsubscribes listener and clears widget", async () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);

  // Make hint visible
  helper.setText("a".repeat(200));
  helper.triggerInput();
  await flushMicrotasks();
  assert.equal(helper.widgetCalls.length, 1);

  // Teardown should unsubscribe and clear the widget
  teardown();
  assert.equal(helper.inputListeners.length, 0);
  assert.equal(helper.widgetCalls.length, 2);
  assert.equal(helper.widgetCalls[1].lines, undefined);

  // Post-teardown input triggers must not call setWidget
  helper.setText("a".repeat(300));
  helper.triggerInput();
  await flushMicrotasks();
  assert.equal(helper.widgetCalls.length, 2);
});

test("installCopyDraftHint: teardown on never-visible hint clears widget once", () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);
  // Never triggered any input, hint is not visible
  teardown();
  // One setWidget(undefined) call to clear on teardown
  assert.equal(helper.widgetCalls.length, 1);
  assert.equal(helper.widgetCalls[0].lines, undefined);
});

test("installCopyDraftHint: hint text includes shortcut from constant", async () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);

  helper.setText("a".repeat(200));
  helper.triggerInput();
  await flushMicrotasks();

  const hintText = helper.widgetCalls[0].lines[0];
  assert.ok(hintText.includes("Ctrl+Shift+X"), `Expected 'Ctrl+Shift+X' in: ${hintText}`);
  assert.ok(hintText.startsWith("↳"), `Expected hint to start with ↳, got: ${hintText}`);

  teardown();
});

test("installCopyDraftHint: dim styling applied via theme.fg when theme available", async () => {
  const helper = makeHintCtx({ hasTheme: true });
  const teardown = installCopyDraftHint(helper.ctx);

  helper.setText("a".repeat(200));
  helper.triggerInput();
  await flushMicrotasks();

  // theme.fg should have been called with "dim" and the raw hint text
  assert.equal(helper.themeCalls.length, 1);
  assert.equal(helper.themeCalls[0].color, "dim");
  assert.ok(
    helper.themeCalls[0].text.includes("to copy draft"),
    `Expected hint text passed to theme.fg, got: ${helper.themeCalls[0].text}`,
  );

  teardown();
});

test("installCopyDraftHint: falls back to unstyled text when theme unavailable", async () => {
  const helper = makeHintCtx({ hasTheme: false });
  const teardown = installCopyDraftHint(helper.ctx);

  helper.setText("a".repeat(200));
  helper.triggerInput();
  await flushMicrotasks();

  // Widget is still set; text is the raw unstyled hint
  assert.equal(helper.widgetCalls.length, 1);
  const hintText = helper.widgetCalls[0].lines[0];
  assert.ok(hintText.includes("to copy draft"), `Expected raw hint text, got: ${hintText}`);
  assert.ok(hintText.startsWith("↳"), `Expected hint to start with ↳, got: ${hintText}`);
  assert.equal(helper.themeCalls.length, 0);

  teardown();
});

test("installCopyDraftHint: teardown setWidget throw does not propagate", () => {
  const helper = makeHintCtx();
  // Override setWidget to throw after first call (install sets nothing, teardown throws)
  let callCount = 0;
  helper.ctx.ui.setWidget = (_key, _lines, _opts) => {
    callCount += 1;
    if (callCount > 0) throw new Error("setWidget unavailable during shutdown");
  };
  const teardown = installCopyDraftHint(helper.ctx);
  // teardown must not throw even if setWidget throws
  assert.doesNotThrow(() => teardown());
});

test("installCopyDraftHint: hint not shown for whitespace-only multi-line draft", async () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);

  // Two shift+enter presses produce whitespace-only newlines
  helper.setText("\n\n");
  helper.triggerInput();
  await flushMicrotasks();

  // No widget update: hint must not appear for a draft that copy-draft would reject
  assert.equal(helper.widgetCalls.length, 0);

  teardown();
});

test("installCopyDraftHint: deferred read — widget reflects editor text at microtask time, not at listener fire time", async () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);

  // Editor holds trivial text when the listener fires
  helper.setText("short");
  helper.triggerInput();
  // Synchronously change the editor text before microtasks run,
  // simulating the editor consuming the keystroke after listeners have run
  helper.setText("a".repeat(200));
  // Flush microtasks — the deferred read must see the NEW non-trivial text
  await flushMicrotasks();

  assert.equal(
    helper.widgetCalls.length,
    1,
    "widget should be set because deferred read sees new text",
  );
  assert.ok(
    Array.isArray(helper.widgetCalls[0].lines),
    "lines should be an array for non-trivial text",
  );

  teardown();
});

test("installCopyDraftHint: microtask queued before teardown does not re-show widget after teardown", async () => {
  const helper = makeHintCtx();
  const teardown = installCopyDraftHint(helper.ctx);

  // Trigger input with non-trivial text — queues a microtask
  helper.setText("a".repeat(200));
  helper.triggerInput();
  // Call teardown synchronously before any microtasks have run
  teardown();
  // Teardown clears widget; now flush microtasks
  await flushMicrotasks();

  // teardown() issued one setWidget(undefined); the queued microtask must not re-show the widget
  const showCalls = helper.widgetCalls.filter((c) => c.lines !== undefined);
  assert.equal(showCalls.length, 0, "disposed microtask must not re-show the widget");
});
