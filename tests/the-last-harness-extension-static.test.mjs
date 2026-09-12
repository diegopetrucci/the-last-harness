import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildTlhSystemPrompt, loadPrimaryAgents, loadSubagentMetadata } = await jiti.import(
  "../extensions/the-last-harness/prompts.ts",
);
const { buildReviewHtml } = await jiti.import("../extensions/annotate-git-diff/ui.ts");

const USER_SCOPE_MARKER = /agentScope.*"user"/;

function extractJsonStringAssignment(html, assignmentName) {
  const escapedName = assignmentName.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  const assignment = html.match(new RegExp(`${escapedName}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*;`));
  assert.ok(assignment, `${assignmentName} assignment must be present`);
  return JSON.parse(assignment[1]);
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function extractMonacoRuntimeSource(html) {
  const runtimeSource = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(([, source]) => source)
    .find((source) =>
      /define\(\s*["'][^"']*basic-languages\/monaco\.contribution["']/.test(source),
    );
  assert.ok(runtimeSource, "inlined Monaco runtime script must be present");
  return runtimeSource;
}

function extractAmdModuleSource(runtimeSource, moduleId) {
  const moduleMatch = new RegExp(`define\\(\\s*["']${escapeRegex(moduleId)}["']`).exec(
    runtimeSource,
  );
  assert.ok(moduleMatch, `Monaco module ${moduleId} must be inlined`);
  const moduleStart = moduleMatch.index;
  const nextModuleMatch = /\bdefine\(\s*["']/.exec(
    runtimeSource.slice(moduleStart + moduleMatch[0].length),
  );
  const moduleEnd = nextModuleMatch
    ? moduleStart + moduleMatch[0].length + nextModuleMatch.index
    : runtimeSource.length;
  const moduleSource = runtimeSource.slice(moduleStart, moduleEnd);
  assert.ok(moduleSource.trim(), `Monaco module ${moduleId} must have output`);
  return moduleSource;
}

function resolveAmdModuleId(fromModuleId, target) {
  const normalizedTarget = target.replace(/\.js$/, "");
  if (!normalizedTarget.startsWith(".")) return normalizedTarget;

  const segments = fromModuleId.split("/");
  segments.pop();
  for (const segment of normalizedTarget.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      assert.ok(segments.length > 0, `cannot resolve Monaco module ${target} from ${fromModuleId}`);
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function findLanguageLoaderTarget(contributionSource, { id, extension }) {
  const idMatch = new RegExp(`\\bid\\s*:\\s*["']${escapeRegex(id)}["']`).exec(contributionSource);
  assert.ok(idMatch, `Monaco language registration ${id} must be present`);
  const nextRegistrationMatch = /\bid\s*:\s*["']/.exec(
    contributionSource.slice(idMatch.index + idMatch[0].length),
  );
  const registrationEnd = nextRegistrationMatch
    ? idMatch.index + idMatch[0].length + nextRegistrationMatch.index
    : contributionSource.length;
  const registrationSource = contributionSource.slice(idMatch.index, registrationEnd);
  assert.match(
    registrationSource,
    new RegExp(`extensions\\s*:\\s*\\[[^\\]]*["']${escapeRegex(extension)}["']`),
    `${id} registration must declare ${extension}`,
  );
  const loaderTargetMatch = registrationSource.match(
    /loader\s*:\s*\(\s*\)\s*=>[\s\S]*?(?:\[\s*["']([^"']+)["']\s*\]|import\(\s*["']([^"']+)["']\s*\))/,
  );
  assert.ok(loaderTargetMatch, `${id} registration must have a dynamic AMD loader target`);
  return loaderTargetMatch[1] ?? loaderTargetMatch[2];
}

function createAmdDependencyStub() {
  let proxy;
  const callable = () => proxy;
  proxy = new Proxy(callable, {
    apply: () => proxy,
    construct: () => proxy,
    get: (_target, property) => (property === "then" ? undefined : proxy),
  });
  return proxy;
}

function evaluateAmdModuleExports(moduleSource, moduleId) {
  let capturedExports;
  const dependencyStub = createAmdDependencyStub();
  const context = vm.createContext({
    define(...args) {
      const [id, dependenciesOrFactory, maybeFactory] =
        typeof args[0] === "string" ? args : [moduleId, ...args];
      const dependencies = Array.isArray(dependenciesOrFactory) ? dependenciesOrFactory : [];
      const factory = Array.isArray(dependenciesOrFactory) ? maybeFactory : dependenciesOrFactory;
      assert.equal(id, moduleId, `Monaco module must define the discovered ID ${moduleId}`);
      const exports = {};
      const dependencyValues = dependencies.map((dependency) =>
        dependency === "exports" ? exports : dependencyStub,
      );
      const result = typeof factory === "function" ? factory(...dependencyValues) : factory;
      capturedExports = result === undefined ? exports : result;
    },
  });
  vm.runInContext(moduleSource, context, {
    filename: `${moduleId}.js`,
    timeout: 500,
  });
  assert.ok(capturedExports, `Monaco module ${moduleId} must produce exports`);
  return capturedExports;
}

function assertRepresentativeMonacoLanguageModule(runtimeSource, contributionModuleId, language) {
  const contributionSource = extractAmdModuleSource(runtimeSource, contributionModuleId);
  const loaderTarget = findLanguageLoaderTarget(contributionSource, language);
  const targetModuleId = resolveAmdModuleId(contributionModuleId, loaderTarget);
  const targetModuleSource = extractAmdModuleSource(runtimeSource, targetModuleId);
  const moduleExports = evaluateAmdModuleExports(targetModuleSource, targetModuleId);

  for (const exportName of ["conf", "language"]) {
    const exportValue = moduleExports?.[exportName];
    assert.notEqual(exportValue, null, `${language.id} module must export ${exportName} data`);
    assert.equal(
      typeof exportValue,
      "object",
      `${language.id} export ${exportName} must be an object`,
    );
    assert.ok(
      Reflect.ownKeys(exportValue).length > 0,
      `${language.id} export ${exportName} must have at least one own key`,
    );
  }
}

test("annotate-git-diff review HTML inlines Monaco assets without file:// URLs into node_modules", () => {
  // buildReviewHtml must resolve and inline all Monaco assets so that the WKWebView
  // null-origin restriction on file:// URLs is never triggered.
  const html = buildReviewHtml({
    repoRoot: "/test/repo",
    files: [],
    commits: [],
    branchBaseRef: null,
    branchMergeBaseSha: null,
    repositoryHasHead: false,
  });

  assert.doesNotMatch(
    html,
    /file:\/\/[^\s'"]*node_modules/,
    "built HTML must not contain file:// URLs into node_modules",
  );
  assert.match(html, /define\("vs\/index"/);
  assert.doesNotMatch(html, /define\("vs\/editor\/editor\.main"/);
  assert.doesNotMatch(html, /document\.createElement\("link"\)/);
  assert.match(html, /"bootstrapError":null/);
  assert.match(html, /\.monaco-editor/);
  const workerSource = extractJsonStringAssignment(html, "window.__reviewMonacoWorkerSource");
  assert.ok(workerSource.trim().length > 0, "editor worker bundle must be non-empty");
  assert.match(workerSource, /(?:self|globalThis)\.onmessage\b|onmessage\s*=/);
  assert.match(workerSource, /\bpostMessage\b/);
  const runtimeSource = extractMonacoRuntimeSource(html);
  const contributionModuleMatch = runtimeSource.match(
    /define\(\s*["']([^"']*basic-languages\/monaco\.contribution)["']/,
  );
  assert.ok(contributionModuleMatch, "Monaco basic-language contribution module must be inlined");
  const contributionModuleId = contributionModuleMatch[1];
  for (const language of [
    { id: "typescript", extension: ".ts" },
    { id: "python", extension: ".py" },
    { id: "go", extension: ".go" },
  ]) {
    assertRepresentativeMonacoLanguageModule(runtimeSource, contributionModuleId, language);
  }

  for (const marker of [
    "__INLINE_MONACO_ENTRY_JS__",
    "__INLINE_MONACO_EDITOR_CSS__",
    "__INLINE_MONACO_WORKER_SOURCE_JSON__",
    "__INLINE_MONACO_BASIC_LANGUAGES_JS__",
  ]) {
    assert.doesNotMatch(html, new RegExp(marker));
  }
});

test("primary prompt exposes stable minor-agent delegation markers", () => {
  const primaryAgents = loadPrimaryAgents();
  const rush = primaryAgents.get("rush");
  assert.ok(rush, "Rush primary prompt should load");

  const primaryPrompt = buildTlhSystemPrompt(rush, loadSubagentMetadata(), true);

  assert.match(primaryPrompt, /## TLH Allowed Minor Subagents/);
  assert.match(primaryPrompt, /action: "list"`\/`"get"`\/`"resume"/);
  assert.match(primaryPrompt, USER_SCOPE_MARKER);
  assert.match(primaryPrompt, /- contrarian:/i);
});

test("allowed-subagents prompt scopes embedded guidance to architect regardless of settings", () => {
  const primaryAgents = loadPrimaryAgents();
  const architect = primaryAgents.get("architect");
  const rush = primaryAgents.get("rush");
  const product = primaryAgents.get("product");
  const bugHunter = primaryAgents.get("bug-hunter");
  const subagents = loadSubagentMetadata();

  const embeddedTargetMarker = /embedded\.<slug>/;
  const embeddedProjectAgentMarker = /embedded\.xyz/;
  const projectAgentPathMarker = /\.tlh\/agents\/custom\/<UPPERCASE-SLUG>\.md/;
  const sectionHeader = /## TLH Allowed Minor Subagents/;
  const reviewHandoffHeader = /## \/review handoff/;

  const architectPrompt = buildTlhSystemPrompt(architect, subagents, true);
  assert.match(architectPrompt, sectionHeader);
  assert.match(architectPrompt, embeddedTargetMarker);
  assert.match(architectPrompt, embeddedProjectAgentMarker);
  assert.match(architectPrompt, projectAgentPathMarker);
  assert.match(architectPrompt, USER_SCOPE_MARKER);

  for (const primary of [rush, product, bugHunter]) {
    const label = primary?.name ?? "unknown";
    const prompt = buildTlhSystemPrompt(primary, subagents, true);
    assert.match(prompt, sectionHeader, `${label}: section header present`);
    assert.doesNotMatch(prompt, embeddedTargetMarker, `${label}: no embedded guidance`);
    assert.doesNotMatch(prompt, reviewHandoffHeader, `${label}: no review handoff`);
  }

  const disabledPrompt = buildTlhSystemPrompt(undefined, subagents, false);
  assert.match(disabledPrompt, sectionHeader, "disabled: section header present");
  assert.match(disabledPrompt, embeddedTargetMarker, "disabled: embedded guidance present");
  assert.doesNotMatch(disabledPrompt, embeddedProjectAgentMarker);
  assert.match(disabledPrompt, projectAgentPathMarker);
  assert.match(disabledPrompt, USER_SCOPE_MARKER);
  assert.match(disabledPrompt, /## \/review handoff[\s\S]*code-reviewer/);
  assert.doesNotMatch(disabledPrompt, /You are the TLH architect/);
});
