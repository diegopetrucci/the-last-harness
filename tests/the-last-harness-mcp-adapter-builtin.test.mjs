/**
 * Pi 0.99.2 regression: built-in MCP adapter replacement.
 *
 * Pi 0.99.0 introduced built-in codemode, tool-search, and mcp extensions. The built-in mcp
 * extension is marked `replaceable: true`, which means it is silently omitted when another
 * extension registers the same `/mcp` command.
 *
 * TLH ships `mcporter` (npm:@diegopetrucci/pi-mcp-adapter) as a default extension. When
 * mcporter is loaded it registers `/mcp`, causing Pi to omit the built-in and emit a warning.
 * When mcporter is disabled the built-in MCP loads normally.
 *
 * Tests drive Pi's real DefaultResourceLoader (exported from @earendil-works/pi-coding-agent)
 * with stub extension factories and isolated temp agentDir/cwd so they are fully offline,
 * deterministic, and credential-free. The builtin:<name> passthrough is tested via pi-args.test.ts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");

// Shared temp dirs cleaned up after each test group.
let tmpRoot;

function makeTempDirs() {
  tmpRoot = mkdtempSync(join(tmpdir(), "tlh-mcp-builtin-"));
  const agentDir = join(tmpRoot, "agent");
  const cwd = join(tmpRoot, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { agentDir, cwd };
}

function cleanupTempDirs() {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
}

/** Stub factory for the built-in MCP extension: registers the /mcp command. */
function stubBuiltinMcpFactory(pi) {
  pi.registerCommand("mcp", {
    description: "stub built-in mcp",
    handler: () => {},
  });
}

/** Stub factory representing the TLH MCP adapter: also registers /mcp (non-replaceable). */
function stubAdapterMcpFactory(pi) {
  pi.registerCommand("mcp", {
    description: "stub adapter mcp",
    handler: () => {},
  });
}

// ---------------------------------------------------------------------------
// Case (a): adapter present — built-in mcp is NOT loaded; warning is reported
// ---------------------------------------------------------------------------

test("adapter present: builtin mcp is omitted and a warning is reported", async () => {
  const { agentDir, cwd } = makeTempDirs();
  try {
    // Use an in-memory SettingsManager to avoid all file I/O for settings.
    const settingsManager = SettingsManager.inMemory();

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      // Built-in mcp (replaceable). Registered in builtinExtensions map; loads as builtin:mcp.
      extensionFactories: [
        { name: "mcp", factory: stubBuiltinMcpFactory, replaceable: true, builtin: true },
        // Non-builtin stub representing the adapter. Loaded as an inline extension that
        // registers /mcp, which triggers Pi's omitReplacedExtensions path.
        { name: "adapter-stub", factory: stubAdapterMcpFactory },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();
    const result = loader.getExtensions();

    // The built-in mcp must not be in the loaded extension set.
    const loadedPaths = result.extensions.map((e) => e.path);
    assert.ok(
      !loadedPaths.includes("builtin:mcp"),
      `builtin:mcp must be omitted when adapter registers /mcp; loaded: ${JSON.stringify(loadedPaths)}`,
    );

    // Pi must emit a warning mentioning the built-in extension name and /mcp.
    const warnings = result.warnings ?? [];
    const mcpWarning = warnings.find(
      (w) => w.warning.includes("mcp") && w.warning.includes("/mcp"),
    );
    assert.ok(
      mcpWarning,
      `a warning about built-in 'mcp' not being loaded must be reported; got: ${JSON.stringify(warnings)}`,
    );
    // The warning should mention 'not loaded' and 'pi config' per resource-loader.js ~92.
    assert.match(mcpWarning.warning, /not loaded/);
    assert.match(mcpWarning.warning, /pi config/);
  } finally {
    cleanupTempDirs();
  }
});

// ---------------------------------------------------------------------------
// Case (b): adapter absent — builtin mcp IS loaded normally
// ---------------------------------------------------------------------------

test("adapter absent: builtin mcp loads normally with no replacement warning", async () => {
  const { agentDir, cwd } = makeTempDirs();
  try {
    const settingsManager = SettingsManager.inMemory();

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      // Only the built-in mcp; no adapter stub.
      extensionFactories: [
        { name: "mcp", factory: stubBuiltinMcpFactory, replaceable: true, builtin: true },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();
    const result = loader.getExtensions();

    // The built-in mcp must be present.
    const loadedPaths = result.extensions.map((e) => e.path);
    assert.ok(
      loadedPaths.includes("builtin:mcp"),
      `builtin:mcp must load when no adapter registers /mcp; loaded: ${JSON.stringify(loadedPaths)}`,
    );

    // No replacement warning for mcp.
    const mcpWarning = (result.warnings ?? []).find((w) => w.warning.includes("mcp"));
    assert.equal(
      mcpWarning,
      undefined,
      `no mcp replacement warning expected when adapter is absent; got: ${JSON.stringify(result.warnings)}`,
    );
  } finally {
    cleanupTempDirs();
  }
});
