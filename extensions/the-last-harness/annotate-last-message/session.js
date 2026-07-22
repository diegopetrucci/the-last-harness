const SECTION_PREVIEW_LIMIT = 96;
function truncatePreview(value, limit = SECTION_PREVIEW_LIMIT) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= limit)
        return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
function assistantMessageText(messageEntry) {
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
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
            .replace(/\r\n?/g, "\n"),
    };
}
function buildSections(lines) {
    const sections = [];
    let startIndex = null;
    const flushSection = (endIndex) => {
        if (startIndex == null)
            return;
        const sectionLines = lines.slice(startIndex, endIndex + 1);
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
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
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
export function findLastAssistantMessage(branch) {
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
        const lines = text.split("\n");
        const data = {
            text,
            lines: lines.map((line, lineIndex) => ({ number: lineIndex + 1, text: line })),
            sections: buildSections(lines),
        };
        return { ok: true, data };
    }
    return {
        ok: false,
        code: "missing",
        message: "No assistant messages found on the current session branch.",
    };
}
