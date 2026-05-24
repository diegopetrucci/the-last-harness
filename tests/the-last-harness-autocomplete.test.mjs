import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhAutocompleteProvider } = await jiti.import("../extensions/the-last-harness/autocomplete.ts");

function createProvider(suggestions) {
	return {
		async getSuggestions() {
			return suggestions;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return { lines, cursorLine, cursorCol, item, prefix };
		},
	};
}

test("autocomplete hides only changelog in slash-command-name context", async () => {
	const suggestions = {
		items: [
			{ value: "changelog", label: "/changelog" },
			{ value: "tlh-changelog", label: "/tlh-changelog" },
			{ value: "agent", label: "/agent" },
		],
	};
	const provider = createTlhAutocompleteProvider(createProvider(suggestions));

	const result = await provider.getSuggestions(["/ch"], 0, 3, { signal: AbortSignal.abort() });

	assert.deepEqual(result?.items.map((item) => item.value), ["tlh-changelog", "agent"]);
});

test("autocomplete keeps changelog outside slash-command-name context", async () => {
	const suggestions = {
		items: [
			{ value: "changelog", label: "/changelog" },
			{ value: "agent", label: "/agent" },
		],
	};
	const provider = createTlhAutocompleteProvider(createProvider(suggestions));

	const result = await provider.getSuggestions(["/agent ch"], 0, 9, { signal: AbortSignal.abort() });

	assert.strictEqual(result, suggestions);
});

test("autocomplete returns null when changelog filtering removes every suggestion", async () => {
	const provider = createTlhAutocompleteProvider(createProvider({
		items: [{ value: "changelog", label: "/changelog" }],
	}));

	const result = await provider.getSuggestions(["/changelog"], 0, 10, { signal: AbortSignal.abort() });

	assert.equal(result, null);
});
