// Generated from extensions/the-last-harness/session-name.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { Type } from "typebox";
export const NAME_SESSION_TOOL_NAME = "name_session";
export const NAME_SESSION_TOOL_MAX_LENGTH = 50;
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const ESCAPE_CODE_POINT = 0x1b;
const BELL_CODE_POINT = 0x07;
const CSI_FINAL_BYTE_MIN = 0x40;
const CSI_FINAL_BYTE_MAX = 0x7e;
const NAME_SESSION_TOOL_DESCRIPTION = [
    "Name the current session with a short descriptive label.",
    "Use it once, early, when the session has no name yet and the work has a clear purpose.",
    "It never overwrites an existing name: when the session is already named the call is a no-op report of that name.",
    "Prefer a short topic label (for example 'Fix flaky installer test'); whitespace is collapsed, ANSI/control characters are dropped, and the name is capped at 50 characters.",
    "Never include secrets, tokens, credentials, personal data, or customer identifiers in the name: session names are persisted in the session file and shown in the session selector, terminal title, and pane metadata.",
].join(" ");
const NameSessionParameters = Type.Object({
    name: Type.String({
        description: "Short descriptive session name. No secrets or personal data.",
    }),
}, { additionalProperties: false });
function isSubagentChildProcess() {
    return process.env[SUBAGENT_CHILD_ENV] === "1";
}
function stripAnsiSequences(input) {
    let output = "";
    for (let index = 0; index < input.length; index += 1) {
        const codePoint = input.codePointAt(index) ?? 0;
        if (codePoint !== ESCAPE_CODE_POINT) {
            output += input[index];
            continue;
        }
        const next = input.charCodeAt(index + 1);
        if (next === 0x5b) {
            index += 2;
            while (index < input.length) {
                const current = input.charCodeAt(index);
                if (current >= CSI_FINAL_BYTE_MIN && current <= CSI_FINAL_BYTE_MAX)
                    break;
                index += 1;
            }
            continue;
        }
        if (next === 0x5d) {
            index += 2;
            while (index < input.length) {
                const current = input.charCodeAt(index);
                if (current === BELL_CODE_POINT)
                    break;
                if (current === ESCAPE_CODE_POINT && input.charCodeAt(index + 1) === 0x5c) {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }
        index += 1;
    }
    return output;
}
export function normalizeTlhSessionName(raw) {
    const withoutAnsi = stripAnsiSequences(raw);
    let withoutControls = "";
    for (const character of withoutAnsi) {
        const codePoint = character.codePointAt(0) ?? 0;
        const isControl = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
        withoutControls += isControl ? " " : character;
    }
    const collapsed = withoutControls.replace(/\s+/gu, " ").trim();
    if (!collapsed)
        return "";
    return Array.from(collapsed).slice(0, NAME_SESSION_TOOL_MAX_LENGTH).join("").trimEnd();
}
function readTlhSessionName(pi, ctx) {
    try {
        const raw = ctx.sessionManager.getSessionName();
        if (typeof raw === "string" && raw.trim())
            return { readable: true, name: raw.trim() };
        return { readable: true };
    }
    catch {
    }
    try {
        const raw = pi.getSessionName();
        if (typeof raw === "string" && raw.trim())
            return { readable: true, name: raw.trim() };
        return { readable: true };
    }
    catch {
        return { readable: false };
    }
}
export function registerNameSessionTool(pi) {
    if (isSubagentChildProcess())
        return;
    pi.registerTool({
        name: NAME_SESSION_TOOL_NAME,
        label: "Name Session",
        description: NAME_SESSION_TOOL_DESCRIPTION,
        parameters: NameSessionParameters,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const existing = readTlhSessionName(pi, ctx);
            if (!existing.readable) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Could not read the current session name, so no name was set. Retry once the session is available.",
                        },
                    ],
                    details: { changed: false },
                    isError: true,
                };
            }
            if (existing.name) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `This session is already named "${existing.name}". Left it unchanged.`,
                        },
                    ],
                    details: { changed: false, name: existing.name },
                };
            }
            const normalized = normalizeTlhSessionName(params.name);
            if (!normalized) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "The requested session name is empty after removing whitespace, control characters, and ANSI escapes. No name was set; pass a short descriptive label.",
                        },
                    ],
                    details: { changed: false },
                    isError: true,
                };
            }
            try {
                pi.setSessionName(normalized);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Could not set the session name: ${message}`,
                        },
                    ],
                    details: { changed: false },
                    isError: true,
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Named this session "${normalized}".`,
                    },
                ],
                details: { changed: true, name: normalized },
            };
        },
    });
}
