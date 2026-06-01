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

test("README and integrations docs describe Rush primary behavior and switching controls", () => {
	const readme = readRepoFile("README.md");
	const integrations = readRepoFile("docs/integrations.md");

	assert.match(readme, /selectable primary for small bounded implementation tasks/i);
	assert.match(readme, /skips the default architect `tk`\/developer\/review loop/i);
	assert.match(readme, /`code-reviewer`/);
	assert.match(readme, /`oracle` is an optional deeper second opinion/i);
	assert.match(readme, /GPT-5\.5 with thinking off on OpenAI\/OpenAI-Codex/i);
	assert.match(readme, /Anthropic Opus with low thinking on Anthropic/i);
	assert.match(readme, /`architect` → `rush` → `product` → `bug-hunter` → `disabled`/);
	assert.match(readme, /\/switch-primary-agent \[status\|architect\|rush\|product\|bug-hunter\|disabled\|reset\|default architect\|default rush\|default product\|default bug-hunter\|default disabled\|default reset\]/);
	assert.match(readme, /`\/review` is architect-only/i);
	assert.doesNotMatch(readme, /`\/tlh(?=`| \[)/);
	assert.doesNotMatch(readme, /`\/harness(?=`| \[)/);
	assert.doesNotMatch(readme, /`\/agent(?=`| \[)/);
	assert.doesNotMatch(readme, /`\/architect(?=`| \[)/);
	assert.match(integrations, /Rush keeps that tooling available but handles small bounded tasks with direct edits instead of the default `tk` loop/i);
});

test("README and changelog document boolean-only TLH commit attribution", () => {
	const readme = readRepoFile("README.md");
	const changelog = readRepoFile("CHANGELOG.md");

	assert.match(readme, /`\/toggle-tlh-git-attribution`/);
	assert.match(readme, /`tlh\.attribution\.commit` is unset or `true`/);
	assert.match(readme, /Co-authored-by: The Last Harness <hi@thelastharness\.com>/);
	assert.match(readme, /Set `tlh\.attribution\.commit` to `false`/);
	assert.match(readme, /Deleting `tlh\.attribution\.commit` from `~\/\.the-last-harness\/agent\/settings\.json`/);
	assert.doesNotMatch(readme, /`\/attribution toggle`/);
	assert.doesNotMatch(readme, /Set `tlh\.attribution\.commit` to `""`/);
	assert.doesNotMatch(readme, /custom footer/i);
	assert.doesNotMatch(readme, /noreply@the-last-harness\.invalid/);
	assert.match(changelog, /`\/toggle-tlh-git-attribution`/);
	assert.match(changelog, /boolean `tlh\.attribution\.commit` settings/);
	assert.doesNotMatch(changelog, /`\/attribution toggle`/);
});

test("install docs describe separate pi removal with the TLH per-user npm prefix", () => {
	const install = readRepoFile("docs/install.md");

	assert.match(
		install,
		/Separately-installed pi binary[\s\S]{0,240}npm uninstall -g --prefix "\$HOME\/\.local" @earendil-works\/pi-coding-agent/,
	);
	assert.match(install, /owned by a different npm prefix, uninstall it from that same prefix instead/i);
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
