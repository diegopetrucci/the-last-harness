/**
 * Tests for the shared native MCP / codemode tool identity module (mcp-tools.ts).
 *
 * Real Pi 1.5.0 values: MCP server tools are named `mcp__<server>__<tool>`, the resource tools and
 * the MCP extension use sourceInfo.path `builtin:mcp`, codemode uses `builtin:codemode`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getMcpToolKind, readNestedToolCalls } = await jiti.import(
  "../extensions/the-last-harness/mcp-tools.ts",
);

const builtin = (name) => ({
  sourceInfo: {
    path: `builtin:${name}`,
    source: "builtin",
    scope: "temporary",
    origin: "top-level",
  },
});

test("getMcpToolKind classifies mcp__<server>__<tool> names as mcp", () => {
  assert.equal(getMcpToolKind("mcp__docs__search"), "mcp");
  assert.equal(getMcpToolKind("mcp__dev_radius__search", builtin("mcp")), "mcp");
});

test("getMcpToolKind classifies builtin:mcp resource tools as mcp by source path", () => {
  for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
    assert.equal(getMcpToolKind(name, builtin("mcp")), "mcp", name);
  }
});

test("getMcpToolKind classifies the native codemode tool", () => {
  assert.equal(getMcpToolKind("codemode"), "codemode");
  assert.equal(getMcpToolKind("codemode", builtin("codemode")), "codemode");
});

test("getMcpToolKind does not treat a replacement codemode extension as the built-in", () => {
  assert.equal(
    getMcpToolKind("codemode", {
      sourceInfo: { path: "/ext/codemode.ts", source: "local", scope: "user", origin: "top-level" },
    }),
    undefined,
  );
});

test("getMcpToolKind has no adapter-era classification", () => {
  // The legacy adapter proxy tool name and npm/git /mcp/ sources are no longer MCP evidence.
  assert.equal(getMcpToolKind("mcp"), undefined);
  assert.equal(
    getMcpToolKind("some_tool", {
      sourceInfo: { path: "/x", source: "npm:pi-mcp-adapter", scope: "user", origin: "package" },
    }),
    undefined,
  );
  assert.equal(
    getMcpToolKind("jira_search", {
      sourceInfo: { path: "/x/mcp-utils", source: "git:github.com/example/mcp-tools" },
    }),
    undefined,
  );
});

test("getMcpToolKind returns undefined for ordinary tools", () => {
  assert.equal(getMcpToolKind("bash"), undefined);
  assert.equal(getMcpToolKind("read", builtin("read")), undefined);
  assert.equal(getMcpToolKind("tool_search", builtin("tool-search")), undefined);
});

test("readNestedToolCalls reads Pi's { calls } record and skips malformed entries", () => {
  assert.deepEqual(
    readNestedToolCalls({
      nestedCalls: {
        complete: true,
        calls: [
          { id: "p/1", name: "mcp__docs__search", status: "ok" },
          { id: 3 },
          null,
          { name: "read" },
        ],
      },
    }),
    [{ id: "p/1", name: "mcp__docs__search" }, { name: "read" }],
  );
  assert.deepEqual(readNestedToolCalls({}), []);
  assert.deepEqual(readNestedToolCalls(undefined), []);
});
