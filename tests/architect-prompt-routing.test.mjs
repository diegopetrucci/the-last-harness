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
