import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readRepoFile(path) {
	return readFileSync(join(repoRoot, path), "utf8");
}

function readUnreleasedChangelog() {
	const changelog = readRepoFile("CHANGELOG.md");
	const match = changelog.match(/## \[Unreleased\][\s\S]*?(?=\n## \[\d+\.\d+\.\d+[^\]]*\]|$)/);
	assert.ok(match, "CHANGELOG.md should contain an Unreleased section");
	return match[0];
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
		/Separately-installed pi[\s\S]{0,300}npm uninstall -g --ignore-scripts --prefix "\$HOME\/\.local" @earendil-works\/pi-coding-agent/,
	);
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

test("commands docs keep /experimental for delta follow-up reviews and ci failure investigation while describing contrarian as bundled by default", () => {
	const commandsDoc = readRepoFile("docs/commands.md");

	assert.match(commandsDoc, /`\/experimental`/);
	assert.match(commandsDoc, /contrarian/);
	assert.match(commandsDoc, /bundled default minor subagent/i);
	assert.match(commandsDoc, /not part of the `\/experimental` toggle surface/i);
	assert.match(commandsDoc, /delta-follow-up-reviews/);
	assert.match(commandsDoc, /ci-failure-investigation/);
	assert.match(commandsDoc, /architect primary agent do read-only failed ci\/status-check investigation/i);
	assert.doesNotMatch(commandsDoc, /\/experimental enable contrarian/);
	assert.doesNotMatch(commandsDoc, /\/experimental disable contrarian/);
	assert.match(commandsDoc, /before any edits, commits, pushes, reruns, pr changes, or other follow-up changes/i);
	assert.match(commandsDoc, /Both flags are disabled by default/i);
	assert.match(commandsDoc, /stale `run-tests-last` values/i);
	assert.doesNotMatch(commandsDoc, /contrarian-subagent/);
});

test("README and changelog describe review opposite-provider fallback policy", () => {
	const readme = readRepoFile("README.md");
	const changelog = readRepoFile("CHANGELOG.md");

	assert.match(readme, /`code-reviewer` and `oracle` intentionally prefer an available opposite provider/i);
	assert.match(readme, /`contrarian` uses that same opposite-provider pattern/i);
	assert.match(readme, /Anthropic sessions[\s\S]{0,180}OpenAI Codex subscription provider[\s\S]{0,80}available/i);
	assert.match(readme, /OpenAI\/OpenAI-Codex sessions[\s\S]{0,120}Anthropic/i);
	assert.match(readme, /same\/current-provider fallback[\s\S]{0,160}review independence is reduced/i);
	assert.match(readme, /OpenAI API access[\s\S]{0,220}does not force `code-reviewer`, `oracle`, or `contrarian` onto unavailable Codex-only defaults/i);
	assert.match(changelog, /opposite-provider model[\s\S]{0,120}`code-reviewer` or `oracle`/i);
	assert.match(changelog, /same\/current-provider fallback[\s\S]{0,160}review independence is reduced/i);
	assert.match(changelog, /`code-reviewer` now prefers an available opposite provider/i);
	assert.match(changelog, /OpenAI API-only setups are not forced onto unavailable Codex-only defaults/i);
	assert.doesNotMatch(changelog, /`code-reviewer` now defaults to `openai-codex\/gpt-5\.5`/);
});

test("README, commands, install, integrations, and changelog docs describe the managed native RTK migration", () => {
	const readme = readRepoFile("README.md");
	const commandsDoc = readRepoFile("docs/commands.md");
	const install = readRepoFile("docs/install.md");
	const integrations = readRepoFile("docs/integrations.md");
	const unreleased = readUnreleasedChangelog();

	assert.match(readme, /managed `rtk` at `~\/\.the-last-harness\/agent\/bin\/rtk`/i);
	assert.match(readme, /RTK_DISABLED=1/);
	assert.match(readme, /`~\/\.the-last-harness\/agent\/settings\.json`/);
	assert.match(install, /`~\/\.the-last-harness\/agent\/bin\/rtk`/);
	assert.match(install, /managed RTK binary/);
	assert.match(install, /RTK_DISABLED=1/);
	assert.match(install, /`tlh\.rtk\.disabled`/);
	assert.match(install, /delete `~\/\.the-last-harness\/agent\/bin\/rtk`/);
	assert.match(install, /Managed RTK is pinned to `rtk-ai\/rtk` `v0\.42\.4`/);
	assert.match(install, /SHA-256 verification and validation/);
	assert.doesNotMatch(commandsDoc, /\| `\/rtk` \|/);
	assert.match(commandsDoc, /does not register `\/rtk`/);
	assert.match(commandsDoc, /`tlh\.rtk\.disabled`/);
	assert.match(integrations, /There is no `\/rtk` command surface anymore/);
	assert.match(integrations, /`\/rtk enable`, `\/rtk disable`, and `\/rtk status` are gone/);
	assert.match(integrations, /install or update fails with an actionable error/);
	assert.match(integrations, /`tlh\.rtk\.disabled`/);
	assert.match(integrations, /delete `~\/\.the-last-harness\/agent\/bin\/rtk`/);
	assert.match(unreleased, /Removed the old `\/rtk` command UI/);
	assert.match(unreleased, /Migrated TLH away from the old bundled `pi-rtk` fork/);
	assert.match(unreleased, /`RTK_DISABLED=1` or `tlh\.rtk\.disabled`/);
});

test("readUnreleasedChangelog stops before the next version heading", () => {
	const unreleased = readUnreleasedChangelog();

	assert.doesNotMatch(unreleased, /\n## \[\d+\.\d+\.\d+/);
});

test("README and changelog describe contrarian as a bundled default sparing adversarial subagent", () => {
	const readme = readRepoFile("README.md");
	const unreleased = readUnreleasedChangelog();

	assert.match(readme, /bundled default minor subagent[\s\S]{0,80}`contrarian`|`contrarian` as a bundled default minor subagent/i);
	assert.doesNotMatch(readme, /bundled experimental subagent/i);
	assert.doesNotMatch(readme, /default-off/i);
	assert.doesNotMatch(readme, /\/experimental enable contrarian/i);
	assert.doesNotMatch(readme, /\/experimental disable contrarian/i);
	assert.match(readme, /Use `contrarian` sparingly[\s\S]{0,260}before ticket creation[\s\S]{0,220}specific risk|Use `contrarian` sparingly[\s\S]{0,260}specific risk[\s\S]{0,220}before ticket creation/i);
	assert.match(readme, /not the normal diff reviewer[\s\S]{0,120}`code-reviewer` reviews changes against tasks/i);
	assert.match(readme, /different from `oracle`[\s\S]{0,120}broader second-opinion path/i);
	assert.match(readme, /`contrarian` uses that same independence pattern/i);
	assert.doesNotMatch(readme, /contrarian-subagent/);
	assert.match(unreleased, /Promoted `contrarian` from an experimental opt-in to a bundled default minor subagent/i);
	assert.match(unreleased, /sparing adversarial stress-test path rather than a `\/experimental` enable\/disable toggle/i);
	assert.doesNotMatch(unreleased, /default-off/i);
	assert.doesNotMatch(unreleased, /\/experimental enable contrarian/i);
});
