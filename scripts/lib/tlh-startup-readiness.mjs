const HEADER_TEXT_MARKERS = ["Context:", "run /context"];
const HEADER_LOGO_PATTERN = /(^|\n)\s*tlh(?:\s+v\d[^\n]*)?\s*(?=\n|$)/u;
const HEADER_RULE_PATTERN = /(^|\n)[^\n]*─(?:[^\n]*─){19,}[^\n]*(?=\n|$)/u;
const FOOTER_MARKER = "agent: ";
const FOOTER_CWD_PATTERN = /(^|\n)(?:~|\/)[^\n]* \([^\n()]+\)(?=\n|$)/u;
const ANSI_PATTERN = new RegExp(`${String.raw `\u001B`}(?:\\][^${String.raw `\u0007\u001B`}]*(?:${String.raw `\u0007`}|${String.raw `\u001B\\`})|\\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])`, "gu");
export function stripTerminalNoise(text) {
    let result = "";
    for (const character of text.replace(ANSI_PATTERN, "")) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined)
            continue;
        if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint >= 0x20) {
            result += character;
        }
    }
    return result.replace(/\r/g, "\n");
}
export function hasHeaderMarker(text) {
    return (HEADER_TEXT_MARKERS.some((marker) => text.includes(marker)) ||
        HEADER_LOGO_PATTERN.test(text) ||
        HEADER_RULE_PATTERN.test(text));
}
export function hasFooterMarker(text) {
    return text.includes(FOOTER_MARKER) || FOOTER_CWD_PATTERN.test(text);
}
export function createReadinessObserver() {
    return { normalizedOutput: "" };
}
export function observeReadinessChunk(state, chunk, elapsedMs) {
    if (chunk.length === 0)
        return state.readyMs !== undefined;
    if (state.firstOutputMs === undefined)
        state.firstOutputMs = elapsedMs;
    state.normalizedOutput += stripTerminalNoise(chunk);
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
