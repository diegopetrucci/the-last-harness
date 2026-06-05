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

test("autocomplete hides configured slash commands only in slash-command-name context", async () => {
	const suggestions = {
		items: [
			{ value: "changelog", label: "/changelog" },
			{ value: "clone", label: "/clone" },
			{ value: "import", label: "/import" },
			{ value: "oracle-model", label: "/oracle-model" },
			{ value: "quiet-tools", label: "/quiet-tools" },
			{ value: "fff-health", label: "/fff-health" },
			{ value: "fff-rescan", label: "/fff-rescan" },
			{ value: "fff-mode", label: "/fff-mode" },
			{ value: "intercom", label: "/intercom" },
			{ value: "tlh-changelog", label: "/tlh-changelog" },
			{ value: "agent", label: "/agent" },
		],
	};
	const provider = createTlhAutocompleteProvider(createProvider(suggestions));

	const result = await provider.getSuggestions(["/q"], 0, 2, { signal: AbortSignal.abort() });

	assert.deepEqual(result?.items.map((item) => item.value), ["tlh-changelog", "agent"]);
});

test("autocomplete keeps hidden commands outside slash-command-name context", async () => {
	const suggestions = {
		items: [
			{ value: "changelog", label: "/changelog" },
			{ value: "clone", label: "/clone" },
			{ value: "import", label: "/import" },
			{ value: "oracle-model", label: "/oracle-model" },
			{ value: "quiet-tools", label: "/quiet-tools" },
			{ value: "fff-health", label: "/fff-health" },
			{ value: "intercom", label: "/intercom" },
			{ value: "agent", label: "/agent" },
		],
	};
	const provider = createTlhAutocompleteProvider(createProvider(suggestions));

	const result = await provider.getSuggestions(["/agent quiet"], 0, 12, { signal: AbortSignal.abort() });

	assert.strictEqual(result, suggestions);
});

test("autocomplete returns null when filtering removes every slash-command suggestion", async () => {
	const provider = createTlhAutocompleteProvider(createProvider({
		items: [
			{ value: "changelog", label: "/changelog" },
			{ value: "clone", label: "/clone" },
			{ value: "import", label: "/import" },
			{ value: "oracle-model", label: "/oracle-model" },
			{ value: "quiet-tools", label: "/quiet-tools" },
			{ value: "fff-health", label: "/fff-health" },
			{ value: "fff-rescan", label: "/fff-rescan" },
			{ value: "fff-mode", label: "/fff-mode" },
			{ value: "intercom", label: "/intercom" },
		],
	}));

	const result = await provider.getSuggestions(["/fff-health"], 0, 11, { signal: AbortSignal.abort() });

	assert.equal(result, null);
});
