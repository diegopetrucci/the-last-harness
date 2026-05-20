import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { AUTOCOMPLETE_SOURCE_TAG_PATTERN } from "./constants.js";

function stripAutocompleteSourceTag(description: string | undefined): string | undefined {
	if (!description) {
		return description;
	}
	const stripped = description.replace(AUTOCOMPLETE_SOURCE_TAG_PATTERN, "$1").trim();
	return stripped || undefined;
}

function stripAutocompleteSourceTags(suggestions: AutocompleteSuggestions | null): AutocompleteSuggestions | null {
	if (!suggestions) {
		return suggestions;
	}

	let changed = false;
	const items = suggestions.items.map((item) => {
		const description = stripAutocompleteSourceTag(item.description);
		if (description === item.description) {
			return item;
		}
		changed = true;
		if (description) {
			return { ...item, description };
		}
		const next = { ...item };
		delete next.description;
		return next;
	});

	return changed ? { ...suggestions, items } : suggestions;
}

export function createTlhAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: { signal: AbortSignal; force?: boolean },
		) {
			return stripAutocompleteSourceTags(await current.getSuggestions(lines, cursorLine, cursorCol, options));
		},
		applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
