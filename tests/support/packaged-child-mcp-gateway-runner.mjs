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
// In async-only mode the dispatch returns a receipt. The real child output arrives via a
// notification-driven turn (triggered when the background runner completes). The respond
// function handles three turns: dispatch → receipt acknowledgement → notification check.
const respond = async (context) => {
  // Notification turn: [tlh] nudge appears in user messages when the background run completes.
  const allUserText = context.messages
    .filter((m) => m?.role === "user")
    .map((m) => textContent(m.content))
    .join("\n");
  if (allUserText.includes("[tlh]")) {
    return fauxAssistantMessage(
      fauxText(
        allUserText.includes("FIXTURE_MCP_OK")
          ? "PARENT_MCP_CHILD_OK"
          : "PARENT_MCP_CHILD_RESULT_MISSING",
      ),
      { stopReason: "stop" },
    );
  }

  // Receipt turn: acknowledge the launch receipt and wait for the notification.
  const childResult = latestSubagentResult(context.messages);
  if (childResult !== undefined) {
    return fauxAssistantMessage(fauxText("Launch receipt acknowledged."), { stopReason: "stop" });
  }

  // Turn 1: dispatch the subagent.
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
};
faux.setResponses(Array.from({ length: 12 }, () => respond));

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

// Subscribe before binding extensions so fast-child notifications are not missed.
let agentSettledCount = 0;
let notifyCount = 0;
let resolveNotifyTurn;
let rejectNotifyTurn;
const notifyTurnDone = new Promise((resolve, reject) => {
  resolveNotifyTurn = resolve;
  rejectNotifyTurn = reject;
});
session.subscribe((event) => {
  if (
    event.type === "message_start" &&
    event.message?.role === "custom" &&
    event.message?.customType === "subagent-notify"
  ) {
    notifyCount++;
  }
  if (event.type === "agent_settled") {
    agentSettledCount++;
    if (agentSettledCount >= 2 && notifyCount > 0) {
      resolveNotifyTurn();
    }
  }
});

try {
  await session.bindExtensions({ mode: "tui" });
  await session.prompt("Delegate the deterministic fixture check.", {
    expandPromptTemplates: false,
  });
  // Wait for the notification-driven turn (background child completes → result watcher fires).
  let notifyTimeoutHandle;
  try {
    await Promise.race([
      notifyTurnDone,
      new Promise((resolve) => {
        notifyTimeoutHandle = setTimeout(() => {
          rejectNotifyTurn(new Error("notification turn timed out after 90s"));
          resolve(undefined);
        }, 90_000);
      }),
    ]);
  } finally {
    clearTimeout(notifyTimeoutHandle);
  }
  // Extract child result from the subagent-notify message content.
  function latestNotifyContent(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "custom" && msg?.customType === "subagent-notify") {
        return typeof msg.content === "string" ? msg.content : textContent(msg.content);
      }
    }
    return "";
  }
  const childResult = latestNotifyContent(session.messages);
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
