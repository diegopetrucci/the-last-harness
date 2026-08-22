import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  TLH_DEFAULT_COMMIT_ATTRIBUTION,
  createToolCallContext,
  registerRuntimeHarness,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

test("tool_call blocks obvious unattributed bash git commits only when attribution is enabled", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const attributedHereDoc = `git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;
  const wrappedAttributedHereDoc = `if true; then git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF\nfi`;
  const attributedWrappedInlineMessage = `bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
  const attributedWrappedInlineMessageWithTerminator = `bash -lc -- 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
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
  const optionTerminatedSplitStringNoCommit = "env -S -- printf ok";
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

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    for (const command of [
      'git commit -m "ship it"',
      'git -C repo commit -m "ship it"',
      "git commit -F-",
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
      unattributedProcessSubstitution,
      unattributedPrintfFormatProcessSubstitution,
      unattributedPrintfArgsProcessSubstitution,
      unattributedHereDocProcessSubstitution,
      unattributedTrailingOutputProcessSubstitution,
      unattributedWrongFileProcessSubstitution,
      unattributedLastFileProcessSubstitution,
      `git commit -m "subject\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`,
    ]) {
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    }
    assert.equal(
      await toolCall(
        {
          toolName: "bash",
          input: { command: `git commit -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"` },
        },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedHereDoc } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedWrappedInlineMessage } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedWrappedInlineMessageWithTerminator } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedEnvInlineMessage } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedQualifiedEnvInlineMessage } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedUnsetEnvInlineMessage } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedPathEnvInlineMessage } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedUnsupportedEnvInlineMessage } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedUnsupportedEnvWrappedInlineMessage } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedSplitStringCombinedCommit } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedLongSeparatedSplitStringCombinedCommit } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedLongQuotedSplitStringCombinedCommit } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedShortQuotedSplitStringWrappedCommit } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        {
          toolName: "bash",
          input: { command: attributedShortQuotedSplitStringWrappedCommitWithTerminator },
        },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedLongQuotedSplitStringWrappedCommit } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedOptionTerminatedSplitStringCommit } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        {
          toolName: "bash",
          input: { command: attributedOptionTerminatedSplitStringWrappedCommit },
        },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedShellOptionWrappedInlineMessage } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        {
          toolName: "bash",
          input: { command: attributedShellOptionWrappedInlineMessageWithTerminator },
        },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: wrappedAttributedHereDoc } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedProcessSubstitution } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedPrintfEscapedNewlineProcessSubstitution } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedEchoProcessSubstitution } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedHereDocProcessSubstitution } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: attributedLastFileProcessSubstitution } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    const mixedCommits = await toolCall(
      { toolName: "bash", input: { command: `${attributedHereDoc}\ngit commit -m "ship it"` } },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.equal(mixedCommits?.block, true);
    assert.match(mixedCommits?.reason ?? "", /TLH attribution footer/);
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: "git commit -F .git/COMMIT_EDITMSG" } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
    for (const command of [
      "env -P /usr/bin printf ok",
      `env -S 'printf ok'`,
      attachedSplitStringNoCommit,
      optionTerminatedSplitStringNoCommit,
      optionTerminatedSplitStringWrappedNoCommit,
      wrappedNoCommitWithTerminator,
      splitWrappedNoCommitWithTerminator,
      "env -x printf ok",
      unsupportedEnvWrappedNoCommit,
      `sh -c -- 'printf ok'`,
      `bash -o pipefail -lc 'printf ok'`,
      `bash -o pipefail -lc -- 'printf ok'`,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    for (const command of [
      'if true; then git commit -m "ship it"; fi',
      'if git commit -m "ship it"; then echo done; fi',
      'command git commit -m "ship it"',
      'FOO=bar git commit -m "ship it"',
      'env FOO=bar git commit -m "ship it"',
      '/usr/bin/env FOO=bar git commit -m "ship it"',
      'env --unset=FOO git commit -m "ship it"',
      'env -P /usr/bin git commit -m "ship it"',
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
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call consumes separated message values before pathspec parsing", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const separatedShortMessageValue = "git commit -m --";
  const separatedLongMessageValue = "git commit --message --";
  const separatedShortMessageValueWithFooter = `git commit -m -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const separatedLongMessageValueWithFooter = `git commit --message -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const separatedShortMessageValueWithPathspecTerminator = `git commit -m -- -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const separatedLongMessageValueWithPathspecTerminator = `git commit --message -- -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    for (const command of [
      separatedShortMessageValue,
      separatedLongMessageValue,
      separatedShortMessageValueWithPathspecTerminator,
      separatedLongMessageValueWithPathspecTerminator,
    ]) {
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    }
    for (const command of [
      separatedShortMessageValueWithFooter,
      separatedLongMessageValueWithFooter,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    for (const command of [
      separatedShortMessageValue,
      separatedLongMessageValue,
      separatedShortMessageValueWithFooter,
      separatedLongMessageValueWithFooter,
      separatedShortMessageValueWithPathspecTerminator,
      separatedLongMessageValueWithPathspecTerminator,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call ignores commit-message/file lookalikes after a pathspec terminator", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const attributedPathspecCommit = `git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}" -- README.md`;
  const misattributedPathspecMessage = `git commit -m subject -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const pathspecMessageLookalike = `git commit -- -m "${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const pathspecFileLookalike = `git commit -- -F <(printf '%s' "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`;

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    const blocked = await toolCall(
      { toolName: "bash", input: { command: misattributedPathspecMessage } },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    for (const command of [
      attributedPathspecCommit,
      "git commit -- README.md",
      pathspecMessageLookalike,
      pathspecFileLookalike,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    for (const command of [
      misattributedPathspecMessage,
      pathspecMessageLookalike,
      pathspecFileLookalike,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call preserves heredoc context through shell wrapper recursion", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
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

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    for (const command of [attributedWrappedHereDoc, attributedEnvSplitWrappedHereDoc]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
    for (const command of [unattributedWrappedHereDoc, unattributedEnvSplitWrappedHereDoc]) {
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    for (const command of [unattributedWrappedHereDoc, unattributedEnvSplitWrappedHereDoc]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call treats env unknown-option tails with consumed terminators as attribution-aware", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const attributedInlineCommand = `env -x -- git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const attributedWrappedCommand = `env -x -- bash -lc 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
  const misattributedInlineCommand = `env -x -- git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\n\nextra"`;

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    for (const command of [
      'env -x -- git commit -m "ship it"',
      `env -x -- bash -lc 'git commit -m "ship it"'`,
      misattributedInlineCommand,
    ]) {
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    }
    for (const command of [
      attributedInlineCommand,
      attributedWrappedCommand,
      "env -x -- printf ok",
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    for (const command of [
      'env -x -- git commit -m "ship it"',
      `env -x -- bash -lc 'git commit -m "ship it"'`,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call reapplies env parsing after split-string expansion", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const attributedSplitStringUnsetCommand = `env --split-string -u FOO git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const attributedAttachedSplitStringUnsetCommand = `env --split-string='-u FOO git commit' -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const attributedSplitStringWrappedCommand = `env -S '-P /usr/bin bash -lc' 'git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"'`;
  const attributedSplitStringGitCommand = `env -S '-P /usr/bin git' commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    for (const command of [
      'env --split-string -u FOO git commit -m "ship it"',
      `env --split-string='-u FOO git commit' -m "ship it"`,
      `env -S '-P /usr/bin bash -lc' 'git commit -m "ship it"'`,
      `env -S '-P /usr/bin git' commit -m "ship it"`,
    ]) {
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    }
    for (const command of [
      attributedSplitStringUnsetCommand,
      attributedAttachedSplitStringUnsetCommand,
      attributedSplitStringWrappedCommand,
      attributedSplitStringGitCommand,
      "env --split-string -u FOO printf ok",
      `env -S '-P /usr/bin bash -lc' 'printf ok'`,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    for (const command of [
      'env --split-string -u FOO git commit -m "ship it"',
      `env --split-string='-u FOO git commit' -m "ship it"`,
      `env -S '-P /usr/bin bash -lc' 'git commit -m "ship it"'`,
      `env -S '-P /usr/bin git' commit -m "ship it"`,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call allows supported env split-string pathspec lookalikes while still blocking real inline options", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
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

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    for (const command of blockedInlineCommands) {
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    }
    for (const command of [...pathspecLookalikes, ...attributedInlineCommands]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    for (const command of [
      ...blockedInlineCommands,
      ...pathspecLookalikes,
      ...attributedInlineCommands,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call parses bash plus options and env short-option clusters before split-string payloads", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
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

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
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
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
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
      "env -iSprintf ok",
      "env -ivSprintf ok",
      `bash +o pipefail -lc 'printf ok'`,
      `bash +O extglob -lc 'printf ok'`,
      `bash +e -lc 'printf ok'`,
      `bash +x -lc 'printf ok'`,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
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
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call parses env argv0 value options across separated, attached, and clustered forms", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const attributedEnvArgv0SeparatedCommand = `env -a name git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const attributedEnvArgv0AttachedCommand = `env -aname git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const attributedEnvLongArgv0SeparatedCommand = `env --argv0 name git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const attributedEnvLongArgv0AttachedCommand = `env --argv0=name git commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;
  const attributedEnvArgv0ClusteredSplitStringCommand = `env -iva name -Sgit commit -m "subject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}"`;

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    for (const command of [
      'env -a name git commit -m "ship it"',
      'env -aname git commit -m "ship it"',
      'env --argv0 name git commit -m "ship it"',
      'env --argv0=name git commit -m "ship it"',
      'env -iva name -Sgit commit -m "ship it"',
    ]) {
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    }
    for (const command of [
      attributedEnvArgv0SeparatedCommand,
      attributedEnvArgv0AttachedCommand,
      attributedEnvLongArgv0SeparatedCommand,
      attributedEnvLongArgv0AttachedCommand,
      attributedEnvArgv0ClusteredSplitStringCommand,
      "env -a name printf ok",
      "env --argv0 name printf ok",
      "env --argv0=name printf ok",
      "env -iva name -Sprintf ok",
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    for (const command of [
      'env -a name git commit -m "ship it"',
      'env -aname git commit -m "ship it"',
      'env --argv0 name git commit -m "ship it"',
      'env --argv0=name git commit -m "ship it"',
      'env -iva name -Sgit commit -m "ship it"',
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call inspects stdin here-docs through env unknown-option and split-string paths", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const attributedUnsupportedEnvHereDoc = `env -x -- git commit -F - <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;
  const attributedSplitStringHereDoc = `env -S 'git commit -F -' <<EOF\nsubject\n\n${TLH_DEFAULT_COMMIT_ATTRIBUTION}\nEOF`;

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    for (const command of [
      "env -x -- git commit -F - <<EOF\nship it\nEOF",
      `env -S 'git commit -F -' <<EOF\nship it\nEOF`,
    ]) {
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    }
    for (const command of [attributedUnsupportedEnvHereDoc, attributedSplitStringHereDoc]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    for (const command of [
      "env -x -- git commit -F - <<EOF\nship it\nEOF",
      `env -S 'git commit -F -' <<EOF\nship it\nEOF`,
    ]) {
      assert.equal(
        await toolCall(
          { toolName: "bash", input: { command } },
          createToolCallContext([], undefined, { cwd: fixture.cwd }),
        ),
        undefined,
      );
    }
  });
});

test("tool_call blocks process substitutions with top-level conditional operators", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    const blocked = await toolCall(
      {
        toolName: "bash",
        input: {
          command: `git commit -F <(printf '%s' subject || printf '%s' "${TLH_DEFAULT_COMMIT_ATTRIBUTION}")`,
        },
      },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /TLH attribution footer/);
  });
});

test("tool_call blocks non-progress printf process substitutions", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    for (const command of [
      "git commit -F <(printf 'subject' extra)",
      "git commit -F <(printf '%%' extra)",
    ]) {
      const blocked = await toolCall(
        { toolName: "bash", input: { command } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /TLH attribution footer/);
    }
  });
});
