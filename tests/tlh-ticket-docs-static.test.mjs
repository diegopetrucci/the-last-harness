import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readRepoFile(path) {
	return readFileSync(join(repoRoot, path), "utf8");
}

const userFacingDocs = [
	"CHANGELOG.md",
	"docs/git-attribution.md",
	"docs/install.md",
	"docs/integrations.md",
	"docs/local-development.md",
	"docs/releasing.md",
];

const legacyTicketGuidancePatterns = [
	/--with-tickets/,
	/--without-tickets/,
	/--no-tickets/,
	/tlh tickets disable/i,
	/non-ticket/i,
	/conversation-based plans/i,
	/fall back to conversation/i,
	/ticket integration is disabled/i,
	/disable ticket integration/i,
	/disabling ticket integration/i,
	/tlh tickets configure-install/i,
	/tickets configure-install/i,
];

test("user-facing docs and installer help do not advertise legacy ticket opt-outs", () => {
	const sources = [...userFacingDocs, "install.sh"];

	for (const path of sources) {
		const source = readRepoFile(path);
		for (const pattern of legacyTicketGuidancePatterns) {
			assert.doesNotMatch(source, pattern, `${path} still matches ${pattern}`);
		}
	}
});

test("contributing guide links to the upstream-sync inventory", () => {
	const source = readRepoFile("CONTRIBUTING.md");
	assert.match(source, /docs\/upstream-sync-inventory\.md/);
});

test("upstream-sync inventory documents required provenance caveats and exclusions", () => {
	const source = readRepoFile("docs/upstream-sync-inventory.md");
	assert.match(source, /Historically reconstructed.*not originally attested/i);
	assert.match(source, /2e839268686fbc530a5ab2cef4667d53fdb4b2d5/);
	assert.match(source, /bd0701670693372e687ed732e98ec338e60a0fb4/);
	assert.match(source, /packages\/diff-review/);
	assert.match(source, /package version `0\.2\.5`/);
	assert.match(source, /src\/core\/model-resolver\.ts/);
	assert.match(source, /ordinary dependency pins by themselves/i);
	assert.match(source, /generated runtime `scripts\/\*\*\/\*\.mjs` outputs/i);
	assert.match(source, /quarterly and on upstream package\/repo releases/i);
});

test("tracked upstream-sync source files point readers to the inventory", () => {
	for (const path of [
		"extensions/annotate-git-diff/index.ts",
		"extensions/rtk.ts",
		"extensions/shared/quiet-glimpse.ts",
		"extensions/the-last-harness/model-visibility.ts",
		"extensions/the-last-harness/new-version-notice.ts",
		"extensions/the-last-harness/package-update-notice.ts",
		"extensions/the-last-harness/profile-state.ts",
		"extensions/the-last-harness/resources.ts",
		"extensions/the-last-harness/thinking.ts",
		"extensions/the-last-harness/tokens-analyzer.ts",
	]) {
		assert.match(readRepoFile(path), /upstream-sync-inventory\.md/, `${path} should reference the inventory`);
	}
});
