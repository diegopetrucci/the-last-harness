import assert from "node:assert/strict";
import {
  KeybindingsManager,
  type KeyId,
} from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { Container, Text, getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { createPlainTheme } from "./themes.ts";
import {
  buildWidgetLines,
  clearLegacyResultAnimationTimer,
  renderWidget,
} from "../../src/tui/render.ts";

export { buildWidgetLines, clearLegacyResultAnimationTimer, renderWidget };
export { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
export { createSubagentLiveDetailController } from "../../src/shared/subagent-shortcuts.ts";
export {
  WHIMSICAL_THINKING_PHRASES,
  whimsicalThinkingPhrase,
} from "../../src/tui/whimsical-phrases.ts";
export type { AsyncJobState, AsyncJobStep } from "../../src/shared/types.ts";

export const runningGlyphPattern = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]";

export type WidgetTheme = ReturnType<typeof createPlainTheme>;

export function createWidgetTheme(): WidgetTheme {
  return createPlainTheme();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function outputPathPattern(posixPath: string): RegExp {
  return new RegExp(`output: ${posixPath.split("/").map(escapeRegExp).join("[\\\\/]")}`);
}

export function firstGrapheme(text: string): string {
  return Array.from(text.trimStart())[0] ?? "";
}

export function containsTerminalControl(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
  });
}

export function firstRunningGlyph(text: string): string {
  return text.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]/)?.[0] ?? "";
}

export function createUiContext(theme: WidgetTheme = createWidgetTheme()) {
  const widgets: unknown[] = [];
  let renderRequests = 0;
  const ctx = {
    hasUI: true,
    ui: {
      theme,
      setWidget: (_key: string, value: unknown) => {
        widgets.push(value);
      },
      requestRender: () => {
        renderRequests += 1;
      },
    },
  };
  return {
    ctx,
    widgets,
    get renderRequests() {
      return renderRequests;
    },
  };
}

export function renderWidgetLines(
  widget: unknown,
  width = 180,
  theme: WidgetTheme = createWidgetTheme(),
): string[] {
  return (
    widget as (_tui: unknown, widgetTheme: WidgetTheme) => { render(width: number): string[] }
  )(undefined, theme).render(width);
}

export function widgetContent(line: string): string {
  return line.slice(1).trimEnd();
}

export function wrappedText(lines: string[], padded = false): string {
  return lines
    .map((line) => (padded ? widgetContent(line) : line))
    .join("")
    .replace(/\s/g, "");
}

export function assertWrappedSource(lines: string[], source: string, padded = false): void {
  assert.ok(
    wrappedText(lines, padded).includes(source.replace(/\s/g, "")),
    `wrapped output should preserve ${JSON.stringify(source)}`,
  );
}

export function renderWithRealPiTui(lines: string[], width: number): string[] {
  const container = new Container();
  for (const line of lines) container.addChild(new Text(line, 1, 0));
  return container.render(width);
}

export function renderWidgetHarnessLines(
  widget: unknown,
  theme: WidgetTheme = createWidgetTheme(),
): string[] {
  const component = (widget as (_tui: unknown, widgetTheme: WidgetTheme) => Container)(
    undefined,
    theme,
  );
  return component.children.map((child) => {
    const text: unknown = Object.getOwnPropertyDescriptor(child, "text")?.value;
    if (typeof text !== "string") {
      assert.fail("widget harness should expose Text children");
    }
    return text;
  });
}

function restoreDescriptor(
  target: NodeJS.WriteStream,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}

export function withStdoutSize<T>(rows: number, columns: number, fn: () => T): T {
  const stdout = process.stdout as NodeJS.WriteStream & { rows?: number; columns?: number };
  const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, "rows");
  const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
  Object.defineProperty(stdout, "rows", { configurable: true, value: rows });
  Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
  try {
    return fn();
  } finally {
    restoreDescriptor(stdout, "rows", rowsDescriptor);
    restoreDescriptor(stdout, "columns", columnsDescriptor);
  }
}

function resetWidgetLayout(theme: WidgetTheme): void {
  renderWidget(createUiContext(theme).ctx as never, []);
}

export function createWidgetTestIsolation(theme: WidgetTheme) {
  const originalKeybindings = getKeybindings();
  const configuredExpandKeybindings = new KeybindingsManager({
    "app.tools.expand": "configured+expand+key" as KeyId,
  });
  const reset = () => resetWidgetLayout(theme);
  return {
    beforeEach: () => {
      setKeybindings(configuredExpandKeybindings);
      reset();
    },
    afterEach: () => {
      setKeybindings(originalKeybindings);
      reset();
    },
    resetWidgetLayout: reset,
    useConfiguredExpandKey: () => {
      setKeybindings(configuredExpandKeybindings);
    },
    useDefaultKeybindings: () => {
      setKeybindings(originalKeybindings);
    },
  };
}
