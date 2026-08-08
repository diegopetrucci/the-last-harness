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
			{ value: "scoped-models", label: "/scoped-models" },
			{ value: "subagent-cost", label: "/subagent-cost" },
			{ value: "skill:librarian", label: "/skill:librarian" },
			{ value: "websearch", label: "/websearch" },
			{ value: "curator", label: "/curator" },
			{ value: "search", label: "/search" },
			{ value: "quiet-tools", label: "/quiet-tools" },
			{ value: "investigate-revalidate-current", label: "/investigate-revalidate-current" },
			{ value: "tlh-changelog", label: "/tlh-changelog" },
			{ value: "agent", label: "/agent" },
		],
	};
	const provider = createTlhAutocompleteProvider(createProvider(suggestions));

	const result = await provider.getSuggestions(["/q"], 0, 2, { signal: AbortSignal.abort() });

	assert.deepEqual(
		result?.items.map((item) => item.value),
		["investigate-revalidate-current", "tlh-changelog", "agent"],
	);
});

test("autocomplete keeps hidden commands outside slash-command-name context", async () => {
	const suggestions = {
		items: [
			{ value: "changelog", label: "/changelog" },
			{ value: "clone", label: "/clone" },
			{ value: "import", label: "/import" },
			{ value: "scoped-models", label: "/scoped-models" },
			{ value: "subagent-cost", label: "/subagent-cost" },
			{ value: "skill:librarian", label: "/skill:librarian" },
			{ value: "websearch", label: "/websearch" },
			{ value: "curator", label: "/curator" },
			{ value: "search", label: "/search" },
			{ value: "quiet-tools", label: "/quiet-tools" },
			{ value: "investigate-revalidate-current", label: "/investigate-revalidate-current" },
			{ value: "agent", label: "/agent" },
		],
	};
	const provider = createTlhAutocompleteProvider(createProvider(suggestions));

	const result = await provider.getSuggestions(["/agent quiet"], 0, 12, { signal: AbortSignal.abort() });

	assert.strictEqual(result, suggestions);
});

test("autocomplete returns null when filtering removes every slash-command suggestion", async () => {
	const provider = createTlhAutocompleteProvider(
		createProvider({
			items: [
				{ value: "changelog", label: "/changelog" },
				{ value: "clone", label: "/clone" },
				{ value: "import", label: "/import" },
				{ value: "scoped-models", label: "/scoped-models" },
				{ value: "subagent-cost", label: "/subagent-cost" },
				{ value: "skill:librarian", label: "/skill:librarian" },
				{ value: "websearch", label: "/websearch" },
				{ value: "curator", label: "/curator" },
				{ value: "search", label: "/search" },
				{ value: "quiet-tools", label: "/quiet-tools" },
			],
		}),
	);

	const result = await provider.getSuggestions(["/quiet-tools"], 0, 13, { signal: AbortSignal.abort() });

	assert.equal(result, null);
});

test("wrapper forwards triggerCharacters when the underlying provider declares them", () => {
	const underlying = {
		triggerCharacters: ["#", "$"],
		async getSuggestions() {
			return { items: [] };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return { lines, cursorLine, cursorCol, item, prefix };
		},
	};
	const wrapper = createTlhAutocompleteProvider(underlying);

	assert.deepEqual(wrapper.triggerCharacters, ["#", "$"]);
});

test("wrapper has no triggerCharacters property when the underlying provider omits it", () => {
	const wrapper = createTlhAutocompleteProvider(createProvider({ items: [] }));

	assert.ok(!("triggerCharacters" in wrapper), "wrapper must not have an own triggerCharacters key");
});
