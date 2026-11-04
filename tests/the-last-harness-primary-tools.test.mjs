import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrimaryToolState,
  filterAvailableTools,
  withDirectMcpTools,
} from "../extensions/the-last-harness-primary-tools.mjs";

test("primary tool state restores active tools from before primary tools were applied", () => {
  const availableTools = new Set(["bash", "edit", "find", "grep", "read"]);
  const primaryToolState = createPrimaryToolState();
  let activeTools = ["bash", "edit"];

  function applyPrimaryTools(desiredTools) {
    const validTools = filterAvailableTools(desiredTools, availableTools);
    if (validTools.length === 0) {
      return;
    }
    activeTools = primaryToolState.apply(validTools, activeTools);
  }

  function restorePrimaryTools() {
    const restoredTools = primaryToolState.restoreIfAppropriate(activeTools, availableTools);
    if (restoredTools) {
      activeTools = restoredTools;
    }
  }

  applyPrimaryTools(["read", "grep"]);
  assert.deepEqual(activeTools, ["read", "grep"]);

  applyPrimaryTools(["read", "find"]);
  assert.deepEqual(activeTools, ["read", "find"]);

  restorePrimaryTools();
  assert.deepEqual(activeTools, ["bash", "edit"]);
});

test("primary tool state does not overwrite active tools changed after primary application", () => {
  const availableTools = new Set(["bash", "edit", "grep", "read"]);
  const primaryToolState = createPrimaryToolState();
  let activeTools = ["bash", "edit"];

  primaryToolState.apply(["read", "grep"], activeTools);
  activeTools = ["bash"];

  const restoredTools = primaryToolState.restoreIfAppropriate(activeTools, availableTools);
  if (restoredTools) {
    activeTools = restoredTools;
  }

  assert.deepEqual(activeTools, ["bash"]);
});

test("primary tool state restores additive late-registered tools captured after the first primary pass", () => {
  const availableTools = new Set([
    "bash",
    "edit",
    "grep",
    "intercom",
    "read",
    "subagent_supervisor",
  ]);
  const primaryToolState = createPrimaryToolState();
  let activeTools = ["bash", "edit"];

  primaryToolState.apply(["read", "grep"], activeTools);
  activeTools = ["read", "grep", "subagent_supervisor", "intercom"];
  activeTools = primaryToolState.apply(["read", "grep", "subagent_supervisor"], activeTools);

  const restoredTools = primaryToolState.restoreIfAppropriate(activeTools, availableTools);
  if (restoredTools) {
    activeTools = restoredTools;
  }

  assert.deepEqual(activeTools, ["bash", "edit", "subagent_supervisor", "intercom"]);
});

test("primary tools keep codemode active and append only direct-exposure mcp__* tools alongside it", () => {
  const allTools = [
    { name: "read", exposure: "direct" },
    { name: "codemode", exposure: "direct" },
    { name: "mcp__dir__lookup", exposure: "direct" },
    { name: "mcp__cm__lookup", exposure: "codemode" },
    { name: "mcp__def__lookup", exposure: "deferred" },
    { name: "mcp__hid__lookup", exposure: "hidden" },
    { name: "bash", exposure: "direct" },
  ];
  const availableTools = new Set(allTools.map((tool) => tool.name));
  const primaryToolState = createPrimaryToolState();

  const withCodemode = withDirectMcpTools(
    filterAvailableTools(["read", "codemode"], availableTools),
    allTools,
  );
  assert.deepEqual(withCodemode, ["read", "codemode", "mcp__dir__lookup"]);
  assert.deepEqual(primaryToolState.apply(withCodemode, ["bash"]), withCodemode);

  assert.deepEqual(withDirectMcpTools(["read"], allTools), ["read"]);
});
