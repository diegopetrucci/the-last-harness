import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  detectLegacyMcpConfig,
  formatLegacyMcpConfigNotice,
} from "../scripts/lib/default-extensions.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tlh-mcp-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const homeDir = join(root, "home");
  for (const dir of [
    agentDir,
    join(projectDir, ".pi"),
    join(homeDir, ".config", "mcp"),
    join(homeDir, ".agents"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return { agentDir, projectDir, homeDir };
}

const write = (path, value) => writeFileSync(path, JSON.stringify(value));
const detect = (f, settings) => detectLegacyMcpConfig({ ...f, settings });

test("clean native config produces no findings or notice", (t) => {
  const f = fixture(t);
  write(join(f.agentDir, "mcp.json"), {
    mcpServers: { a: { url: "https://x.example", auth: { type: "bearer" } } },
  });
  const findings = detect(f, { packages: ["npm:something-else"], extensions: [] });
  assert.ok(Object.values(findings).every((n) => n === 0));
  assert.equal(formatLegacyMcpConfigNotice(findings), undefined);
});

test("counts adapter-only shapes per category without leaking names or values", (t) => {
  const f = fixture(t);
  write(join(f.agentDir, "mcp.json"), {
    imports: ["./secret-shared.json"],
    mcpServers: {
      leakyname: { url: "https://leak.example/tok", auth: "bearer-secret", lifecycle: "lazy" },
      other: { command: "x", directTools: true },
    },
  });
  write(join(f.projectDir, ".pi", "mcp.json"), { mcpServers: { p: { auth: "oauth" } } });
  write(join(f.agentDir, "mcp-adapter.json"), {});
  write(join(f.projectDir, ".pi", "mcp-adapter.json"), {});
  write(join(f.homeDir, ".config", "mcp", "mcp.json"), { mcpServers: {} });
  write(join(f.homeDir, ".agents", "mcp.json"), { mcpServers: {} });

  const findings = detect(f);
  assert.deepEqual(findings, {
    stringAuthServers: 2,
    importsFiles: 1,
    lifecycleServers: 1,
    directToolsServers: 1,
    adapterConfigFiles: 2,
    unreadSharedConfigFiles: 2,
    adapterPackages: 0,
    unmanagedBuiltinMcpExclusion: 0,
  });
  const notice = formatLegacyMcpConfigNotice(findings);
  assert.match(notice, /docs\/mcp\.md#migrating-from-the-mcp-adapter/);
  assert.doesNotMatch(notice, /leakyname|leak\.example|bearer-secret|secret-shared/);
});

test("flags selected adapter packages and unmanaged -builtin:mcp exclusions", (t) => {
  const f = fixture(t);
  const findings = detect(f, {
    packages: ["npm:pi-mcp-adapter@2.0.0", { source: "git:github.com/nicobailon/pi-mcp-adapter" }],
    extensions: ["-builtin:mcp"],
  });
  assert.equal(findings.adapterPackages, 2);
  assert.equal(findings.unmanagedBuiltinMcpExclusion, 1);
  assert.match(formatLegacyMcpConfigNotice(findings), /full `tlh update`/);

  const managed = detect(f, {
    extensions: ["-builtin:mcp"],
    tlh: { builtinMcpExclusionManaged: true },
  });
  assert.equal(managed.unmanagedBuiltinMcpExclusion, 0);
});

test("tolerates malformed and missing files", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "mcp.json"), "{not json");
  assert.equal(formatLegacyMcpConfigNotice(detect(f, "nonsense")), undefined);
});
