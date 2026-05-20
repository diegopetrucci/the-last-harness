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
	"README.md",
	"CHANGELOG.md",
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

test("user-facing ticket docs describe mandatory managed tk behavior", () => {
	const readme = readRepoFile("README.md");
	const install = readRepoFile("docs/install.md");
	const integrations = readRepoFile("docs/integrations.md");
	const changelog = readRepoFile("CHANGELOG.md");

	assert.match(readme, /TLH requires `tk`/);
	assert.match(readme, /`~\/\.the-last-harness\/agent\/bin\/tk`/);
	assert.match(install, /requires `tk` ticket integration/);
	assert.match(install, /install fails with an actionable error/);
	assert.match(install, /`tlh update` fails with an actionable error/);
	assert.match(integrations, /requires the `tk` ticket CLI/);
	assert.match(integrations, /install or update fails with an actionable error/);
	assert.match(changelog, /`tk` ticket integration is now mandatory/);
});

test("user-facing docs and installer help do not advertise legacy ticket opt-outs", () => {
	const sources = [...userFacingDocs, "install.sh"];

	for (const path of sources) {
		const source = readRepoFile(path);
		for (const pattern of legacyTicketGuidancePatterns) {
			assert.doesNotMatch(source, pattern, `${path} still matches ${pattern}`);
		}
	}
});
