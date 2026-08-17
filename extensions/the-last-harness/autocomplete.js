import { AUTOCOMPLETE_SOURCE_TAG_PATTERN } from "./constants.js";
const HIDDEN_SLASH_COMMANDS = new Set([
    "changelog",
    "import",
    "scoped-models",
    "subagent-cost",
    "skill:librarian",
    "websearch",
    "curator",
    "search",
    "quiet-tools",
]);
function stripAutocompleteSourceTag(description) {
    if (!description) {
        return description;
    }
    const stripped = description.replace(AUTOCOMPLETE_SOURCE_TAG_PATTERN, "$1").trim();
    return stripped || undefined;
}
function isSlashCommandNameContext(lines, cursorLine, cursorCol) {
    const currentLine = lines[cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    return textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ");
}
function transformSuggestions(suggestions, options) {
    if (!suggestions) {
        return suggestions;
    }
    let changed = false;
    const items = [];
    for (const item of suggestions.items) {
        if (options.filterSlashCommandSuggestions && HIDDEN_SLASH_COMMANDS.has(item.value)) {
            changed = true;
            continue;
        }
        const description = stripAutocompleteSourceTag(item.description);
        if (description === item.description) {
            items.push(item);
            continue;
        }
        changed = true;
        if (description) {
            items.push({ ...item, description });
            continue;
        }
        const next = { ...item };
        delete next.description;
        items.push(next);
    }
    if (items.length === 0) {
        return null;
    }
    return changed ? { ...suggestions, items } : suggestions;
}
export function createTlhAutocompleteProvider(current) {
    return {
        ...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
        async getSuggestions(lines, cursorLine, cursorCol, options) {
            return transformSuggestions(await current.getSuggestions(lines, cursorLine, cursorCol, options), {
                filterSlashCommandSuggestions: isSlashCommandNameContext(lines, cursorLine, cursorCol),
            });
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
            return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
    };
}
