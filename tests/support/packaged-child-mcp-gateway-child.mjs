import * as fs from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

function parseArgs(argv) {
  const parsed = { extensions: [], tools: undefined, prompt: "" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--tools") parsed.tools = (argv[++index] ?? "").split(",").filter(Boolean);
    else if (arg === "--extension") parsed.extensions.push(argv[++index]);
    else if (arg === "--session" || arg === "--session-dir" || arg === "--model") index++;
    else if (arg === "--no-session" || arg === "--no-skills" || arg === "--no-extensions") continue;
    else if (arg && !arg.startsWith("--")) parsed.prompt = arg;
  }
  return parsed;
}

function latestToolResult(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "toolResult") return messages[index];
  }
  return undefined;
}

function textContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required");
  const cwd = process.cwd();
  const faux = fauxProvider({
    provider: "faux-packaged-mcp-child",
    models: [{ id: "child", contextWindow: 200000 }],
  });
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    authPath: `${agentDir}/auth.json`,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.getModel();
  const respond = async (context) => {
    const last = latestToolResult(context.messages);
    if (!last) {
      return fauxAssistantMessage(
        fauxToolCall("mcp", { connect: "fixture" }, { id: "connect-fixture" }),
        { stopReason: "toolUse" },
      );
    }
    const text = textContent(last.content);
    if (text.includes("FIXTURE_MCP_OK")) {
      return fauxAssistantMessage(fauxText("FIXTURE_MCP_OK"), { stopReason: "stop" });
    }
    if (text.includes("fixture_read_fixture")) {
      return fauxAssistantMessage(
        fauxToolCall("mcp", { tool: "fixture_read_fixture", args: "{}" }, { id: "call-fixture" }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(fauxText("unexpected MCP result: " + text), { stopReason: "stop" });
  };
  faux.setResponses(Array.from({ length: 12 }, () => respond));

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: parsed.extensions,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: parsed.tools,
  });
  await session.bindExtensions({});

  const evidencePath = process.env.PI_SUBAGENTS_E2E_MCP_EVIDENCE;
  if (!evidencePath) throw new Error("PI_SUBAGENTS_E2E_MCP_EVIDENCE is required");
  fs.writeFileSync(
    evidencePath,
    JSON.stringify({
      env: {
        agentDir: process.env.PI_CODING_AGENT_DIR,
        child: process.env.PI_SUBAGENT_CHILD,
        mcpDirectTools: process.env.MCP_DIRECT_TOOLS,
      },
      argvTools: parsed.tools ?? [],
      activeTools: session.getActiveToolNames(),
      allTools: session.getAllTools().map((tool) => tool.name),
      extensions: loaded.extensions.map((extension) => ({
        path: extension.resolvedPath,
        tools: [...extension.tools.keys()],
      })),
    }) + "\n",
  );
  session.subscribe((event) => {
    if (
      event.type === "message_end" ||
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end" ||
      event.type === "tool_result_end"
    ) {
      process.stdout.write(JSON.stringify(event) + "\n");
    }
  });
  try {
    await session.prompt(parsed.prompt, { expandPromptTemplates: false });
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}

main().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.stack || error.message : String(error)) + "\n",
  );
  process.exit(1);
});
