import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { readDefaultExtensions } from "../scripts/lib/default-extensions.mjs";
import {
  evaluateMcpAdapterCutover,
  mcpAdapterStartupGuardNotice,
} from "../scripts/lib/mcp-adapter-cutover.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const mcporter = readDefaultExtensions(join(repoRoot, "config", "default-extensions.json")).find(
  (entry) => entry.id === "mcporter",
);
assert.ok(mcporter, "the bundled mcporter manifest entry must exist");
const tagSource = "git:github.com/diegopetrucci/pi-mcp-adapter@tlh-v5.0.0-1";

for (const [cached, held] of [
  ["2.10.0", true],
  ["5.0.0", false],
]) {
  test(`stable native git tag with cached ${cached} ${held ? "is refused" : "starts"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "tlh-mcp-adapter-git-tag-"));
    try {
      const agentDir = join(root, "agent");
      const gitDir = join(agentDir, "git", "github.com", "diegopetrucci", "pi-mcp-adapter");
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(
        join(gitDir, "package.json"),
        JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: cached }),
      );
      const decision = evaluateMcpAdapterCutover({ packages: [tagSource] }, mcporter, {
        agentDir,
        homeDir: join(root, "home"),
      });
      assert.equal(decision.selected[0]?.metadataConflict, held);
      assert.equal(Boolean(mcpAdapterStartupGuardNotice(decision)), held);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
