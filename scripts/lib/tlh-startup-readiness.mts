export interface ReadinessObservationState {
  /** Raw accumulated output; normalization always runs over the whole buffer. */
  rawOutput: string;
  normalizedOutput: string;
  firstOutputMs?: number;
  headerMs?: number;
  footerMs?: number;
  readyMs?: number;
}

// Markers must be TLH-rendered content: Pi's own first frame (editor border,
// default cwd footer) paints before TLH's header and footer do.
const HEADER_LOGO_PATTERN = /(^|\n)\s*tlh(?:\s+v\d[^\n]*)?\s*(?=\n|$)/u;
const FOOTER_PATTERN = /(^|\n)\s*agent: \S/u;
const CURSOR_POSITION_PATTERN = new RegExp(`${String.raw`\u001B`}\\[[0-9;]*[Hf]`, "gu");
const ANSI_PATTERN = new RegExp(
  `${String.raw`\u001B`}(?:\\][^${String.raw`\u0007\u001B`}]*(?:${String.raw`\u0007`}|${String.raw`\u001B\\`})|\\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])`,
  "gu",
);

export function stripTerminalNoise(text: string): string {
  let result = "";
  for (const character of text.replace(ANSI_PATTERN, "")) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint >= 0x20) {
      result += character;
    }
  }
  return result.replace(/\r/g, "\n");
}

/**
 * Like stripTerminalNoise, but treats CSI cursor-position sequences as line
 * breaks so TUI frames painted by absolute positioning keep their line
 * structure for marker detection.
 */
export function stripTerminalNoiseForReadiness(text: string): string {
  return stripTerminalNoise(text.replace(CURSOR_POSITION_PATTERN, "\n"));
}

export function hasHeaderMarker(text: string): boolean {
  return HEADER_LOGO_PATTERN.test(text);
}

export function hasFooterMarker(text: string): boolean {
  return FOOTER_PATTERN.test(text);
}

export function createReadinessObserver(): ReadinessObservationState {
  return { rawOutput: "", normalizedOutput: "" };
}

/**
 * Appends a chunk and re-derives normalized text from the whole raw buffer, so
 * escape sequences split across reads cannot leave fragments that defeat the
 * line-anchored markers. Startup output is small, so this stays cheap.
 */
export function appendReadinessOutput(state: ReadinessObservationState, chunk: string): void {
  state.rawOutput += chunk;
  state.normalizedOutput = stripTerminalNoiseForReadiness(state.rawOutput);
}

export function observeReadinessChunk(
  state: ReadinessObservationState,
  chunk: string,
  elapsedMs: number,
): boolean {
  if (chunk.length === 0) return state.readyMs !== undefined;
  if (state.firstOutputMs === undefined) state.firstOutputMs = elapsedMs;
  appendReadinessOutput(state, chunk);
  if (state.headerMs === undefined && hasHeaderMarker(state.normalizedOutput)) {
    state.headerMs = elapsedMs;
  }
  if (state.footerMs === undefined && hasFooterMarker(state.normalizedOutput)) {
    state.footerMs = elapsedMs;
  }
  if (state.readyMs === undefined && state.headerMs !== undefined && state.footerMs !== undefined) {
    state.readyMs = Math.max(state.headerMs, state.footerMs);
  }
  return state.readyMs !== undefined;
}
