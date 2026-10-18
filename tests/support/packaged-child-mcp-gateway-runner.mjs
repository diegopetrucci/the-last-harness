import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const [packageRoot, adapterRoot, cwd, agentDir, childCliPath, evidencePath] = process.argv.slice(2);
if (![packageRoot, adapterRoot, cwd, agentDir, childCliPath, evidencePath].every(Boolean)) {
  throw new Error(
    "usage: packaged-child-mcp-gateway-runner <package> <adapter> <cwd> <agent> <child> <evidence>",
  );
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const shimBase = join(cwd, "pi-shim");
const shimPath = process.platform === "win32" ? `${shimBase}.cmd` : shimBase;
if (process.platform === "win32") {
  writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${childCliPath}" %*\r\n`);
} else {
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(childCliPath)} "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
}
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENT_PI_BINARY = shimPath;
process.env.PI_SUBAGENTS_E2E_MCP_EVIDENCE = evidencePath;
process.env.PI_OFFLINE = "1";
delete process.env.MCP_DIRECT_TOOLS;

function textContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

function latestSubagentResult(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "toolResult" && message.toolName === "subagent") {
      return textContent(message.content);
    }
  }
  return undefined;
}

const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await resourceLoader.reload();
const loaded = resourceLoader.getExtensions();
if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
const subagentExtension = loaded.extensions.find((extension) => extension.tools.has("subagent"));
if (!subagentExtension) throw new Error("packaged subagent extension did not load");
const adapterExtension = loaded.extensions.find(
  (extension) => extension.resolvedPath.startsWith(adapterRoot) && extension.tools.has("mcp"),
);
if (!adapterExtension) throw new Error("pinned packaged MCP adapter did not load");

const faux = fauxProvider({
  provider: "faux-packaged-mcp-parent",
  models: [{ id: "parent", contextWindow: 200000 }],
});
const modelRuntime = await ModelRuntime.create({
  modelsPath: null,
  authPath: join(agentDir, "auth.json"),
});
modelRuntime.registerNativeProvider(faux.provider);
const model = faux.getModel();
const respond = async (context) => {
  const childResult = latestSubagentResult(context.messages);
  if (childResult === undefined) {
    return fauxAssistantMessage(
      fauxToolCall(
        "subagent",
        {
          agent: "repo-scout",
          task: "Use the generic mcp gateway to connect to fixture and call read_fixture once, then return its exact deterministic result.",
          agentScope: "user",
        },
        { id: "run-packaged-mcp-child" },
      ),
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage(
    fauxText(
      childResult.includes("FIXTURE_MCP_OK")
        ? "PARENT_MCP_CHILD_OK"
        : "PARENT_MCP_CHILD_RESULT_MISSING",
    ),
    { stopReason: "stop" },
  );
};
faux.setResponses(Array.from({ length: 8 }, () => respond));

const session = (
  await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  })
).session;
try {
  await session.bindExtensions({});
  await session.prompt("Delegate the deterministic fixture check.", {
    expandPromptTemplates: false,
  });
  const childResult = latestSubagentResult(session.messages) ?? "";
  process.stdout.write(
    JSON.stringify({
      parentResponse: session.getLastAssistantText(),
      childResult,
      childDetails: session.messages
        .filter((message) => message?.role === "toolResult" && message.toolName === "subagent")
        .map((message) => message.details),
      parentExtensions: loaded.extensions.map((extension) => ({
        path: extension.resolvedPath,
        source: extension.sourceInfo,
        tools: [...extension.tools.keys()],
      })),
    }) + "\n",
  );
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  rmSync(shimPath, { force: true });
}
