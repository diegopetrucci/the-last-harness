import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const configPath = resolve(repoRoot, ".oxfmtrc.json");
const oxlintConfigPath = resolve(repoRoot, ".oxlintrc.json");
const antiSlopRoot = resolve(repoRoot, "tools/oxlint/anti-slop");
const packagePath = resolve(repoRoot, "package.json");
const lockfilePath = resolve(repoRoot, "package-lock.json");
const gitattributesPath = resolve(repoRoot, ".gitattributes");
const formattingSurfaceRoots = ["scripts/", "tests/", "extensions/"];
const extensionHtmlIgnores = [
  "extensions/annotate-git-diff/web/index.html",
  "extensions/the-last-harness/annotate-last-message/web/index.html",
];
const activeAntiSlopRuleNames = [
  "anti-slop/no-module-mocking",
  "anti-slop/no-unknown-type-aliases",
];
const antiSlopRuleNames = [
  "anti-slop/no-chained-type-assertions",
  "anti-slop/no-conditional-empty-object-spread",
  "anti-slop/no-known-value-widening",
  "anti-slop/no-module-mocking",
  "anti-slop/no-object-parameters",
  "anti-slop/no-reflect-apply",
  "anti-slop/no-reflect-get",
  "anti-slop/no-runtime-typeof",
  "anti-slop/no-shape-in-symbol-names",
  "anti-slop/no-unknown-parameters",
  "anti-slop/no-unknown-returns",
  "anti-slop/no-unknown-type-aliases",
  "anti-slop/no-unsafe-dictionary-type",
  "anti-slop/no-widen-then-assert",
  "anti-slop/require-safety-comment-for-type-assertion",
];
const requiredOxlintIgnores = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".gnosis/**",
  ".hunk/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".symphony/**",
  ".tickets/**",
  ".windsurf/**",
  "tools/oxlint/anti-slop/**",
];
const expectedAntiSlopFiles = [
  "index.ts",
  ...antiSlopRuleNames.map((name) => `rules/${name.slice("anti-slop/".length)}.ts`),
  "shared/dictionary-types.ts",
  "shared/lexical-type-parameters.ts",
  "shared/reflect-method.ts",
].sort();

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCommentCapableJson(path) {
  const source = readFileSync(path, "utf8");
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function collectFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = `${prefix}${entry.name}`;
      if (entry.isDirectory())
        return collectFiles(resolve(directory, entry.name), `${relativePath}/`);
      assert.equal(entry.isFile(), true, `unexpected non-file plugin entry ${relativePath}`);
      return [relativePath];
    })
    .sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readGeneratedRuntimePaths() {
  return readFileSync(gitattributesPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("linguist-generated=true"))
    .map((line) => line.split(/\s+/)[0])
    .filter((path) => formattingSurfaceRoots.some((root) => path.startsWith(root)))
    .filter((path) => /\.(?:js|mjs)$/.test(path));
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    if (pattern[index] === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    source += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`${source}$`);
}

function matchesIgnorePattern(pattern, path) {
  return globToRegExp(pattern).test(path);
}

test("Oxfmt configuration keeps generated mirrors and existing HTML assets out of formatting", () => {
  assert.equal(
    existsSync(resolve(repoRoot, "biome.json")),
    false,
    "Biome configuration must be removed",
  );

  const config = readJson(configPath);
  assert.deepEqual(Object.keys(config).sort(), ["$schema", "ignorePatterns"]);
  assert.equal(config.$schema, "./node_modules/oxfmt/configuration_schema.json");
  assert.ok(Array.isArray(config.ignorePatterns));
  for (const htmlPath of extensionHtmlIgnores) {
    assert.ok(
      config.ignorePatterns.includes(htmlPath),
      `Oxfmt must ignore existing HTML asset ${htmlPath}`,
    );
  }
  assert.equal(
    config.ignorePatterns.filter((pattern) => extensionHtmlIgnores.includes(pattern)).length,
    extensionHtmlIgnores.length,
    "Oxfmt must retain exactly the two existing HTML safety exclusions",
  );

  const generatedRuntimePaths = readGeneratedRuntimePaths();
  assert.ok(
    generatedRuntimePaths.length > 0,
    "the generated runtime registry must contain formatting-surface outputs",
  );
  for (const generatedPath of generatedRuntimePaths) {
    assert.ok(
      config.ignorePatterns.some((pattern) => matchesIgnorePattern(pattern, generatedPath)),
      `Oxfmt must ignore registered generated runtime output ${generatedPath}`,
    );
  }

  const unmatchedPatterns = config.ignorePatterns.filter(
    (pattern) =>
      !extensionHtmlIgnores.includes(pattern) &&
      !generatedRuntimePaths.some((generatedPath) => matchesIgnorePattern(pattern, generatedPath)),
  );
  assert.deepEqual(
    unmatchedPatterns,
    [],
    "every Oxfmt ignore must protect a registered output or HTML asset",
  );
});

test("package scripts invoke Ox tools with default rule selection over the existing source surface and validation gate", () => {
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockfilePath);
  assert.equal(packageJson.devDependencies["@biomejs/biome"], undefined);
  assert.equal(packageJson.devDependencies.oxlint, "1.78.0");
  assert.equal(packageJson.devDependencies.oxfmt, "0.63.0");
  assert.equal(packageLock.packages[""].devDependencies.oxlint, "1.78.0");
  assert.equal(packageLock.packages[""].devDependencies.oxfmt, "0.63.0");
  assert.equal(packageLock.packages["node_modules/oxlint"].version, "1.78.0");
  assert.equal(packageLock.packages["node_modules/oxfmt"].version, "0.63.0");
  assert.equal(packageLock.packages["node_modules/@biomejs/biome"], undefined);
  assert.equal(packageJson.scripts.lint, "oxlint --deny-warnings scripts tests extensions");
  assert.equal(packageJson.scripts.format, "oxfmt scripts tests extensions");
  assert.equal(packageJson.scripts["format:check"], "oxfmt --check scripts tests extensions");
  assert.match(
    packageJson.scripts.validate,
    /npm run lint && npm run format:check && npm run lint:sh/,
    "validate must run Oxfmt checking between Oxlint and ShellCheck",
  );
});

test("Oxlint and anti-slop dependencies stay exact-pinned at the same version", () => {
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockfilePath);
  const expectedVersion = "1.78.0";
  for (const dependency of ["oxlint", "@oxlint/plugins"]) {
    assert.equal(packageJson.devDependencies[dependency], expectedVersion);
    assert.equal(packageLock.packages[""].devDependencies[dependency], expectedVersion);
    assert.equal(packageLock.packages[`node_modules/${dependency}`].version, expectedVersion);
  }
});

test("copied anti-slop plugin contains the complete bundled inventory", () => {
  const files = collectFiles(antiSlopRoot);
  assert.deepEqual(files, expectedAntiSlopFiles);
  for (const file of files) {
    assert.ok(
      readText(resolve(antiSlopRoot, file)).length > 0,
      `copied plugin file is empty: ${file}`,
    );
  }
  assert.match(readText(resolve(antiSlopRoot, "index.ts")), /from "@oxlint\/plugins"/);
});

test("Oxlint config loads the plugin, protects tooling, and activates exactly the two approved anti-slop rules", async () => {
  const source = readText(oxlintConfigPath);
  const config = readCommentCapableJson(oxlintConfigPath);
  assert.equal(config.$schema, "./node_modules/oxlint/configuration_schema.json");
  assert.deepEqual(config.jsPlugins, [
    {
      name: "anti-slop",
      specifier: "./tools/oxlint/anti-slop/index.ts",
    },
  ]);
  for (const pattern of requiredOxlintIgnores) {
    assert.ok(config.ignorePatterns.includes(pattern), `missing required Oxlint ignore ${pattern}`);
  }
  assert.equal(
    Object.keys(config.rules).length,
    activeAntiSlopRuleNames.length,
    "exactly two anti-slop rules must be active",
  );
  assert.equal(
    antiSlopRuleNames.length - activeAntiSlopRuleNames.length,
    13,
    "exactly 13 anti-slop rules must remain commented out",
  );
  assert.deepEqual(
    config.rules,
    Object.fromEntries(activeAntiSlopRuleNames.map((ruleName) => [ruleName, "error"])),
    "only the two approved anti-slop rules are active at error severity",
  );

  const plugin = await import(pathToFileURL(resolve(repoRoot, config.jsPlugins[0].specifier)).href);
  assert.equal(plugin.default.meta.name, "anti-slop");
  assert.deepEqual(
    Object.keys(plugin.default.rules).sort(),
    antiSlopRuleNames.map((name) => name.slice("anti-slop/".length)).sort(),
  );

  for (const ruleName of antiSlopRuleNames) {
    const occurrences = source.match(new RegExp(escapeRegExp(ruleName), "g")) ?? [];
    assert.equal(occurrences.length, 1, `${ruleName} must appear exactly once in .oxlintrc.json`);
    const line = source.split(/\r?\n/).find((candidate) => candidate.includes(ruleName));
    if (activeAntiSlopRuleNames.includes(ruleName)) {
      assert.match(line, /^\s*"/, `${ruleName} must remain active`);
    } else {
      assert.match(line, /^\s*\/\/\s*"/, `${ruleName} must remain visibly commented out`);
    }
  }
});
