import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const architectMd = readFileSync(join(repoRoot, "agents", "primary", "architect.md"), "utf8");

test("architect.md contains web-scout bullet in the subagent tools list", () => {
	assert.match(
		architectMd,
		/- `web-scout`: research the general web outside GitHub via Exa-backed search and fetch in an isolated read-only context\./,
	);
});

test("architect.md lists librarian and web-scout as allowed minor agents with distinct research scopes", () => {
	assert.match(
		architectMd,
		/- `librarian`: research external GitHub repositories, issues, pull requests, releases, or docs read-only when outside evidence is needed\.\n- `web-scout`: research the general web outside GitHub via Exa-backed search and fetch in an isolated read-only context\./,
	);
});

test("architect.md limits pre-ticket oracle suggestions to higher-risk planning work", () => {
	assert.match(
		architectMd,
		/Only consider the `oracle` before ticket creation when the planning work looks high-stakes, uncertain, hard to validate, hard to undo, or likely to have a broad blast radius\./,
	);
});

test("architect.md excludes routine localized reversible directly testable work from oracle suggestions", () => {
	assert.match(
		architectMd,
		/Do not suggest the `oracle` for routine localized work that is reversible and directly testable\./,
	);
});

test("architect.md requires specific risk wording and explicit consent before using oracle", () => {
	assert.match(
		architectMd,
		/If you think the `oracle` could help, explain the specific risk or uncertainty and ask the user if they want you to use it\./,
	);
	assert.match(architectMd, /Never trigger the `oracle` unless the user explicitly agrees\./);
});
