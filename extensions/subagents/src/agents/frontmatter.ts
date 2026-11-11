/**
 * Escape regex special characters for use in a RegExp constructor.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse YAML frontmatter from agent files.
 * Handles both flat (key: value) and nested block (key: \n  sub: val) values.
 * Block values are stored as single strings with embedded newlines.
 * The indentation of the block content is preserved relative to the key.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const frontmatter: Record<string, string> = {};
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
  let currentKey: string | null = null;
  let currentBlockLines: string[] | null = null;
  let currentIndent: number | null = null;

  function flushBlockValue(): void {
    if (currentKey === null || currentBlockLines === null) return;
    const rawBlock = currentBlockLines.join("\n");
    const leadingSpaces = rawBlock.match(/^([ \t]+)/m);
    const prefix = leadingSpaces?.[1] ?? "";
    frontmatter[currentKey] = prefix
      ? rawBlock.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "").replace(/^\n/, "")
      : rawBlock;
    currentKey = null;
    currentBlockLines = null;
    currentIndent = null;
  }

  for (const line of lines) {
    const indent = line.search(/\S|$/); // position of first non-whitespace char
    if (currentKey !== null && currentBlockLines !== null && indent > (currentIndent ?? 0)) {
      currentBlockLines.push(line);
      continue;
    }

    flushBlockValue();

    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (value === "") {
        currentKey = match[1];
        currentBlockLines = [];
        currentIndent = indent;
      } else {
        frontmatter[match[1]] = value;
      }
    }
  }

  flushBlockValue();

  return { frontmatter, body };
}
