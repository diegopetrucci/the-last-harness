import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Model-callable `name_session` tool: labels an unnamed session once and never
 * overwrites an existing label.
 *
 * The only other naming paths are the `/name` command and the `/resume` rename
 * UI, so a session started by a primary agent stays unnamed unless the model can
 * label it. Pi's `setSessionName` appends the session-info entry and then emits
 * the `session_info_changed` extension event
 * (`@earendil-works/pi-coding-agent` `dist/core/agent-session.js`,
 * `setSessionName`), which the TLH extension already handles by re-applying the
 * TLH terminal title and letting the cmux/Herdr activity reporters resend pane
 * metadata. No direct title refresh is needed here.
 */

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

const NameSessionParameters = Type.Object(
  {
    name: Type.String({
      description: "Short descriptive session name. No secrets or personal data.",
    }),
  },
  { additionalProperties: false },
);

type NameSessionToolDetails = {
  /** Whether this call set a name. */
  changed: boolean;
  /** Session name after the call, when one exists. */
  name?: string;
};

function isSubagentChildProcess(): boolean {
  return process.env[SUBAGENT_CHILD_ENV] === "1";
}

/** Drop ANSI escape sequences (CSI, OSC, and two-character escapes) entirely. */
function stripAnsiSequences(input: string): string {
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const codePoint = input.codePointAt(index) ?? 0;
    if (codePoint !== ESCAPE_CODE_POINT) {
      output += input[index];
      continue;
    }
    const next = input.charCodeAt(index + 1);
    if (next === 0x5b) {
      // CSI: consume up to and including the final byte.
      index += 2;
      while (index < input.length) {
        const current = input.charCodeAt(index);
        if (current >= CSI_FINAL_BYTE_MIN && current <= CSI_FINAL_BYTE_MAX) break;
        index += 1;
      }
      continue;
    }
    if (next === 0x5d) {
      // OSC: consume up to BEL or the ESC \ terminator.
      index += 2;
      while (index < input.length) {
        const current = input.charCodeAt(index);
        if (current === BELL_CODE_POINT) break;
        if (current === ESCAPE_CODE_POINT && input.charCodeAt(index + 1) === 0x5c) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    // Any other escape consumes the escape plus its single following character.
    index += 1;
  }
  return output;
}

/**
 * Normalize a requested session label: strip ANSI escapes, turn control
 * characters into word separators, collapse whitespace, trim, and cap the
 * result at `NAME_SESSION_TOOL_MAX_LENGTH` characters.
 */
export function normalizeTlhSessionName(raw: string): string {
  const withoutAnsi = stripAnsiSequences(raw);
  let withoutControls = "";
  for (const character of withoutAnsi) {
    const codePoint = character.codePointAt(0) ?? 0;
    // C0 controls, DEL, and C1 controls become separators so words stay apart.
    const isControl = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    withoutControls += isControl ? " " : character;
  }
  const collapsed = withoutControls.replace(/\s+/gu, " ").trim();
  if (!collapsed) return "";
  // Cap on code points so an emoji or other surrogate pair is never split.
  return Array.from(collapsed).slice(0, NAME_SESSION_TOOL_MAX_LENGTH).join("").trimEnd();
}

type TlhSessionNameRead = {
  /** True when at least one getter answered, so `name` reflects the session. */
  readable: boolean;
  /** Trimmed existing name; absent when the session is unnamed. */
  name?: string;
};

/**
 * Read the existing session name, distinguishing "read succeeded and is empty"
 * from "no getter could be read". The latter must not be treated as unnamed:
 * overwriting a label the model could not see would clobber a user-set name.
 */
function readTlhSessionName(pi: ExtensionAPI, ctx: ExtensionToolContext): TlhSessionNameRead {
  try {
    const raw = ctx.sessionManager.getSessionName();
    if (typeof raw === "string" && raw.trim()) return { readable: true, name: raw.trim() };
    return { readable: true };
  } catch {
    // Fall through to the extension API read below.
  }
  try {
    const raw = pi.getSessionName();
    if (typeof raw === "string" && raw.trim()) return { readable: true, name: raw.trim() };
    return { readable: true };
  } catch {
    // Neither getter answered: report unreadable so the caller can fail closed.
    return { readable: false };
  }
}

export function registerNameSessionTool(pi: ExtensionAPI): void {
  // Child subagent sessions must not relabel themselves; they inherit the parent
  // session's identity and the tool is registered for primary sessions only.
  if (isSubagentChildProcess()) return;

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
              type: "text" as const,
              text: "Could not read the current session name, so no name was set. Retry once the session is available.",
            },
          ],
          details: { changed: false } satisfies NameSessionToolDetails,
          isError: true,
        };
      }
      if (existing.name) {
        return {
          content: [
            {
              type: "text" as const,
              text: `This session is already named "${existing.name}". Left it unchanged.`,
            },
          ],
          details: { changed: false, name: existing.name } satisfies NameSessionToolDetails,
        };
      }

      const normalized = normalizeTlhSessionName(params.name);
      if (!normalized) {
        return {
          content: [
            {
              type: "text" as const,
              text: "The requested session name is empty after removing whitespace, control characters, and ANSI escapes. No name was set; pass a short descriptive label.",
            },
          ],
          details: { changed: false } satisfies NameSessionToolDetails,
          isError: true,
        };
      }

      try {
        pi.setSessionName(normalized);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not set the session name: ${message}`,
            },
          ],
          details: { changed: false } satisfies NameSessionToolDetails,
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Named this session "${normalized}".`,
          },
        ],
        details: { changed: true, name: normalized } satisfies NameSessionToolDetails,
      };
    },
  });
}
