import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readRepoFile(path) {
	return readFileSync(join(repoRoot, path), "utf8");
}

const userFacingDocs = [
	"docs/git-attribution.md",
	"docs/install.md",
	"docs/integrations.md",
	"docs/local-development.md",
	"docs/releasing.md",
];

const historicalRtkDocs = new Set([
	"docs/pi-startup-investigation-2026-07-15.md",
]);

function listMarkdownFiles(rootPath, basePath = rootPath) {
	const results = [];
	for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
		const entryPath = join(rootPath, entry.name);
		if (entry.isDirectory()) {
			results.push(...listMarkdownFiles(entryPath, basePath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push(entryPath.slice(basePath.length + 1).replaceAll("\\", "/"));
		}
	}
	return results;
}

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

test("current README and active docs contain no RTK references", () => {
	const currentDocs = [
		"README.md",
		...listMarkdownFiles(join(repoRoot, "docs")).map((path) => `docs/${path}`),
	].filter((path, index, paths) => paths.indexOf(path) === index && !historicalRtkDocs.has(path));

	for (const path of currentDocs) {
		assert.doesNotMatch(readRepoFile(path), /rtk/i, `${path} still references RTK`);
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
	assert.match(source, /generated runtime `scripts\/\*\*\/\*\.mjs` outputs.*generated same-layout `extensions\/\*\*\/\*\.js` outputs/i);
	assert.match(source, /review same-named `scripts\/\*\*\/\*\.mts` and authoritative `extensions\/\*\*\/\*\.ts` sources rather than their generated `scripts\/\*\*\/\*\.mjs` \/ `extensions\/\*\*\/\*\.js` mirrors/i);
	assert.match(source, /quarterly and on upstream package\/repo releases/i);
});

test("tracked upstream-sync source files point readers to the inventory", () => {
	for (const path of [
		"extensions/annotate-git-diff/index.ts",
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
