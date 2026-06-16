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

const annotateGitDiffDocs = [
	"README.md",
	"docs/commands.md",
	"extensions/annotate-git-diff/README.md",
	"CHANGELOG.md",
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

test("install, integrations, and changelog docs describe mandatory managed tk behavior", () => {
	const install = readRepoFile("docs/install.md");
	const integrations = readRepoFile("docs/integrations.md");
	const changelog = readRepoFile("CHANGELOG.md");

	assert.match(install, /requires `tk` ticket integration/);
	assert.match(install, /`~\/\.the-last-harness\/agent\/bin\/tk`/);
	assert.match(install, /install fails with an actionable error/);
	assert.match(install, /`tlh update` fails with an actionable error/);
	assert.match(integrations, /requires the `tk` ticket CLI/);
	assert.match(integrations, /install or update fails with an actionable error/);
	assert.match(changelog, /`tk` ticket integration is now mandatory/);
});

test("integrations docs describe Rush primary behavior and default tk-loop exception", () => {
	const integrations = readRepoFile("docs/integrations.md");

	assert.match(
		integrations,
		/Rush keeps that tooling available but handles small bounded tasks with direct edits instead of the default `tk` loop/i,
	);
	assert.match(
		integrations,
		/does not start with the default ticket\/developer\/review loop, even though the managed `tk` command is still installed/i,
	);
});

test("git attribution docs carry the detailed behavior while changelog records the release", () => {
	const attributionDoc = readRepoFile("docs/git-attribution.md");
	const changelog = readRepoFile("CHANGELOG.md");

	assert.match(attributionDoc, /`\/toggle-tlh-git-attribution`/);
	assert.match(attributionDoc, /`tlh\.attribution\.commit` is unset or `true`/);
	assert.match(attributionDoc, /Co-authored-by: The Last Harness <hi@thelastharness\.com>/);
	assert.match(attributionDoc, /Set `tlh\.attribution\.commit` to `false`/);
	assert.match(attributionDoc, /Delete `tlh\.attribution\.commit`/);
	assert.match(attributionDoc, /TLH does not change `git push`/);
	assert.doesNotMatch(attributionDoc, /`\/attribution toggle`/);
	assert.doesNotMatch(attributionDoc, /Set `tlh\.attribution\.commit` to `""`/);
	assert.doesNotMatch(attributionDoc, /custom footer/i);
	assert.doesNotMatch(attributionDoc, /noreply@the-last-harness\.invalid/);
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

test("annotate-git-diff docs use the renamed command and extension names", () => {
	for (const path of annotateGitDiffDocs) {
		const source = readRepoFile(path);
		assert.match(source, /annotate-git-diff/, `${path} should mention annotate-git-diff`);
		assert.doesNotMatch(source, /\/diff-review/, `${path} still mentions /diff-review`);
	}

	const commandsDoc = readRepoFile("docs/commands.md");
	assert.doesNotMatch(commandsDoc, /extensions\/diff-review\/README\.md/);
	assert.match(commandsDoc, /`annotate-git-diff`/);
});

test("commands docs keep /experimental registered with delta-follow-up-reviews and without reviving run-tests-last guidance", () => {
	const commandsDoc = readRepoFile("docs/commands.md");

	assert.match(commandsDoc, /`\/experimental`/);
	assert.match(commandsDoc, /delta-follow-up-reviews/);
	assert.match(commandsDoc, /disabled by default/i);
	assert.match(commandsDoc, /stale `run-tests-last` values/i);
});

test("README and changelog describe code-reviewer opposite-provider policy", () => {
	const readme = readRepoFile("README.md");
	const changelog = readRepoFile("CHANGELOG.md");

	assert.match(readme, /`code-reviewer` intentionally prefers an available opposite provider/i);
	assert.match(readme, /Anthropic sessions[\s\S]{0,180}OpenAI Codex subscription provider[\s\S]{0,80}available/i);
	assert.match(readme, /OpenAI\/OpenAI-Codex sessions[\s\S]{0,120}Anthropic review[\s\S]{0,80}available/i);
	assert.match(readme, /OpenAI API access[\s\S]{0,160}does not force `code-reviewer` onto unavailable Codex-only defaults/i);
	assert.match(changelog, /`code-reviewer` now prefers an available opposite provider/i);
	assert.match(changelog, /OpenAI API-only setups are not forced onto unavailable Codex-only defaults/i);
	assert.doesNotMatch(changelog, /`code-reviewer` now defaults to `openai-codex\/gpt-5\.5`/);
});
