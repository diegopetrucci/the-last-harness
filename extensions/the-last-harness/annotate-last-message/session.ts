import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

import type {
  LastAssistantMessageData,
  LastAssistantMessageLookupResult,
  LastAssistantMessageSection,
} from "./types.js";

const SECTION_PREVIEW_LIMIT = 96;

function truncatePreview(value: string, limit = SECTION_PREVIEW_LIMIT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function assistantMessageText(
  messageEntry: SessionMessageEntry,
): { kind: "assistant"; text: string } | { kind: "incomplete"; stopReason: string } | null {
  const { message } = messageEntry;
  if (!("role" in message) || message.role !== "assistant") {
    return null;
  }
  if (message.stopReason !== "stop") {
    return { kind: "incomplete", stopReason: String(message.stopReason) };
  }
  if (!Array.isArray(message.content)) {
    return { kind: "assistant", text: "" };
  }
  return {
    kind: "assistant",
    text: message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .replace(/\r\n?/g, "\n"),
  };
}

// Keep in sync with the thematic-break rule in web/md-renderer.js classifyLine.
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

function buildSections(lines: string[]): LastAssistantMessageSection[] {
  const sections: LastAssistantMessageSection[] = [];
  let startIndex: number | null = null;

  const flushSection = (endIndex: number): void => {
    if (startIndex == null) return;
    const sectionLines = lines.slice(startIndex, endIndex + 1);
    // A block made only of thematic breaks (outside fences) has nothing to annotate.
    const blockStart = startIndex;
    const onlyBreaks = sectionLines.every((line, offset) => {
      if (line.trim().length === 0) return true;
      return !inFence[blockStart + offset] && THEMATIC_BREAK.test(line);
    });
    if (onlyBreaks) {
      startIndex = null;
      return;
    }
    const previewSource = sectionLines.find((line) => line.trim().length > 0) ?? "";
    sections.push({
      id: `section-${sections.length + 1}`,
      index: sections.length + 1,
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      preview: truncatePreview(previewSource),
      text: sectionLines.join("\n"),
    });
    startIndex = null;
  };

  // Keep in sync with applyFenceState in web/md-renderer.js.
  let fenceChar = "";
  let fenceLen = 0;
  const inFence: boolean[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^ {0,3}(```+|~~~+)/.exec(line);
    if (fenceChar === "") {
      if (fence) {
        fenceChar = fence[1][0];
        fenceLen = fence[1].length;
      }
    } else if (
      fence &&
      fence[1][0] === fenceChar &&
      fence[1].length >= fenceLen &&
      line.slice(fence[0].length).trim().length === 0
    ) {
      fenceChar = "";
      fenceLen = 0;
    }
    inFence[index] = fenceChar !== "";
    if (fenceChar !== "" && line.trim().length === 0) {
      if (startIndex == null) startIndex = index;
      continue;
    }
    if (line.trim().length === 0) {
      flushSection(index - 1);
      continue;
    }
    if (startIndex == null) {
      startIndex = index;
    }
  }

  flushSection(lines.length - 1);
  return sections;
}

function buildMessageData(text: string): LastAssistantMessageData {
  const lines = text.split("\n");
  return {
    text,
    lines: lines.map((line, lineIndex) => ({ number: lineIndex + 1, text: line })),
    sections: buildSections(lines),
  };
}

// Only finished text replies count (stopReason "stop", non-empty); tool-use and empty turns are skipped.
function findNthCompletedReply(
  branch: SessionEntry[],
  n: number,
): LastAssistantMessageLookupResult {
  let found = 0;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    const extracted = assistantMessageText(entry);
    if (extracted == null || extracted.kind !== "assistant") continue;
    if (extracted.text.trim().length === 0) continue;
    found += 1;
    if (found === n) {
      return { ok: true, data: { ...buildMessageData(extracted.text), repliesAgo: n } };
    }
  }
  return {
    ok: false,
    code: "missing",
    message: `Only ${found} completed assistant ${found === 1 ? "reply" : "replies"} found on the current session branch.`,
  };
}

export function findLastAssistantMessage(
  branch: SessionEntry[],
  n = 1,
): LastAssistantMessageLookupResult {
  if (n >= 2) return findNthCompletedReply(branch, n);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "message") {
      continue;
    }
    const extracted = assistantMessageText(entry);
    if (extracted == null) {
      continue;
    }
    if (extracted.kind === "incomplete") {
      return {
        ok: false,
        code: "incomplete",
        message: `Latest assistant message is incomplete (${extracted.stopReason}). Wait for it to finish, then try again.`,
      };
    }

    const text = extracted.text;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        code: "empty",
        message: "Latest assistant message has no text to annotate.",
      };
    }

    return { ok: true, data: buildMessageData(text) };
  }

  return {
    ok: false,
    code: "missing",
    message: "No assistant messages found on the current session branch.",
  };
}
