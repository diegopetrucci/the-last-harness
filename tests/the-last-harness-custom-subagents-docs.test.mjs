import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepoFile = (relativePath) => readFileSync(join(repoRoot, relativePath), "utf8");
const canonical = readRepoFile("docs/custom-subagents.md");
const compatibility = readRepoFile("docs/embedded-subagents.md");
const projectAgentLoader = readRepoFile("extensions/subagents/src/agents/project-agent-loader.ts");

const BUILTIN_APPEND_FILENAMES = [
  ".tlh/agents/builtin/ARCHITECT_PROMPT_APPEND.md",
  ".tlh/agents/builtin/RUSH_PROMPT_APPEND.md",
  ".tlh/agents/builtin/PRODUCT_PROMPT_APPEND.md",
  ".tlh/agents/builtin/BUG-HUNTER_PROMPT_APPEND.md",
  ".tlh/agents/builtin/DEVELOPER_PROMPT_APPEND.md",
  ".tlh/agents/builtin/CODE-REVIEWER_PROMPT_APPEND.md",
  ".tlh/agents/builtin/REPO-SCOUT_PROMPT_APPEND.md",
  ".tlh/agents/builtin/DIFF-SUMMARIZER_PROMPT_APPEND.md",
  ".tlh/agents/builtin/LIBRARIAN_PROMPT_APPEND.md",
  ".tlh/agents/builtin/WEB-SCOUT_PROMPT_APPEND.md",
  ".tlh/agents/builtin/ORACLE_PROMPT_APPEND.md",
  ".tlh/agents/builtin/CONTRARIAN_PROMPT_APPEND.md",
];

const DOCUMENTATION_CONTRACT_PATHS = [
  "README.md",
  "CHANGELOG.md",
  "docs/commands.md",
  "docs/custom-subagents.md",
  "docs/embedded-subagents.md",
  "docs/install.md",
  "docs/models.md",
  "docs/subagents.md",
  "docs/telemetry.md",
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const assertContainsAll = (text, phrases, label) => {
  for (const phrase of phrases) {
    assert.match(text, new RegExp(escapeRegExp(phrase), "i"), `${label}: ${phrase}`);
  }
};

test("canonical custom-subagent documentation preserves the exact project contract", () => {
  assertContainsAll(
    canonical,
    [
      "Project custom subagents",
      "<git-worktree-root>/.tlh/agents/custom/<UPPERCASE-SLUG>.md",
      "validated Git worktree root",
      "directly inside `.tlh/agents/custom`",
      "nested directories are not searched",
      "Lowercase/case variants of a filename or directory are not alternate spellings",
      "outside a validated Git worktree has no project custom agents",
      "package: embedded",
      "exact lowercase `name`",
      "explicit usable `tools` list",
      "Project custom definitions **must not declare** `extensions` or `subagentOnlyExtensions`",
      "No settings or default overrides except deny-only disable",
      "**persisted** positive project-trust decision",
      "session-only decision is not authorization",
      "Only `architect` and `disabled` may **initiate**",
      "Their opaque controls remain available only for eligible non-project runs",
      "Only `architect` may `resume` or `steer` a retained or persisted project-agent run",
      "blocked for every other primary, including `disabled`",
      "same-process `resume` and `steer` reauthorize current persisted project trust",
      "revoking persisted project trust blocks those controls",
      '`agentScope: "project"`',
      '`context: "fresh"`',
      "same validated Git root",
      "new-process resume",
      "same-process resume",
      "process-restarted resume/revival",
      "resume from a genuine new session fails closed",
      "snapshot-capability checks",
      "project custom-agent inventory is captured at session start or `/reload`",
      "takes effect only after `/reload` or a new session",
      "active generation or a live child",
    ],
    "project contract",
  );
});

test("canonical custom-subagent documentation covers all exact built-in guidance files", () => {
  assertContainsAll(
    canonical,
    [
      ...BUILTIN_APPEND_FILENAMES,
      "nearest exact file",
      "outside Git it checks only the current cwd",
      "non-recursive",
      "old builtin append convention `.tlh/<ROLE>.md`",
      "never read as a fallback",
      "one of the twelve packaged TLH roles only",
    ],
    "built-in guidance contract",
  );
});

test("project-agent file-size boundary is authoritative and documented", () => {
  assert.match(projectAgentLoader, /export const MAX_PROJECT_AGENT_FILE_BYTES = 64 \* 1024;/);
  assert.match(canonical, /maximum \*\*64 KiB \(65,536 UTF-8 bytes\)\*\*/i);
});

test("project settings and deny-only tombstone boundaries are documented", () => {
  assertContainsAll(
    canonical,
    [
      "subagents.defaultModel",
      'subagents.agentOverrides["embedded.<slug>"]',
      "model, effort, prompt, tool, or other fields in active-profile `subagents.agentOverrides`",
      "every project-setting default or `subagents.agentOverrides` field",
      'exact active-profile entry such as `subagents.agentOverrides["embedded.<slug>"].disabled: true`',
      "deny-only tombstone",
      "never modifies the project agent or creates a replacement",
      "`disabled: false` and all other fields are inert",
      "project-settings `disabled` entry is also inert",
      "Removing the root definition remains the repository-owned way to remove it",
      "explicit model, output, or other option supplied on the individual `subagent` dispatch",
      "explicit caller model wins on OpenRouter too",
    ],
    "project effective settings",
  );
});

test("unsupported project-agent paths are explicitly negative, not supportive", () => {
  assertContainsAll(
    canonical,
    [
      "active-profile definitions under `<agent-dir>/agents/**`",
      "global `~/.agents` definitions",
      "project `.pi/agents/**` or `.agents/**` definitions",
      "paths listed in `subagents.agentDirs`",
      "definitions supplied by installed packages or other extra directories",
      "no longer appear in TLH's custom-agent `list`/`get` output",
    ],
    "removed custom-agent sources",
  );
  assert.doesNotMatch(canonical, /\.tlh\/agents\/<slug>\.md/i);
  assert.doesNotMatch(canonical, /\.tlh\/agents\/\*\*\/\*\.md/i);
  assert.doesNotMatch(canonical, /session approval/i);
});

test("ticket-named documentation uses the reconciled project trust and layout contract", () => {
  for (const relativePath of DOCUMENTATION_CONTRACT_PATHS) {
    const text = readRepoFile(relativePath);
    assert.doesNotMatch(text, /session approval/i, `${relativePath}: stale session approval`);
    assert.doesNotMatch(
      text,
      /\.tlh\/agents\/(?:<slug>|\*\*\/\*\.md)/i,
      `${relativePath}: stale recursive or lowercase project layout`,
    );
    assert.doesNotMatch(
      text,
      /(?:bounded descendants|descendant directories)/i,
      `${relativePath}: stale recursive project-agent wording`,
    );
    assert.doesNotMatch(
      text,
      /authorization inventory is evaluated on every new embedded delegation attempt/i,
      `${relativePath}: stale per-delegation project snapshot wording`,
    );
    assert.doesNotMatch(
      text,
      /\bcan still control\b/i,
      `${relativePath}: stale project-agent control exception`,
    );
    assert.doesNotMatch(
      text,
      /(?:issue #330|docs\/embedded-subagents\.md)/i,
      `${relativePath}: dangling legacy issue/documentation pointer`,
    );
  }
});

test("the compatibility guide points to the canonical project contract without duplicating it", () => {
  assert.match(compatibility, /canonical guide is \[docs\/custom-subagents\.md\]/i);
  assert.match(
    compatibility,
    /exact project-owned `\.tlh\/agents\/custom\/<UPPERCASE-SLUG>\.md` contract/i,
  );
  assert.match(compatibility, /authorization, trust, lifecycle, controls, troubleshooting/i);
  assert.doesNotMatch(compatibility, /frontmatter|tombstone|resume|```/i);
});

test("user-facing links point to the canonical custom-subagent guide", () => {
  for (const relativePath of [
    "README.md",
    "docs/subagents.md",
    "docs/commands.md",
    "CHANGELOG.md",
  ]) {
    assert.match(readRepoFile(relativePath), /docs\/custom-subagents\.md|\[custom-subagents\.md\]/);
  }
});

test("the published package contract includes both public custom-subagent docs", () => {
  const packageJson = JSON.parse(readRepoFile("package.json"));
  assert.ok(packageJson.files.includes("docs"), "package.json must publish the docs directory");
  const packageCheck = readRepoFile("scripts/check-package-contents.mjs");
  assert.match(packageCheck, /"docs\/custom-subagents\.md"/);
  assert.match(packageCheck, /"docs\/embedded-subagents\.md"/);
});
