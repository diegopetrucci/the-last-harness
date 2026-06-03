import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
	TLH_DEFAULT_COMMIT_ATTRIBUTION,
	buildTlhCommitAttributionPrompt,
	getTlhGitCommitAttributionBlockReason,
	registerToggleTlhGitAttributionCommand,
	resolveTlhCommitAttribution,
} = await jiti.import("../extensions/the-last-harness/attribution.ts");

function createPiHarness() {
	const commands = new Map();
	return {
		commands,
		on(_name, _handler) {
			throw new Error("unexpected runtime registration");
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};
}

function createCommandContext(cwd) {
	const notifications = [];
	return {
		notifications,
		ctx: {
			cwd,
			ui: {
				notify(message, type = "info") {
					notifications.push({ message, type });
				},
			},
		},
	};
}

function registeredToggleCommand() {
	const pi = createPiHarness();
	registerToggleTlhGitAttributionCommand(pi);
	assert.equal(pi.commands.has("attribution"), false, "does not register /attribution");
	const command = pi.commands.get("toggle-tlh-git-attribution");
	assert.ok(command, "registers /toggle-tlh-git-attribution");
	return command;
}

test("commit attribution helper resolves unset and boolean preference values", () => {
	assert.equal(
		TLH_DEFAULT_COMMIT_ATTRIBUTION,
		"🤖 Generated with [The Last Harness](https://github.com/diegopetrucci/the-last-harness)\n\nCo-authored-by: The Last Harness <hi@thelastharness.com>",
	);
	assert.deepEqual(resolveTlhCommitAttribution(undefined), {
		enabled: true,
		footer: TLH_DEFAULT_COMMIT_ATTRIBUTION,
	});
	assert.deepEqual(resolveTlhCommitAttribution({ commit: true }), {
		enabled: true,
		footer: TLH_DEFAULT_COMMIT_ATTRIBUTION,
	});
	assert.deepEqual(resolveTlhCommitAttribution({ commit: false }), {
		enabled: false,
	});
});

test("commit attribution prompt helper only renders when enabled", () => {
	assert.equal(buildTlhCommitAttributionPrompt({ enabled: false }), undefined);
	assert.match(buildTlhCommitAttributionPrompt(resolveTlhCommitAttribution(undefined)) ?? "", /## TLH Git Commit Attribution/);
	assert.match(
		buildTlhCommitAttributionPrompt(resolveTlhCommitAttribution(undefined)) ?? "",
		/Co-authored-by: The Last Harness <hi@thelastharness\.com>/,
	);
});

test("git commit attribution guard blocks only obvious unattributed inline commit commands", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const [footerHeading, footerCoAuthor] = TLH_DEFAULT_COMMIT_ATTRIBUTION.split("\n\n");
	const attributedHereDoc = `git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;
	const wrappedAttributedHereDoc = `if true; then git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF\nfi`;
	const attributedWrappedInlineMessage = `bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedWrappedInlineMessageWithTerminator = `bash -lc -- 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedWrappedSplitMessage = `sh -c 'git commit -m "subject" -m "${footerHeading}" -m "${footerCoAuthor}"'`;
	const attributedWrappedSplitMessageWithTerminator = `sh -c -- 'git commit -m "subject" -m "${footerHeading}" -m "${footerCoAuthor}"'`;
	const attributedEnvInlineMessage = `env FOO=bar git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedQualifiedEnvInlineMessage = `/usr/bin/env FOO=bar git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedUnsetEnvInlineMessage = `env --unset=FOO git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedPathEnvInlineMessage = `env -P /usr/bin git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedUnsupportedEnvInlineMessage = `env -x git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedUnsupportedEnvWrappedInlineMessage = `env -x bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attachedSplitStringCommit = `env -S'git commit -m "ship it"'`;
	const shortAttachedSplitStringCombinedCommit = 'env -Sgit commit -m "ship it"';
	const shortQuotedSplitStringCombinedCommit = `env -S'git' commit -m "ship it"`;
	const shortQuotedSplitStringCommandCommit = `env -S'git commit' -m "ship it"`;
	const longSeparatedSplitStringCombinedCommit = 'env --split-string git commit -m "ship it"';
	const longAttachedSplitStringCombinedCommit = 'env --split-string=git commit -m "ship it"';
	const longQuotedSplitStringCombinedCommit = `env --split-string='git' commit -m "ship it"`;
	const shortQuotedSplitStringWrappedCommit = `env -S'bash -lc' 'git commit -m "ship it"'`;
	const shortQuotedSplitStringWrappedCommitWithTerminator = `env -S'bash -lc' -- 'git commit -m "ship it"'`;
	const longQuotedSplitStringWrappedCommit = `env --split-string='bash -lc' 'git commit -m "ship it"'`;
	const optionTerminatedSplitStringCommit = 'env -S -- git commit -m "ship it"';
	const optionTerminatedSplitStringWrappedCommit = `env --split-string='--' bash -lc 'git commit -m "ship it"'`;
	const unattributedUnsupportedEnvWrappedInlineMessage = `env -x bash -lc 'git commit -m "ship it"'`;
	const attachedSplitStringNoCommit = `env -S'printf ok'`;
	const optionTerminatedSplitStringNoCommit = 'env -S -- printf ok';
	const optionTerminatedSplitStringWrappedNoCommit = `env --split-string='--' bash -lc 'printf ok'`;
	const wrappedNoCommitWithTerminator = `bash -lc -- 'printf ok'`;
	const splitWrappedNoCommitWithTerminator = `env -S'bash -lc' -- 'printf ok'`;
	const unsupportedEnvWrappedNoCommit = `env -x bash -lc 'printf ok'`;
	const attributedSplitStringCombinedCommit = `env -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedLongSeparatedSplitStringCombinedCommit = `env --split-string git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedLongQuotedSplitStringCombinedCommit = `env --split-string='git' commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedShortQuotedSplitStringWrappedCommit = `env -S'bash -lc' 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShortQuotedSplitStringWrappedCommitWithTerminator = `env -S'bash -lc' -- 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedLongQuotedSplitStringWrappedCommit = `env --split-string='bash -lc' 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedOptionTerminatedSplitStringCommit = `env -S -- git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedOptionTerminatedSplitStringWrappedCommit = `env --split-string='--' bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellOptionWrappedInlineMessage = `bash -o pipefail -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellOptionWrappedInlineMessageWithTerminator = `bash -o pipefail -lc -- 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedProcessSubstitution = `git commit -F <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;
	const attributedPrintfEscapedNewlineProcessSubstitution = `git commit -F <(printf '%s\\n' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;
	const attributedEchoProcessSubstitution = `git commit -F <(echo "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;
	const unattributedWrappedProcessSubstitution = `bash -lc 'git commit -F <(printf "%s" subject || printf "%s" "${TLH_DEFAULT_COMMIT_ATTRIBUTION}")'`;
	const unattributedProcessSubstitution = `git commit -F <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nextra")`;
	const unattributedPrintfFormatProcessSubstitution = `git commit -F <(printf 'subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}extra')`;
	const unattributedPrintfArgsProcessSubstitution = `git commit -F <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}" extra)`;
	const attributedHereDocProcessSubstitution = `git commit -F <(cat <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}
EOF
)`;
	const unattributedHereDocProcessSubstitution = `git commit -F <(cat <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}

extra
EOF
)`;
	const unattributedTrailingOutputProcessSubstitution = `git commit -F <(cat <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}
EOF
printf 'extra'
)`;
	const unattributedWrongFileProcessSubstitution = `git commit -F <(printf '%s' subject) <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;
	const unattributedLastFileProcessSubstitution = `git commit -F <(printf '%s' "${TLH_DEFAULT_COMMIT_ATTRIBUTION}") -F <(printf '%s' subject)`;
	const attributedLastFileProcessSubstitution = `git commit -F <(printf '%s' subject) -F <(printf '%s' "${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;

	for (const command of [
		'git commit -m "ship it"',
		'cd repo && git commit --message "ship it"',
		'git commit -am "ship it"',
		'git -C repo commit -m "ship it"',
		'git commit -F-',
		'git commit -F -',
		'git commit --file=-',
		'git commit --file -',
		'if true; then git commit -m "ship it"; fi',
		'if false; then :; else git commit -m "ship it"; fi',
		'for f in x; do git commit -m "ship it"; done',
		'! git commit -m "ship it"',
		'if git commit -m "ship it"; then echo done; fi',
		'command git commit -m "ship it"',
		'FOO=bar git commit -m "ship it"',
		'env FOO=bar git commit -m "ship it"',
		'/usr/bin/env FOO=bar git commit -m "ship it"',
		'env --unset=FOO git commit -m "ship it"',
		'env --chdir=repo git commit -m "ship it"',
		'env -P /usr/bin git commit -m "ship it"',
		'env -p git commit -m "ship it"',
		'env -c git commit -m "ship it"',
		`env -S 'git commit -m "ship it"'`,
		attachedSplitStringCommit,
		shortAttachedSplitStringCombinedCommit,
		shortQuotedSplitStringCombinedCommit,
		shortQuotedSplitStringCommandCommit,
		longSeparatedSplitStringCombinedCommit,
		longAttachedSplitStringCombinedCommit,
		longQuotedSplitStringCombinedCommit,
		shortQuotedSplitStringWrappedCommit,
		shortQuotedSplitStringWrappedCommitWithTerminator,
		longQuotedSplitStringWrappedCommit,
		optionTerminatedSplitStringCommit,
		optionTerminatedSplitStringWrappedCommit,
		'env -x git commit -m "ship it"',
		unattributedUnsupportedEnvWrappedInlineMessage,
		`bash -lc 'git commit -m "ship it"'`,
		`bash -lc -- 'git commit -m "ship it"'`,
		`sh -c 'git commit -m "ship it"'`,
		`sh -c -- 'git commit -m "ship it"'`,
		`bash -o pipefail -lc 'git commit -m "ship it"'`,
		`bash -o pipefail -lc -- 'git commit -m "ship it"'`,
		unattributedWrappedProcessSubstitution,
		`printf '${TLH_DEFAULT_COMMIT_ATTRIBUTION}' && git commit -m "ship it"`,
		`git commit -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}" && git commit -m "ship it"`,
		`git commit -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nship it"`,
		`${attributedHereDoc}\ngit commit -m "ship it"`,
		unattributedProcessSubstitution,
		unattributedPrintfFormatProcessSubstitution,
		unattributedPrintfArgsProcessSubstitution,
		unattributedHereDocProcessSubstitution,
		unattributedTrailingOutputProcessSubstitution,
		unattributedWrongFileProcessSubstitution,
		unattributedLastFileProcessSubstitution,
	]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
	assert.equal(
		getTlhGitCommitAttributionBlockReason(
			`git commit -m "subject" -m "${footerHeading}" -m "${footerCoAuthor}"`,
			enabled,
		),
		undefined,
	);
	assert.equal(
		getTlhGitCommitAttributionBlockReason(`git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`, enabled),
		undefined,
	);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedWrappedInlineMessage, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedWrappedInlineMessageWithTerminator, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedWrappedSplitMessage, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedWrappedSplitMessageWithTerminator, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedEnvInlineMessage, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedQualifiedEnvInlineMessage, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedUnsetEnvInlineMessage, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedPathEnvInlineMessage, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedUnsupportedEnvInlineMessage, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedUnsupportedEnvWrappedInlineMessage, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedSplitStringCombinedCommit, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedLongSeparatedSplitStringCombinedCommit, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedLongQuotedSplitStringCombinedCommit, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedShortQuotedSplitStringWrappedCommit, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedShortQuotedSplitStringWrappedCommitWithTerminator, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedLongQuotedSplitStringWrappedCommit, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedOptionTerminatedSplitStringCommit, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedOptionTerminatedSplitStringWrappedCommit, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedShellOptionWrappedInlineMessage, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedShellOptionWrappedInlineMessageWithTerminator, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedHereDoc, enabled), undefined);
	assert.equal(
		getTlhGitCommitAttributionBlockReason(`if true; then git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"; fi`, enabled),
		undefined,
	);
	assert.equal(getTlhGitCommitAttributionBlockReason(wrappedAttributedHereDoc, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedProcessSubstitution, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedPrintfEscapedNewlineProcessSubstitution, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedEchoProcessSubstitution, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedHereDocProcessSubstitution, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedLastFileProcessSubstitution, enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason('git commit -F .git/COMMIT_EDITMSG', enabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason('git push origin HEAD', enabled), undefined);
	for (const command of [
		'env -P /usr/bin printf ok',
		`env -S 'printf ok'`,
		attachedSplitStringNoCommit,
		optionTerminatedSplitStringNoCommit,
		optionTerminatedSplitStringWrappedNoCommit,
		wrappedNoCommitWithTerminator,
		splitWrappedNoCommitWithTerminator,
		'env -x printf ok',
		unsupportedEnvWrappedNoCommit,
		`sh -c -- 'printf ok'`,
		`bash -o pipefail -lc 'printf ok'`,
		`bash -o pipefail -lc -- 'printf ok'`,
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
	}
	for (const command of [
		'if true; then git commit -m "ship it"; fi',
		'if git commit -m "ship it"; then echo done; fi',
		'command git commit -m "ship it"',
		'FOO=bar git commit -m "ship it"',
		'env FOO=bar git commit -m "ship it"',
		'/usr/bin/env FOO=bar git commit -m "ship it"',
		'env --unset=FOO git commit -m "ship it"',
		'env -P /usr/bin git commit -m "ship it"',
		'env -p git commit -m "ship it"',
		'env -c git commit -m "ship it"',
		`env -S 'git commit -m "ship it"'`,
		attachedSplitStringCommit,
		shortAttachedSplitStringCombinedCommit,
		shortQuotedSplitStringCombinedCommit,
		shortQuotedSplitStringCommandCommit,
		longSeparatedSplitStringCombinedCommit,
		longAttachedSplitStringCombinedCommit,
		longQuotedSplitStringCombinedCommit,
		shortQuotedSplitStringWrappedCommit,
		shortQuotedSplitStringWrappedCommitWithTerminator,
		longQuotedSplitStringWrappedCommit,
		optionTerminatedSplitStringCommit,
		optionTerminatedSplitStringWrappedCommit,
		'env -x git commit -m "ship it"',
		unattributedUnsupportedEnvWrappedInlineMessage,
		`bash -lc 'git commit -m "ship it"'`,
		`bash -lc -- 'git commit -m "ship it"'`,
		`sh -c 'git commit -m "ship it"'`,
		`sh -c -- 'git commit -m "ship it"'`,
		`bash -o pipefail -lc 'git commit -m "ship it"'`,
		`bash -o pipefail -lc -- 'git commit -m "ship it"'`,
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard blocks qualified git commit paths", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const unattributedQualifiedGitCommit = '/usr/bin/git commit -m "ship it"';
	const unattributedEnvWrappedQualifiedGitCommit = 'env FOO=bar /usr/bin/git commit -m "ship it"';
	const attributedQualifiedGitCommit = `/usr/bin/git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvWrappedQualifiedGitCommit = `env FOO=bar /usr/bin/git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

	for (const command of [unattributedQualifiedGitCommit, unattributedEnvWrappedQualifiedGitCommit]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
	for (const command of [attributedQualifiedGitCommit, attributedEnvWrappedQualifiedGitCommit]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard consumes separated message values before pathspec parsing", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const separatedShortMessageValue = "git commit -m --";
	const separatedLongMessageValue = "git commit --message --";
	const separatedShortMessageValueWithFooter = `git commit -m -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const separatedLongMessageValueWithFooter = `git commit --message -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const separatedShortMessageValueWithPathspecTerminator = `git commit -m -- -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const separatedLongMessageValueWithPathspecTerminator = `git commit --message -- -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

	for (const command of [separatedShortMessageValue, separatedLongMessageValue, separatedShortMessageValueWithPathspecTerminator, separatedLongMessageValueWithPathspecTerminator]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
	for (const command of [separatedShortMessageValueWithFooter, separatedLongMessageValueWithFooter]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
	}
	for (const command of [
		separatedShortMessageValue,
		separatedLongMessageValue,
		separatedShortMessageValueWithFooter,
		separatedLongMessageValueWithFooter,
		separatedShortMessageValueWithPathspecTerminator,
		separatedLongMessageValueWithPathspecTerminator,
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard ignores commit-message/file lookalikes after a pathspec terminator", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const attributedPathspecCommit = `git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}" -- README.md`;
	const misattributedPathspecMessage = `git commit -m subject -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const pathspecMessageLookalike = `git commit -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const pathspecFileLookalike = `git commit -- -F <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;

	assert.match(getTlhGitCommitAttributionBlockReason(misattributedPathspecMessage, enabled) ?? "", /missing the required TLH attribution footer/);
	for (const command of [attributedPathspecCommit, 'git commit -- README.md', pathspecMessageLookalike, pathspecFileLookalike]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
	}
	for (const command of [misattributedPathspecMessage, pathspecMessageLookalike, pathspecFileLookalike]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard preserves heredoc context through shell wrapper recursion", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const attributedWrappedHereDoc = `bash -lc 'git commit -F -' <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}
EOF`;
	const unattributedWrappedHereDoc = `bash -lc 'git commit -F -' <<'EOF'
subject
EOF`;
	const attributedEnvSplitWrappedHereDoc = `env -S'bash -lc' 'git commit -F -' <<'EOF'
subject

${TLH_DEFAULT_COMMIT_ATTRIBUTION}
EOF`;
	const unattributedEnvSplitWrappedHereDoc = `env -S'bash -lc' 'git commit -F -' <<'EOF'
subject
EOF`;

	assert.equal(getTlhGitCommitAttributionBlockReason(attributedWrappedHereDoc, enabled), undefined);
	assert.match(getTlhGitCommitAttributionBlockReason(unattributedWrappedHereDoc, enabled) ?? "", /missing the required TLH attribution footer/);
	assert.equal(getTlhGitCommitAttributionBlockReason(attributedEnvSplitWrappedHereDoc, enabled), undefined);
	assert.match(getTlhGitCommitAttributionBlockReason(unattributedEnvSplitWrappedHereDoc, enabled) ?? "", /missing the required TLH attribution footer/);
	assert.equal(getTlhGitCommitAttributionBlockReason(unattributedWrappedHereDoc, disabled), undefined);
	assert.equal(getTlhGitCommitAttributionBlockReason(unattributedEnvSplitWrappedHereDoc, disabled), undefined);
});

test("git commit attribution guard treats env unknown-option tails with consumed terminators as attribution-aware", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const attributedInlineCommand = `env -x -- git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedWrappedCommand = `env -x -- bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const misattributedInlineCommand = `env -x -- git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nextra"`;

	for (const command of [
		'env -x -- git commit -m "ship it"',
		`env -x -- bash -lc 'git commit -m "ship it"'`,
		misattributedInlineCommand,
	]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
	for (const command of [attributedInlineCommand, attributedWrappedCommand, 'env -x -- printf ok']) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
	}
	for (const command of ['env -x -- git commit -m "ship it"', `env -x -- bash -lc 'git commit -m "ship it"'`]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard reapplies env parsing after split-string expansion", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const attributedSplitStringUnsetCommand = `env --split-string -u FOO git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedAttachedSplitStringUnsetCommand = `env --split-string='-u FOO git commit' -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedSplitStringWrappedCommand = `env -S '-P /usr/bin bash -lc' 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedSplitStringGitCommand = `env -S '-P /usr/bin git' commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

	for (const command of [
		'env --split-string -u FOO git commit -m "ship it"',
		`env --split-string='-u FOO git commit' -m "ship it"`,
		`env -S '-P /usr/bin bash -lc' 'git commit -m "ship it"'`,
		`env -S '-P /usr/bin git' commit -m "ship it"`,
	]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
	for (const command of [
		attributedSplitStringUnsetCommand,
		attributedAttachedSplitStringUnsetCommand,
		attributedSplitStringWrappedCommand,
		attributedSplitStringGitCommand,
		'env --split-string -u FOO printf ok',
		`env -S '-P /usr/bin bash -lc' 'printf ok'`,
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
	}
	for (const command of [
		'env --split-string -u FOO git commit -m "ship it"',
		`env --split-string='-u FOO git commit' -m "ship it"`,
		`env -S '-P /usr/bin bash -lc' 'git commit -m "ship it"'`,
		`env -S '-P /usr/bin git' commit -m "ship it"`,
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard allows supported env split-string pathspec lookalikes while still blocking real inline options", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const pathspecLookalikes = [
		`env -S 'git commit -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`,
		`env -S 'git commit -- README.md'`,
		`env -S 'git commit' -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`,
	];
	const blockedInlineCommands = [
		`env -S 'git commit' -m "ship it"`,
		`env --split-string='git commit' -F - <<EOF\nship it\nEOF`,
	];
	const attributedInlineCommands = [
		`env -S 'git commit' -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`,
		`env --split-string='git commit' -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`,
	];

	for (const command of blockedInlineCommands) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
	for (const command of [...pathspecLookalikes, ...attributedInlineCommands]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
	}
	for (const command of [...blockedInlineCommands, ...pathspecLookalikes, ...attributedInlineCommands]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard parses bash plus options and env short-option clusters before split-string payloads", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const misattributedShellPlusOptionWrappedCommand = `bash +o pipefail -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nextra"'`;
	const attributedShellPlusOptionWrappedCommand = `bash +o pipefail -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellPlusShoptWrappedCommand = `bash +O extglob -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellSimplePlusOptionWrappedCommand = `bash +e -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const attributedShellTracePlusOptionWrappedCommand = `bash +x -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
	const misattributedEnvShortClusterSplitStringCommand = `env -iSgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nextra"`;
	const attributedEnvShortClusterSplitStringCommand = `env -iSgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvVerboseShortClusterSplitStringCommand = `env -ivSgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvAttachedChdirSplitStringCommand = `env -C/tmp -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvAttachedUnsetSplitStringCommand = `env -uFOO -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvShortClusterUnsetSplitStringCommand = `env -iuFOO -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

	for (const command of [
		`bash +o pipefail -lc 'git commit -m "ship it"'`,
		`bash +O extglob -lc 'git commit -m "ship it"'`,
		`bash +e -lc 'git commit -m "ship it"'`,
		`bash +x -lc 'git commit -m "ship it"'`,
		misattributedShellPlusOptionWrappedCommand,
		'env -iSgit commit -m "ship it"',
		misattributedEnvShortClusterSplitStringCommand,
		'env -ivSgit commit -m "ship it"',
		'env -C/tmp -Sgit commit -m "ship it"',
		'env -uFOO -Sgit commit -m "ship it"',
		'env -iuFOO -Sgit commit -m "ship it"',
	]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
	for (const command of [
		attributedShellPlusOptionWrappedCommand,
		attributedShellPlusShoptWrappedCommand,
		attributedShellSimplePlusOptionWrappedCommand,
		attributedShellTracePlusOptionWrappedCommand,
		attributedEnvShortClusterSplitStringCommand,
		attributedEnvVerboseShortClusterSplitStringCommand,
		attributedEnvAttachedChdirSplitStringCommand,
		attributedEnvAttachedUnsetSplitStringCommand,
		attributedEnvShortClusterUnsetSplitStringCommand,
		'env -iSprintf ok',
		'env -ivSprintf ok',
		`bash +o pipefail -lc 'printf ok'`,
		`bash +O extglob -lc 'printf ok'`,
		`bash +e -lc 'printf ok'`,
		`bash +x -lc 'printf ok'`,
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
	}
	for (const command of [
		`bash +o pipefail -lc 'git commit -m "ship it"'`,
		`bash +O extglob -lc 'git commit -m "ship it"'`,
		`bash +e -lc 'git commit -m "ship it"'`,
		`bash +x -lc 'git commit -m "ship it"'`,
		'env -iSgit commit -m "ship it"',
		'env -ivSgit commit -m "ship it"',
		'env -C/tmp -Sgit commit -m "ship it"',
		'env -uFOO -Sgit commit -m "ship it"',
		'env -iuFOO -Sgit commit -m "ship it"',
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard parses env argv0 value options across separated, attached, and clustered forms", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const attributedEnvArgv0SeparatedCommand = `env -a name git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvArgv0AttachedCommand = `env -aname git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvLongArgv0SeparatedCommand = `env --argv0 name git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvLongArgv0AttachedCommand = `env --argv0=name git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
	const attributedEnvArgv0ClusteredSplitStringCommand = `env -iva name -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

	for (const command of [
		'env -a name git commit -m "ship it"',
		'env -aname git commit -m "ship it"',
		'env --argv0 name git commit -m "ship it"',
		'env --argv0=name git commit -m "ship it"',
		'env -iva name -Sgit commit -m "ship it"',
	]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
	for (const command of [
		attributedEnvArgv0SeparatedCommand,
		attributedEnvArgv0AttachedCommand,
		attributedEnvLongArgv0SeparatedCommand,
		attributedEnvLongArgv0AttachedCommand,
		attributedEnvArgv0ClusteredSplitStringCommand,
		'env -a name printf ok',
		'env --argv0 name printf ok',
		'env --argv0=name printf ok',
		'env -iva name -Sprintf ok',
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
	}
	for (const command of [
		'env -a name git commit -m "ship it"',
		'env -aname git commit -m "ship it"',
		'env --argv0 name git commit -m "ship it"',
		'env --argv0=name git commit -m "ship it"',
		'env -iva name -Sgit commit -m "ship it"',
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard inspects stdin here-docs through env unknown-option and split-string paths", () => {
	const enabled = resolveTlhCommitAttribution(undefined);
	const disabled = resolveTlhCommitAttribution({ commit: false });
	const attributedUnsupportedEnvHereDoc = `env -x -- git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;
	const attributedSplitStringHereDoc = `env -S 'git commit -F -' <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;

	for (const command of [
		'env -x -- git commit -F - <<EOF\nship it\nEOF',
		`env -S 'git commit -F -' <<EOF\nship it\nEOF`,
	]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
	for (const command of [attributedUnsupportedEnvHereDoc, attributedSplitStringHereDoc]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, enabled), undefined);
	}
	for (const command of [
		'env -x -- git commit -F - <<EOF\nship it\nEOF',
		`env -S 'git commit -F -' <<EOF\nship it\nEOF`,
	]) {
		assert.equal(getTlhGitCommitAttributionBlockReason(command, disabled), undefined);
	}
});

test("git commit attribution guard blocks process substitutions with top-level conditional operators", () => {
	const enabled = resolveTlhCommitAttribution(undefined);

	assert.match(
		getTlhGitCommitAttributionBlockReason(
			`git commit -F <(printf '%s' subject || printf '%s' "${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`,
			enabled,
		) ?? "",
		/missing the required TLH attribution footer/,
	);
});

test("git commit attribution guard blocks non-progress printf process substitutions", () => {
	const enabled = resolveTlhCommitAttribution(undefined);

	for (const command of [
		"git commit -F <(printf 'subject' extra)",
		"git commit -F <(printf '%%' extra)",
	]) {
		assert.match(getTlhGitCommitAttributionBlockReason(command, enabled) ?? "", /missing the required TLH attribution footer/);
	}
});

test("toggle attribution command accepts no arguments", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		assert.equal("getArgumentCompletions" in command, false);

		const { ctx, notifications } = createCommandContext(fixture.dir);
		await command.handler("extra", ctx);
		assert.deepEqual(notifications.at(-1), {
			message: "Usage: /toggle-tlh-git-attribution",
			type: "error",
		});
	});
});

test("toggle attribution command disables the default footer by writing false", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(written, { tlh: { attribution: { commit: false } } });
		assert.equal(readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-")).length, 0);

		const notice = notifications.at(-1);
		assert.equal(notice?.type, "info");
		assert.match(notice?.message ?? "", /Updated TLH commit attribution at /);
		assert.match(notice?.message ?? "", /TLH commit attribution is disabled\./);
		assert.doesNotMatch(notice?.message ?? "", /Backup:/);
	});
});

test("toggle attribution command re-enables by writing true and creating a backup", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	const initialSettings = `${JSON.stringify({ tlh: { attribution: { commit: false }, gnosis: { enabled: true } } }, null, 2)}\n`;
	writeFileSync(settingsPath, initialSettings);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(written, { tlh: { attribution: { commit: true }, gnosis: { enabled: true } } });
		assert.equal(readFileSync(settingsPath, "utf8").includes(TLH_DEFAULT_COMMIT_ATTRIBUTION), false);

		const backups = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.bak-"));
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);

		const notice = notifications.at(-1);
		assert.equal(notice?.type, "info");
		assert.match(notice?.message ?? "", /TLH commit attribution is enabled\./);
		assert.match(notice?.message ?? "", /Backup:/);
	});
});

test("toggle attribution command rewrites attribution settings to boolean-only commit state", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify({ tlh: { attribution: { commit: false, footer: "CUSTOM" }, gnosis: { enabled: true } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		const { ctx } = createCommandContext(fixture.dir);

		await command.handler("", ctx);

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(written, { tlh: { attribution: { commit: true }, gnosis: { enabled: true } } });
	});
});

test("toggle attribution command rejects non-boolean persisted values", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-attribution-test-", { test: t });
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify({ tlh: { attribution: { commit: "Signed-off-by: Custom <noreply@example.invalid>" } } }, null, 2)}\n`,
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const command = registeredToggleCommand();
		const { ctx, notifications } = createCommandContext(fixture.dir);

		await command.handler("", ctx);

		assert.deepEqual(notifications.at(-1), {
			message: "Could not update TLH commit attribution: settings field 'tlh.attribution.commit' must be a boolean if present",
			type: "error",
		});
	});
});
