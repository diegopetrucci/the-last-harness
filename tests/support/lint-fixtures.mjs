import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");

export function lintFixtures(t, fixtures, { prefix, code } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixturePaths = Object.entries(fixtures).map(([name, source]) => {
    const fixturePath = join(fixtureRoot, name);
    writeFileSync(fixturePath, source);
    return fixturePath;
  });

  const result = spawnSync(
    oxlintPath,
    ["--config", oxlintConfigPath, "--quiet", "--format", "json", ...fixturePaths],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.length > 0, "Oxlint should emit a JSON report");
  const report = JSON.parse(result.stdout);
  return report.diagnostics.filter((diagnostic) => code === undefined || diagnostic.code === code);
}

export function lintDiagnosticSummaries(t, fixtures, options) {
  return lintFixtures(t, fixtures, options)
    .map((diagnostic) => ({
      code: diagnostic.code,
      filename: basename(diagnostic.filename),
      line: diagnostic.labels[0]?.span.line,
      severity: diagnostic.severity,
    }))
    .sort(
      (left, right) =>
        left.filename.localeCompare(right.filename) || (left.line ?? 0) - (right.line ?? 0),
    );
}
