function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function parseFrontmatter(content) {
    const frontmatter = {};
    const normalized = content.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---")) {
        return { frontmatter, body: normalized };
    }
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) {
        return { frontmatter, body: normalized };
    }
    const frontmatterBlock = normalized.slice(4, endIndex);
    const body = normalized.slice(endIndex + 4).trim();
    const lines = frontmatterBlock.split("\n");
    let currentKey = null;
    let currentBlockLines = null;
    let currentIndent = null;
    for (const line of lines) {
        const indent = line.search(/\S|$/);
        if (currentKey !== null && currentBlockLines !== null && indent > (currentIndent ?? 0)) {
            currentBlockLines.push(line);
            continue;
        }
        if (currentKey !== null && currentBlockLines !== null) {
            const rawBlock = currentBlockLines.join("\n");
            const leadingSpaces = rawBlock.match(/^([ \t]+)/m);
            const prefix = leadingSpaces?.[1] ?? "";
            const stripped = prefix
                ? rawBlock.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "").replace(/^\n/, "")
                : rawBlock;
            frontmatter[currentKey] = stripped;
            currentKey = null;
            currentBlockLines = null;
            currentIndent = null;
        }
        const match = line.match(/^([\w-]+):\s*(.*)$/);
        if (match) {
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (value === "") {
                currentKey = match[1];
                currentBlockLines = [];
                currentIndent = indent;
            }
            else {
                frontmatter[match[1]] = value;
            }
        }
    }
    if (currentKey !== null && currentBlockLines !== null) {
        const rawBlock = currentBlockLines.join("\n");
        const leadingSpaces = rawBlock.match(/^([ \t]+)/m);
        const prefix = leadingSpaces?.[1] ?? "";
        const stripped = prefix
            ? rawBlock.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "").replace(/^\n/, "")
            : rawBlock;
        frontmatter[currentKey] = stripped;
    }
    return { frontmatter, body };
}
