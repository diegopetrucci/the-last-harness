/**
 * Tests for the shared MCP tool identity module (mcp-tools.ts).
 *
 * These tests cover:
 *  - getMcpToolKind: all three branches of the union rule (proxy, allowlist, source /mcp/i)
 *  - hasKnownPiMcpAdapterSource: allowlist matching including versioned variants
 *  - hasPersistedDirectMcpResultDetails: provenance recovery heuristic
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getMcpToolKind, hasKnownPiMcpAdapterSource, hasPersistedDirectMcpResultDetails, KNOWN_PI_MCP_ADAPTER_SOURCES } =
	await jiti.import("../extensions/the-last-harness/mcp-tools.ts");

// ---------------------------------------------------------------------------
// getMcpToolKind – union rule
// ---------------------------------------------------------------------------

test("getMcpToolKind returns 'proxy' for the canonical proxy tool name", () => {
	assert.equal(getMcpToolKind("mcp"), "proxy");
	assert.equal(getMcpToolKind("mcp", undefined), "proxy");
	assert.equal(getMcpToolKind("mcp", { sourceInfo: { source: "npm:some-adapter" } }), "proxy");
});

test("getMcpToolKind returns 'direct' when the source is in the allowlist (allowlist path)", () => {
	for (const source of KNOWN_PI_MCP_ADAPTER_SOURCES) {
		assert.equal(
			getMcpToolKind("some_tool", { sourceInfo: { source } }),
			"direct",
			`expected 'direct' for allowlisted source: ${source}`,
		);
	}
});

test("getMcpToolKind returns 'direct' for versioned allowlisted sources (allowlist path)", () => {
	assert.equal(getMcpToolKind("jira_search", { sourceInfo: { source: "npm:pi-mcp-adapter@2.10.1" } }), "direct");
	assert.equal(
		getMcpToolKind("jira_search", { sourceInfo: { source: "npm:@diegopetrucci/pi-mcp-adapter@1.0.0" } }),
		"direct",
	);
});

test("getMcpToolKind returns 'direct' when the source matches /mcp/i but is NOT in the allowlist (source-hint path)", () => {
	// Non-allowlisted adapter whose package name contains "mcp"
	assert.equal(getMcpToolKind("some_tool", { sourceInfo: { source: "npm:acme-mcp-adapter" } }), "direct");
	assert.equal(getMcpToolKind("some_tool", { sourceInfo: { source: "npm:MCP-bridge" } }), "direct");
	assert.equal(getMcpToolKind("some_tool", { sourceInfo: { source: "git:github.com/example/mcp-tools" } }), "direct");
});

test("getMcpToolKind returns undefined for non-MCP tools (no match)", () => {
	assert.equal(getMcpToolKind("bash"), undefined);
	assert.equal(getMcpToolKind("read"), undefined);
	assert.equal(getMcpToolKind("jiraSearch", { sourceInfo: { source: "npm:acme-helper" } }), undefined);
	assert.equal(getMcpToolKind("jiraSearch"), undefined);
});

test("getMcpToolKind does NOT classify by path alone – only source is checked for /mcp/i", () => {
	// Tool whose source is unrelated but path happens to mention 'mcp'
	assert.equal(
		getMcpToolKind("jiraSearch", {
			sourceInfo: { source: "npm:acme-helper", path: "extensions/mcp-utils/jira.mjs" },
		}),
		undefined,
		"path alone must not trigger MCP classification",
	);
});

test("getMcpToolKind returns undefined when sourceInfo is absent or incomplete", () => {
	assert.equal(getMcpToolKind("some_tool", { sourceInfo: undefined }), undefined);
	assert.equal(getMcpToolKind("some_tool", { sourceInfo: { source: undefined } }), undefined);
	assert.equal(getMcpToolKind("some_tool", {}), undefined);
});

// ---------------------------------------------------------------------------
// hasKnownPiMcpAdapterSource – allowlist matching
// ---------------------------------------------------------------------------

test("hasKnownPiMcpAdapterSource returns true for exact allowlisted sources", () => {
	for (const source of KNOWN_PI_MCP_ADAPTER_SOURCES) {
		assert.equal(hasKnownPiMcpAdapterSource(source), true, `expected true for: ${source}`);
	}
});

test("hasKnownPiMcpAdapterSource returns true for versioned allowlisted sources", () => {
	assert.equal(hasKnownPiMcpAdapterSource("npm:pi-mcp-adapter@2.10.1"), true);
	assert.equal(hasKnownPiMcpAdapterSource("npm:@diegopetrucci/pi-mcp-adapter@1.2.3"), true);
	assert.equal(hasKnownPiMcpAdapterSource("git:github.com/diegopetrucci/pi-mcp-adapter@abc123"), true);
});

test("hasKnownPiMcpAdapterSource returns false for non-allowlisted sources", () => {
	assert.equal(hasKnownPiMcpAdapterSource("npm:acme-helper"), false);
	assert.equal(hasKnownPiMcpAdapterSource("npm:acme-mcp-adapter"), false);
	assert.equal(hasKnownPiMcpAdapterSource("built-in"), false);
	assert.equal(hasKnownPiMcpAdapterSource(undefined), false);
	assert.equal(hasKnownPiMcpAdapterSource(null), false);
	assert.equal(hasKnownPiMcpAdapterSource(42), false);
});

test("hasKnownPiMcpAdapterSource rejects sources that only start with a prefix substring", () => {
	// "npm:pi-mcp-adapter-extra" should NOT match "npm:pi-mcp-adapter" because
	// hasKnownPiMcpAdapterSource checks startsWith("npm:pi-mcp-adapter@"), not prefix alone.
	assert.equal(hasKnownPiMcpAdapterSource("npm:pi-mcp-adapter-extra"), false);
});

// ---------------------------------------------------------------------------
// hasPersistedDirectMcpResultDetails – provenance recovery
// ---------------------------------------------------------------------------

test("hasPersistedDirectMcpResultDetails returns true for canonical direct tool names", () => {
	// Tool name matches candidate.tool directly
	assert.equal(hasPersistedDirectMcpResultDetails("search_issues", { server: "jira", tool: "search_issues" }), true);
	// Tool name matches <serverPrefix>_<tool>
	assert.equal(
		hasPersistedDirectMcpResultDetails("jira_search_issues", { server: "jira", tool: "search_issues" }),
		true,
	);
	// Tool name matches <shortPrefix>_<tool> (server with "-mcp" suffix stripped)
	assert.equal(
		hasPersistedDirectMcpResultDetails("jira_search_issues", { server: "jira-mcp", tool: "search_issues" }),
		true,
	);
});

test("hasPersistedDirectMcpResultDetails returns false when tool name does not match any variant", () => {
	// jiraSearch is not search_issues, jira_search_issues, or jira_mcp_search_issues
	assert.equal(hasPersistedDirectMcpResultDetails("jiraSearch", { server: "jira", tool: "search_issues" }), false);
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
