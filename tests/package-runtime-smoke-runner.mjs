import assert from "node:assert/strict";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const [packageRoot, cwd, agentDir] = process.argv.slice(2);
assert.ok(
  packageRoot && cwd && agentDir,
  "usage: package-runtime-smoke-runner.mjs <package-root> <cwd> <agent-dir>",
);
const realPackageRoot = realpathSync(packageRoot);
const configuredSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
assert.deepEqual(configuredSettings.packages, [realPackageRoot]);

class FakeEvents {
  #handlers = new Map();

  on(event, handler) {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
    return () => {
      const current = this.#handlers.get(event) ?? [];
      this.#handlers.set(
        event,
        current.filter((candidate) => candidate !== handler),
      );
    };
  }

  async emit(event, data) {
    await Promise.all((this.#handlers.get(event) ?? []).map((handler) => handler(data)));
  }

  listenerCount(event) {
    return (this.#handlers.get(event) ?? []).length;
  }
}

const packagedEvents = new FakeEvents();
const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  eventBus: packagedEvents,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertGeneratedChildExtensionPaths(paths, label) {
  assert.ok(Array.isArray(paths), `${label} must report extension paths`);
  assert.ok(paths.length > 0, `${label} must report at least one extension path`);
  for (const path of paths) {
    const relativePath = relative(realPackageRoot, path);
    const outsidePackageRoot =
      relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
    assert.equal(
      outsidePackageRoot,
      false,
      `${label} path must be under the package root: ${path}`,
    );
    assert.match(path, /\.js$/, `${label} path must be a generated JavaScript file: ${path}`);
  }
}

function installPackedChildShim() {
  const shimPath = join(cwd, "packed-pi-shim");
  const childCliPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "extensions",
    "subagents",
    "test",
    "support",
    "real-session-child-cli.mjs",
  );
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(childCliPath)} "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

async function runPackedChildSmoke(subagentExtension, sessionContext) {
  const marker = "PACKED_FAUX_CHILD_MARKER";
  const extensionEvidencePath = join(cwd, "packed-child-extensions.json");
  const shimPath = installPackedChildShim();
  const childEnv = {
    PI_SUBAGENT_PI_BINARY: shimPath,
    PI_SUBAGENTS_E2E_CHILD_TEXT: marker,
    PI_SUBAGENTS_E2E_EXTENSIONS_FILE: extensionEvidencePath,
  };
  const previousChildEnv = Object.fromEntries(
    Object.keys(childEnv).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, childEnv);
    const subagentTool = subagentExtension.tools.get("subagent").definition;
    const result = await subagentTool.execute(
      "packed-child-execution",
      {
        agent: "developer",
        task: "Return the deterministic faux child marker",
        context: "fresh",
        agentScope: "user",
      },
      new AbortController().signal,
      undefined,
      sessionContext,
    );
    assert.equal(result.isError, undefined);
    const text = result.content
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text)
      .join("\n");
    assert.match(text, new RegExp(marker));
    const evidence = JSON.parse(readFileSync(extensionEvidencePath, "utf8"));
    assert.deepEqual(evidence.errors, []);
    const resolvedChildExtensionPaths = evidence.resolvedPaths.map((path) => realpathSync(path));
    assertGeneratedChildExtensionPaths(resolvedChildExtensionPaths, "packed child execution");
    return {
      marker,
      childExtensionPaths: resolvedChildExtensionPaths.map((path) =>
        relative(realPackageRoot, path).replaceAll("\\", "/"),
      ),
    };
  } finally {
    for (const [key, value] of Object.entries(previousChildEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function inspectLoad() {
  const result = resourceLoader.getExtensions();
  assert.deepEqual(result.errors, []);
  const resolvedEntrypoints = result.extensions.map((extension) =>
    realpathSync(extension.resolvedPath),
  );
  assert.equal(
    resolvedEntrypoints.some((path) => path.endsWith(".ts")),
    false,
  );
  const resolvedPackageRoots = result.extensions.map((extension) => {
    assert.equal(extension.sourceInfo?.scope, "user");
    assert.equal(extension.sourceInfo?.origin, "package");
    assert.equal(realpathSync(extension.sourceInfo.source), realPackageRoot);
    return realpathSync(extension.sourceInfo.baseDir);
  });
  assert.deepEqual([...new Set(resolvedPackageRoots)], [realPackageRoot]);

  const tlhExtension = result.extensions.find((extension) =>
    extension.commands.has("tlh-changelog"),
  );
  const subagentExtension = result.extensions.find((extension) => extension.tools.has("subagent"));
  assert.ok(tlhExtension, "TLH extension must expose the exercised changelog command");
  assert.ok(subagentExtension, "subagent extension must expose the exercised subagent tool");

  const allCommandNames = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
  assert.equal(
    new Set(allCommandNames).size,
    allCommandNames.length,
    "package commands must not be registered twice",
  );
  const allToolNames = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
  const toolCounts = {
    subagent: allToolNames.filter((name) => name === "subagent").length,
  };
  assert.deepEqual(
    toolCounts,
    { subagent: 1 },
    "loaded package entrypoints must expose one subagent surface",
  );
  return {
    result,
    tlhExtension,
    subagentExtension,
    toolCounts,
    packageResolution: {
      configuredPackage: realPackageRoot,
      resolvedPackageRoots: [...new Set(resolvedPackageRoots)],
      scope: subagentExtension.sourceInfo.scope,
      origin: subagentExtension.sourceInfo.origin,
    },
  };
}

function createSessionContext() {
  const installedFactories = { header: [], footer: [] };
  const notifications = [];
  const context = {
    mode: "rpc",
    hasUI: true,
    cwd,
    model: undefined,
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyForProvider: async () => undefined,
      getAvailable: () => [],
      find: () => undefined,
      authStorage: { get: () => undefined },
    },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => cwd,
      getSessionName: () => undefined,
      getBranch: () => [],
      getSessionId: () => "package-smoke-session",
      getSessionFile: () => null,
    },
    getContextUsage: () => undefined,
    isIdle: () => true,
    isProjectTrusted: () => false,
    ui: {
      addAutocompleteProvider() {},
      setWidget() {},
      setFooter(factory) {
        installedFactories.footer.push(factory);
      },
      setHeader(factory) {
        installedFactories.header.push(factory);
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      getEditorText: () => "",
    },
  };
  return { context, installedFactories, notifications };
}

async function runSessionStart(tlhExtension, subagentExtension) {
  const fixture = createSessionContext();
  for (const handler of tlhExtension.handlers.get("session_start") ?? []) {
    await handler({ reason: "reload" }, fixture.context);
  }
  for (const handler of subagentExtension.handlers.get("session_start") ?? []) {
    await handler({ reason: "reload" }, fixture.context);
  }
  assert.equal(fixture.installedFactories.header.length, 1);
  assert.equal(fixture.installedFactories.footer.length, 1);
  assert.equal(typeof fixture.installedFactories.header[0], "function");
  assert.equal(typeof fixture.installedFactories.footer[0], "function");
  return fixture;
}

await resourceLoader.reload();
const defaultOff = inspectLoad();
await runSessionStart(defaultOff.tlhExtension, defaultOff.subagentExtension);

await resourceLoader.reload();
const first = inspectLoad();
await runSessionStart(first.tlhExtension, first.subagentExtension);

await resourceLoader.reload();
const second = inspectLoad();
const firstExtensionsByPath = new Map(
  first.result.extensions.map((extension) => [realpathSync(extension.resolvedPath), extension]),
);
const secondExtensionsByPath = new Map(
  second.result.extensions.map((extension) => [realpathSync(extension.resolvedPath), extension]),
);
assert.deepEqual(
  [...secondExtensionsByPath.keys()].sort(),
  [...firstExtensionsByPath.keys()].sort(),
);
for (const [resolvedPath, firstExtension] of firstExtensionsByPath) {
  const secondExtension = secondExtensionsByPath.get(resolvedPath);
  assert.ok(secondExtension, `reloaded extension missing for ${resolvedPath}`);
  assert.notEqual(secondExtension, firstExtension);
  if (secondExtension.commands && firstExtension.commands) {
    assert.notEqual(secondExtension.commands, firstExtension.commands);
  }
  if (secondExtension.tools && firstExtension.tools) {
    assert.notEqual(secondExtension.tools, firstExtension.tools);
  }
}
const secondSession = await runSessionStart(second.tlhExtension, second.subagentExtension);
const subagentExtension = second.subagentExtension;

second.result.runtime.getSessionName = () => undefined;
const subagentTool = subagentExtension.tools.get("subagent").definition;
const failedSubagentResult = await subagentTool.execute(
  "package-smoke-failure",
  { agent: "__tlh_missing_agent__", task: "exercise Pi 0.83 failure patch" },
  new AbortController().signal,
  undefined,
  secondSession.context,
);
assert.equal(Object.hasOwn(failedSubagentResult, "isError"), false);
assert.match(failedSubagentResult.content[0].text, /Unknown agent/);
assert.equal(failedSubagentResult.details.mode, "single");
const [subagentToolResultHandler] = subagentExtension.handlers.get("tool_result") ?? [];
assert.equal(typeof subagentToolResultHandler, "function");
const failedSubagentPatch = await subagentToolResultHandler(
  {
    type: "tool_result",
    toolName: "subagent",
    toolCallId: "package-smoke-failure",
    input: { agent: "__tlh_missing_agent__", task: "exercise Pi 0.83 failure patch" },
    content: failedSubagentResult.content,
    details: failedSubagentResult.details,
    isError: false,
  },
  secondSession.context,
);
assert.deepEqual(failedSubagentPatch, { isError: true });
const childEnvSentinels = {
  PI_SUBAGENT_PI_BINARY: "restore-packed-pi-binary",
  PI_SUBAGENTS_E2E_CHILD_TEXT: "restore-packed-child-text",
  PI_SUBAGENTS_E2E_EXTENSIONS_FILE: "restore-packed-extensions-file",
};
Object.assign(process.env, childEnvSentinels);
let packagedChild;
let childEnvRestored;
try {
  packagedChild = await runPackedChildSmoke(subagentExtension, secondSession.context);
  childEnvRestored = Object.entries(childEnvSentinels).every(
    ([key, value]) => process.env[key] === value,
  );
  assert.equal(childEnvRestored, true);
} finally {
  for (const key of Object.keys(childEnvSentinels)) delete process.env[key];
}

const sentMessages = [];
second.result.runtime.sendMessage = (message) => sentMessages.push(message);
const changelogNotifications = [];
await second.tlhExtension.commands.get("tlh-changelog").handler("", {
  hasUI: false,
  ui: {
    notify(message, type) {
      changelogNotifications.push({ message, type });
    },
  },
});
assert.deepEqual(changelogNotifications, []);
assert.equal(sentMessages.length, 1);
assert.equal(sentMessages[0].customType, "TLH release notes");
assert.match(sentMessages[0].content, /^# Changelog/m);

const reviewUiPath = join(realPackageRoot, "extensions", "annotate-git-diff", "ui.js");
const annotateUiPath = join(
  realPackageRoot,
  "extensions",
  "the-last-harness",
  "annotate-last-message",
  "ui.js",
);
const piArgsPath = join(
  realPackageRoot,
  "extensions",
  "subagents",
  "src",
  "runs",
  "shared",
  "pi-args.js",
);
const { buildPiArgs } = await import(pathToFileURL(piArgsPath).href);
const childPiArgs = buildPiArgs({
  baseArgs: [],
  task: "packaged child path smoke",
  sessionEnabled: false,
  inheritProjectContext: false,
  inheritSkills: false,
  tools: ["subagent"],
}).args;
const childExtensionPaths = childPiArgs.flatMap((arg, index) =>
  arg === "--extension" ? [childPiArgs[index + 1]] : [],
);
const builtChildExtensionPaths = childExtensionPaths.map((path) => realpathSync(path));
assertGeneratedChildExtensionPaths(builtChildExtensionPaths, "buildPiArgs");
assert.deepEqual(
  packagedChild.childExtensionPaths,
  builtChildExtensionPaths.map((path) => relative(realPackageRoot, path).replaceAll("\\", "/")),
);

const { buildReviewHtml } = await import(pathToFileURL(reviewUiPath).href);
const { buildAnnotateLastMessageHtml } = await import(pathToFileURL(annotateUiPath).href);
const reviewHtml = buildReviewHtml({ files: [], scope: { mode: "all" } });
const annotateHtml = buildAnnotateLastMessageHtml({ text: "packaged generated asset smoke" });
assert.match(reviewHtml, /<!doctype html>/i);
assert.doesNotMatch(reviewHtml, /__INLINE_(?:DATA|JS|ASSET_CONFIG)__/);
assert.match(annotateHtml, /packaged generated asset smoke/);
assert.doesNotMatch(annotateHtml, /__INLINE_(?:DATA|JS)__/);

for (const handler of subagentExtension.handlers.get("session_shutdown") ?? []) {
  await handler({ type: "session_shutdown", reason: "quit" }, secondSession.context);
}

process.stdout.write(
  `${JSON.stringify({
    packageResolution: second.packageResolution,
    toolCounts: second.toolCounts,
    failedSubagentPatched: failedSubagentPatch.isError,
    childExecution: packagedChild,
    childEnvRestored,
    childExtensionPaths: packagedChild.childExtensionPaths,
    builtChildExtensionPaths: builtChildExtensionPaths.map((path) =>
      relative(realPackageRoot, path).replaceAll("\\", "/"),
    ),
  })}\n`,
);
