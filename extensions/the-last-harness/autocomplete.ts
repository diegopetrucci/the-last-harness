import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { AUTOCOMPLETE_SOURCE_TAG_PATTERN } from "./constants.js";

const HIDDEN_SLASH_COMMANDS = new Set([
	"changelog",
	"clone",
	"import",
	"scoped-models",
	"subagents-profiles",
	"subagents-check-profile",
	"subagents-models",
	"skill:librarian",
	"websearch",
	"curator",
	"search",
	"quiet-tools",
]);

function stripAutocompleteSourceTag(description: string | undefined): string | undefined {
	if (!description) {
		return description;
	}
	const stripped = description.replace(AUTOCOMPLETE_SOURCE_TAG_PATTERN, "$1").trim();
	return stripped || undefined;
}

function isSlashCommandNameContext(lines: string[], cursorLine: number, cursorCol: number): boolean {
	const currentLine = lines[cursorLine] || "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	return textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ");
}

function transformSuggestions(
	suggestions: AutocompleteSuggestions | null,
	options: { filterSlashCommandSuggestions: boolean },
): AutocompleteSuggestions | null {
	if (!suggestions) {
		return suggestions;
	}

	let changed = false;
	const items: AutocompleteItem[] = [];
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

export function createTlhAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
		async getSuggestions(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: { signal: AbortSignal; force?: boolean },
		) {
			return transformSuggestions(await current.getSuggestions(lines, cursorLine, cursorCol, options), {
				filterSlashCommandSuggestions: isSlashCommandNameContext(lines, cursorLine, cursorCol),
			});
		},
		applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
