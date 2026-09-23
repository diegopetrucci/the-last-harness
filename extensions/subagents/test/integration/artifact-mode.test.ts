import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(filePath));
    else if (entry.isFile() && filePath.endsWith(".ts")) files.push(filePath);
  }
  return files;
}

describe("artifact resolver production wiring", () => {
  it("keeps the default artifact profile centralized in production sources", () => {
    const sourceRoot = path.join(projectRoot, "src");
    const centralizedDefaultReferences = new Set([
      path.join(sourceRoot, "shared", "artifacts.ts"),
      path.join(sourceRoot, "shared", "types.ts"),
    ]);
    const productionFiles = productionTypeScriptFiles(sourceRoot);
    assert.ok(productionFiles.length > 0, "expected production TypeScript files");

    for (const filePath of productionFiles) {
      if (centralizedDefaultReferences.has(filePath)) continue;
      const source = fs.readFileSync(filePath, "utf8");
      assert.doesNotMatch(
        source,
        /\bDEFAULT_ARTIFACT_CONFIG\b/,
        `production artifact policy bypass in ${path.relative(projectRoot, filePath)}`,
      );
    }
  });
});
