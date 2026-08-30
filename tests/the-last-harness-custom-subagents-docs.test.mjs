import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepoFile = (relativePath) => readFileSync(join(repoRoot, relativePath), "utf8");
const canonical = readRepoFile("docs/custom-subagents.md");
const compatibility = readRepoFile("docs/embedded-subagents.md");

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const assertContainsAll = (text, phrases, label) => {
  for (const phrase of phrases) {
    assert.match(text, new RegExp(escapeRegExp(phrase), "i"), `${label}: ${phrase}`);
  }
};

test("canonical custom-subagent documentation preserves the profile contract", () => {
  assertContainsAll(
    canonical,
    [
      "Profile-owned custom subagents",
      "~/.the-last-harness/agent/agents/**/*.md",
      "mkdir -p ~/.the-last-harness/agent/agents",
      "embedded.<slug>",
      'subagents.agentOverrides["embedded.<slug>"]',
      "last effective same-name profile definition",
      "does not require a flag change or `/reload`",
      "opaque resume and opaque steer",
      "issue #330",
      "Least-privilege starter",
      "Advanced full-tools developer-like starter",
      "Remove or roll back a custom agent",
    ],
    "profile contract",
  );

  assertContainsAll(
    canonical,
    [
      "~/.the-last-harness/agent/agents/repo-helper.md",
      "Use embedded.repo-helper",
      "Project-scoped `.pi/agents/**/*.md` files are **not** a supported path",
    ],
    "profile examples and scope",
  );
});

test("canonical custom-subagent documentation covers the project contract", () => {
  assertContainsAll(
    canonical,
    [
      "Project-owned custom subagents",
      ".tlh/agents/<slug>.md",
      "strict YAML-style frontmatter",
      "package: embedded",
      "tools",
      "Project trust and session approval",
      "Profile/project precedence and tombstones",
      "immutable project snapshot",
      "genuine new session",
      "deny-only signal",
      "subagentOnlyExtensions",
      "live inputs",
      "natural-language requests",
      "prompt policy",
      "Project security boundaries",
      "Project troubleshooting",
      "Project agents are intentionally absent from management `list`/`get`",
      "Remove or undo a project custom agent",
    ],
    "project contract",
  );

  assertContainsAll(
    canonical,
    [
      ".tlh/agents/reviewer.md",
      "Ask the reviewer project subagent",
      "requires** user-scope execution",
      "/reload` or a new session is required",
      "process-private",
    ],
    "project examples and controls",
  );
});

test("project effective settings and tombstone boundaries are documented", () => {
  assertContainsAll(
    canonical,
    [
      "subagents.defaultModel",
      'subagents.agentOverrides["embedded.<slug>"]',
      "fills an omitted project `model`",
      "fill other project fields omitted from frontmatter",
      "Explicit project frontmatter wins per field",
      "valid project agents must explicitly declare `tools`",
      "cannot broaden project tools",
      "`disabled: true` profile override creates the documented project tombstone",
      "removes the same-name profile fallback for that snapshot",
      "Repository/project-scope `.pi/settings.json` overrides are deliberately ignored",
      "Overrides neither authorize project content nor make project paths discoverable",
    ],
    "project effective settings",
  );
});

test("unsupported project-agent paths are explicitly negative, not supportive", () => {
  assert.match(canonical, /Project-scoped .*\.pi\/agents.*\*\*not\*\* a supported path/i);
  assert.doesNotMatch(
    canonical,
    /\.pi\/agents[^\n.]*\b(?:is|are)\s+(?!\*\*not\*\*|not\b)[^\n.]*\b(?:supported|authorized)\b/i,
  );
});

test("the compatibility guide points to both source contracts without duplicating them", () => {
  assert.match(compatibility, /canonical guide is \[docs\/custom-subagents\.md\]/i);
  assert.match(compatibility, /active-profile `embedded\.<slug>`/i);
  assert.match(compatibility, /project-owned `\.tlh\/agents\/<slug>\.md`/i);
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
