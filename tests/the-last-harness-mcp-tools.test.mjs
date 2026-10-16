/**
 * Tests for the shared MCP tool identity module (mcp-tools.ts).
 *
 * These tests cover:
 *  - getMcpToolKind: proxy name, scheme-prefixed /mcp/i sources, and non-matches
 *  - hasPersistedDirectMcpResultDetails: provenance recovery heuristic
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getMcpToolKind, hasPersistedDirectMcpResultDetails } = await jiti.import(
  "../extensions/the-last-harness/mcp-tools.ts",
);

// ---------------------------------------------------------------------------
// getMcpToolKind
// ---------------------------------------------------------------------------

test("getMcpToolKind returns 'proxy' for the canonical proxy tool name", () => {
  assert.equal(getMcpToolKind("mcp"), "proxy");
  assert.equal(getMcpToolKind("mcp", undefined), "proxy");
  assert.equal(getMcpToolKind("mcp", { sourceInfo: { source: "npm:some-adapter" } }), "proxy");
});

test("getMcpToolKind returns 'direct' for historical pi-mcp-adapter sources", () => {
  const sources = [
    "npm:pi-mcp-adapter",
    "npm:@diegopetrucci/pi-mcp-adapter",
    "git:github.com/diegopetrucci/pi-mcp-adapter",
    "npm:pi-mcp-adapter@2.10.1",
    "npm:@diegopetrucci/pi-mcp-adapter@1.0.0",
    "git:github.com/diegopetrucci/pi-mcp-adapter@abc123",
  ];
  for (const source of sources) {
    assert.equal(
      getMcpToolKind("some_tool", { sourceInfo: { source } }),
      "direct",
      `expected 'direct' for historical source: ${source}`,
    );
  }
});

test("getMcpToolKind returns 'direct' when a scheme-prefixed source matches /mcp/i", () => {
  assert.equal(
    getMcpToolKind("some_tool", { sourceInfo: { source: "npm:acme-mcp-adapter" } }),
    "direct",
  );
  assert.equal(getMcpToolKind("some_tool", { sourceInfo: { source: "npm:MCP-bridge" } }), "direct");
  assert.equal(
    getMcpToolKind("some_tool", { sourceInfo: { source: "git:github.com/example/mcp-tools" } }),
    "direct",
  );
});

test("getMcpToolKind returns undefined for non-MCP tools (no match)", () => {
  assert.equal(getMcpToolKind("bash"), undefined);
  assert.equal(getMcpToolKind("read"), undefined);
  assert.equal(
    getMcpToolKind("jiraSearch", { sourceInfo: { source: "npm:acme-helper" } }),
    undefined,
  );
  assert.equal(getMcpToolKind("jiraSearch"), undefined);
});

test("getMcpToolKind does NOT classify by path alone – only scheme-prefixed source is checked for /mcp/i", () => {
  // Tool whose source is unrelated but path happens to mention 'mcp'
  assert.equal(
    getMcpToolKind("jiraSearch", {
      sourceInfo: { source: "npm:acme-helper", path: "extensions/mcp-utils/jira.mjs" },
    }),
    undefined,
    "path alone must not trigger MCP classification",
  );
});

test("getMcpToolKind does NOT classify an absolute local-package path containing 'mcp'", () => {
  // Pi sets sourceInfo.source to the absolute package root for locally-loaded packages.
  // Even if 'mcp' appears in the path, a bare filesystem path carries no MCP evidence.
  assert.equal(
    getMcpToolKind("some_tool", { sourceInfo: { source: "/work/mcp-experiments/general-tools" } }),
    undefined,
    "absolute local-package path containing mcp must not be classified",
  );
  assert.equal(
    getMcpToolKind("some_tool", { sourceInfo: { source: "/home/user/.local/share/mcp/adapter" } }),
    undefined,
    "absolute path with mcp segment must not be classified",
  );
});

test("getMcpToolKind does NOT classify the literal source 'local'", () => {
  // Pi sets sourceInfo.source to 'local' for loose top-level extensions.
  assert.equal(
    getMcpToolKind("some_tool", { sourceInfo: { source: "local" } }),
    undefined,
    "literal 'local' source must not be classified as MCP",
  );
});

test("getMcpToolKind returns 'direct' for npm: scheme source containing 'mcp' (package-identifier gate)", () => {
  assert.equal(
    getMcpToolKind("some_tool", { sourceInfo: { source: "npm:acme-mcp-adapter" } }),
    "direct",
  );
  assert.equal(
    getMcpToolKind("some_tool", { sourceInfo: { source: "npm:acme-mcp-adapter@1.2.3" } }),
    "direct",
  );
});

test("getMcpToolKind returns 'direct' for git: scheme source containing 'mcp' (package-identifier gate)", () => {
  assert.equal(
    getMcpToolKind("some_tool", { sourceInfo: { source: "git:github.com/example/mcp-tools" } }),
    "direct",
  );
});

test("getMcpToolKind returns undefined when sourceInfo is absent or incomplete", () => {
  assert.equal(getMcpToolKind("some_tool", { sourceInfo: undefined }), undefined);
  assert.equal(getMcpToolKind("some_tool", { sourceInfo: { source: undefined } }), undefined);
  assert.equal(getMcpToolKind("some_tool", {}), undefined);
});

// ---------------------------------------------------------------------------
// hasPersistedDirectMcpResultDetails – provenance recovery
// ---------------------------------------------------------------------------

test("hasPersistedDirectMcpResultDetails returns true for canonical direct tool names", () => {
  // Tool name matches candidate.tool directly
  assert.equal(
    hasPersistedDirectMcpResultDetails("search_issues", { server: "jira", tool: "search_issues" }),
    true,
  );
  // Tool name matches <serverPrefix>_<tool>
  assert.equal(
    hasPersistedDirectMcpResultDetails("jira_search_issues", {
      server: "jira",
      tool: "search_issues",
    }),
    true,
  );
  // Tool name matches <shortPrefix>_<tool> (server with "-mcp" suffix stripped)
  assert.equal(
    hasPersistedDirectMcpResultDetails("jira_search_issues", {
      server: "jira-mcp",
      tool: "search_issues",
    }),
    true,
  );
});

test("hasPersistedDirectMcpResultDetails returns false when tool name does not match any variant", () => {
  // jiraSearch is not search_issues, jira_search_issues, or jira_mcp_search_issues
  assert.equal(
    hasPersistedDirectMcpResultDetails("jiraSearch", { server: "jira", tool: "search_issues" }),
    false,
  );
});

test("hasPersistedDirectMcpResultDetails returns false for missing or incomplete details", () => {
  assert.equal(hasPersistedDirectMcpResultDetails("tool", null), false);
  assert.equal(hasPersistedDirectMcpResultDetails("tool", undefined), false);
  assert.equal(hasPersistedDirectMcpResultDetails("tool", {}), false);
  assert.equal(hasPersistedDirectMcpResultDetails("tool", { server: "jira" }), false); // missing tool
  assert.equal(hasPersistedDirectMcpResultDetails("tool", { tool: "search" }), false); // missing server
  assert.equal(hasPersistedDirectMcpResultDetails("tool", { server: "", tool: "search" }), false); // empty server
  assert.equal(hasPersistedDirectMcpResultDetails("tool", { server: "jira", tool: "" }), false); // empty tool
});
