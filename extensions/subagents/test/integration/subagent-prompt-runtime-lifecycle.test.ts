import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  type Context,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
  SUBAGENT_SUPERVISOR_BRIDGE_ENV,
  SUBAGENT_TK_TICKET_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

const PROMPT_RUNTIME_PATH = fileURLToPath(
  new URL("../../src/runs/shared/subagent-prompt-runtime.ts", import.meta.url),
);
const REMINDER_CUSTOM_TYPE = "tlh-developer-scope-reminder";
const REMINDER_HEADER = "Developer scope reminder after compaction:";
const EXPECTED_REMINDER =
  "Developer scope reminder after compaction:\nRe-run `tk show tlhf-v4ul`, reread its acceptance criteria, and remain within the ticket's scope before continuing.";

interface LifecycleHarness {
  session: AgentSession;
  faux: ReturnType<typeof fauxProvider>;
  requestMessages: Array<Context["messages"]>;
  compactionEnds: Array<{
    reason: "manual" | "threshold" | "overflow";
    willRetry: boolean;
    aborted: boolean;
  }>;
  settingsManager: SettingsManager;
  dispose: () => Promise<void>;
}

function recordResponse(
  requestMessages: Array<Context["messages"]>,
  text: string,
  options?: Parameters<typeof fauxAssistantMessage>[1],
): FauxResponseFactory {
  return (context) => {
    requestMessages.push(structuredClone(context.messages));
    return fauxAssistantMessage(text, options);
  };
}

async function createLifecycleHarness(options: {
  contextWindow: number;
  reserveTokens: number;
  responses: FauxResponseFactory[];
  requestMessages: Array<Context["messages"]>;
}): Promise<LifecycleHarness> {
  const root = mkdtempSync(path.join(os.tmpdir(), "tlh-subagent-compaction-lifecycle-"));
  const cwd = path.join(root, "cwd");
  const agentDir = path.join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = agentDir;
  process.env.USERPROFILE = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const faux = fauxProvider({
    provider: "faux-subagent-lifecycle",
    models: [{ id: "lifecycle", contextWindow: options.contextWindow, maxTokens: 100 }],
  });
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    authPath: path.join(agentDir, "auth.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(options.responses);

  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: options.reserveTokens,
      keepRecentTokens: 1,
    },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [PROMPT_RUNTIME_PATH],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a pinned developer lifecycle test agent.",
  });
  await loader.reload();

  let session: AgentSession | undefined;
  try {
    session = (
      await createAgentSession({
        cwd,
        agentDir,
        model: faux.getModel(),
        modelRuntime,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
        noTools: "all",
      })
    ).session;
    const compactionEnds: LifecycleHarness["compactionEnds"] = [];
    session.subscribe((event) => {
      if (event.type !== "compaction_end") return;
      compactionEnds.push({
        reason: event.reason,
        willRetry: event.willRetry,
        aborted: event.aborted,
      });
    });
    await session.bindExtensions({});

    let disposed = false;
    return {
      session,
      faux,
      requestMessages: options.requestMessages,
      compactionEnds,
      settingsManager,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        try {
          await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } catch {
          // The session may already be shut down during a failed test.
        }
        try {
          session?.dispose();
        } catch {
          // Disposal is best effort during test teardown.
        }
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try {
      session?.dispose();
    } catch {
      // Disposal is best effort during setup failure.
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      return (part as { type?: unknown; text?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "";
    })
    .join("");
}

function reminderTexts(messages: readonly unknown[]): string[] {
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const candidate = message as { content?: unknown };
    const text = contentText(candidate.content);
    return text.includes(REMINDER_HEADER) ? [text] : [];
  });
}

function persistedReminderTexts(session: AgentSession): string[] {
  return session.messages.flatMap((message) => {
    if (message.role !== "custom" || message.customType !== REMINDER_CUSTOM_TYPE) return [];
    return [contentText(message.content)];
  });
}

function assistantCount(session: AgentSession): number {
  return session.messages.filter((message) => message.role === "assistant").length;
}

const ENVIRONMENT_KEYS = [
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
  SUBAGENT_SUPERVISOR_BRIDGE_ENV,
  SUBAGENT_TK_TICKET_ID_ENV,
] as const;

it("follows the pinned Pi compaction lifecycle for threshold and overflow reminders", async () => {
  const environment = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  const harnesses: LifecycleHarness[] = [];
  process.env[SUBAGENT_CHILD_AGENT_ENV] = "developer";
  process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = "1";
  process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV] = "0";
  process.env[SUBAGENT_TK_TICKET_ID_ENV] = "tlhf-v4ul";

  try {
    const thresholdRequests: Array<Context["messages"]> = [];
    const threshold = await createLifecycleHarness({
      contextWindow: 500,
      reserveTokens: 450,
      responses: [
        recordResponse(thresholdRequests, "initial response"),
        recordResponse(thresholdRequests, "default summary"),
        recordResponse(thresholdRequests, "after the next real prompt"),
      ],
      requestMessages: thresholdRequests,
    });
    harnesses.push(threshold);

    await threshold.session.prompt("first prompt", { expandPromptTemplates: false });
    assert.equal(threshold.faux.state.callCount, 2);
    assert.deepEqual(threshold.compactionEnds, [
      { reason: "threshold", willRetry: false, aborted: false },
    ]);
    assert.equal(assistantCount(threshold.session), 1);
    assert.equal(persistedReminderTexts(threshold.session).length, 0);
    const summary = threshold.session.messages.find(
      (message) => message.role === "compactionSummary",
    );
    assert.ok(summary);
    assert.match(String((summary as { summary?: unknown }).summary), /default summary/);

    threshold.settingsManager.setCompactionEnabled(false);
    await threshold.session.prompt("next real prompt", { expandPromptTemplates: false });
    assert.equal(threshold.faux.state.callCount, 3);
    assert.equal(assistantCount(threshold.session), 2);
    assert.equal(persistedReminderTexts(threshold.session).length, 1);
    assert.deepEqual(reminderTexts(threshold.requestMessages[2] ?? []), [EXPECTED_REMINDER]);

    const overflowRequests: Array<Context["messages"]> = [];
    const overflow = await createLifecycleHarness({
      contextWindow: 500,
      reserveTokens: 0,
      responses: [
        recordResponse(overflowRequests, "overflow response", {
          stopReason: "error",
          errorMessage: "The request exceeds the context window",
        }),
        recordResponse(overflowRequests, "default overflow summary"),
        recordResponse(overflowRequests, "retried response"),
      ],
      requestMessages: overflowRequests,
    });
    harnesses.push(overflow);

    await overflow.session.prompt("overflow prompt", { expandPromptTemplates: false });
    assert.equal(overflow.faux.state.callCount, 3);
    assert.deepEqual(overflow.compactionEnds, [
      { reason: "overflow", willRetry: true, aborted: false },
    ]);
    assert.equal(persistedReminderTexts(overflow.session).length, 1);
    assert.equal(reminderTexts(overflow.requestMessages[2] ?? []).length, 1);
  } finally {
    for (const harness of harnesses.reverse()) await harness.dispose();
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
