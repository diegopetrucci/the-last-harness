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

test("architect.md contains librarian/web-scout routing rule paragraph", () => {
	assert.match(
		architectMd,
		/Use `librarian` for GitHub repositories, issues, pull requests, releases, and project docs; use `web-scout` for general web research outside GitHub\. If both could apply, prefer `librarian` for code\/source-history questions\./,
	);
});
