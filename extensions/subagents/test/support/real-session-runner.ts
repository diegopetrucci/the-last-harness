import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  type FauxContentBlock,
  type TranscriptContext,
  type FauxResponseFactory,
  getCurrentTools,
  type JsonObject,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  fauxProvider,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type ScaledMs, scaleTestTimeout } from "./scale-timeout.ts";

const EXTENSION_PATH = fileURLToPath(new URL("../../src/extension/index.ts", import.meta.url));
const CHILD_CLI_PATH = fileURLToPath(new URL("./real-session-child-cli.mjs", import.meta.url));

export type FauxReply = string | FauxContentBlock | FauxContentBlock[] | AssistantMessage;
export type FauxResponder = (
  context: TranscriptContext,
  state: { callCount: number },
) => FauxReply | Promise<FauxReply>;

export interface RealSessionRunOptions {
  prompt: string;
  childText: string;
  respond: FauxResponder;
  timeoutMs?: number;
  /** Optional callback to write fixtures into the temp cwd and home directories before the session starts. */
  setup?: (dirs: { cwd: string; home: string }) => void;
  /**
   * Extension mode to bind on the parent session. Defaults to "tui" (interactive).
   * Pass "print" to simulate an SDK/embedded session that should receive the
   * non-interactive rejection when it attempts subagent dispatch.
   */
  extensionMode?: "tui" | "rpc" | "json" | "print";
}

export interface RealSessionRun {
  responseText: string;
  parentSession: AgentSession;
  modelCalls: number;
  dispose: () => Promise<void>;
}

export function subagentCall(args: JsonObject, id = "call-subagent-e2e"): ToolCall {
  return fauxToolCall("subagent", args, { id });
}

export function routeParentThroughSubagent(input: {
  childMarker: string;
  subagentArgs: JsonObject;
}): FauxResponder {
  return (context) => {
    const isParent = getCurrentTools(context.messages).some((tool) => tool.name === "subagent");
    if (!isParent) return "Unexpected non-parent model call.";
    const resultText = latestSubagentToolResultText(
      context.messages as Array<{ role?: string; toolName?: string; content?: unknown }>,
    );
    if (resultText !== undefined) {
      return `Parent relays: ${resultText.includes(input.childMarker) ? input.childMarker : "CHILD_MISSING"}`;
    }
    return subagentCall(input.subagentArgs);
  };
}

export function subagentToolResults(session: AgentSession): string[] {
  const results: string[] = [];
  for (const message of session.messages) {
    if (message.role !== "toolResult") continue;
    if ((message as { toolName?: string }).toolName !== "subagent") continue;
    results.push(textFromContent((message as { content?: unknown }).content));
  }
  return results;
}

export function subagentToolResultDetails(session: AgentSession): unknown[] {
  const details: unknown[] = [];
  for (const message of session.messages) {
    if (message.role !== "toolResult") continue;
    if ((message as { toolName?: string }).toolName !== "subagent") continue;
    details.push((message as { details?: unknown }).details);
  }
  return details;
}

/**
 * Return all `subagent-notify` custom messages from the session transcript.
 * These are emitted by the result-watcher when an async child run completes.
 */
export function subagentNotifyMessages(session: AgentSession): Array<{ details: unknown }> {
  const entries: Array<{ details: unknown }> = [];
  for (const message of session.messages) {
    if (
      (message as { role?: string }).role === "custom" &&
      (message as { customType?: string }).customType === "subagent-notify"
    ) {
      entries.push({ details: (message as { details?: unknown }).details });
    }
  }
  return entries;
}

/**
 * Additional run data returned by {@link runRealAsyncSubagentSession}.
 * Extends the base result with async-lifecycle-specific fields.
 */
export interface RealAsyncSessionRun extends RealSessionRun {
  /** Text produced by the parent during the initial tool call + receipt acknowledgement turn. */
  receiptTurnText: string;
  /** Text produced by the parent during the notification-driven follow-up turn. */
  notifyTurnText: string;
  /** Number of `subagent-notify` messages observed in the session during the full lifecycle. */
  notifyCount: number;
  /**
   * Number of notification-driven parent turns (agent_settled events after the first receipt
   * turn). Should be exactly 1 for a well-behaved async lifecycle.
   */
  notifyTurnCount: number;
}

/**
 * Faux responder for async subagent lifecycle tests.
 *
 * Turn 1: parent has the `subagent` tool and no prior tool result → emits an async tool call.
 * Turn 2: parent sees the launch receipt (asyncId present, no child output) → acknowledges.
 * Turn 3: the `[tlh]` nudge is present (notification-driven turn) → relays the child marker.
 */
export function routeParentThroughAsyncSubagent(input: {
  childMarker: string;
  subagentArgs: JsonObject;
  /** When true, dispatches without async:true (uses the default background behavior). */
  omitAsync?: boolean;
}): FauxResponder {
  return (context) => {
    const messages = context.messages as Array<{
      role?: string;
      content?: unknown;
      toolName?: string;
    }>;
    const isParent = getCurrentTools(context.messages).some((tool) => tool.name === "subagent");
    if (!isParent) return "Unexpected non-parent model call.";

    // Detect the notification-driven turn: the `[tlh]` nudge text has arrived.
    const allUserText = messages
      .filter((m) => m.role === "user")
      .map((m) => textFromContent(m.content))
      .join("\n");

    if (allUserText.includes("[tlh]")) {
      // Relay the child marker if it appears in the notification content.
      const hasMarker = allUserText.includes(input.childMarker);
      return `Parent relays async: ${hasMarker ? input.childMarker : "CHILD_MISSING"}`;
    }

    // Turn 2: launch receipt is the only tool result (asyncId present, no child output).
    const toolResult = latestSubagentToolResultText(messages);
    if (toolResult !== undefined) {
      return "Launch receipt acknowledged.";
    }

    // Turn 1: dispatch the async subagent call.
    // When omitAsync is true, async is omitted (default background behavior).
    const dispatchArgs = input.omitAsync
      ? { ...input.subagentArgs }
      : { ...input.subagentArgs, async: true };
    return subagentCall(dispatchArgs);
  };
}

function latestSubagentToolResultText(
  messages: Array<{ role?: string; toolName?: string; content?: unknown }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "toolResult" && message.toolName === "subagent") {
      return textFromContent(message.content);
    }
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

function toAssistantMessage(reply: FauxReply): AssistantMessage {
  if (reply && typeof reply === "object" && "role" in reply) return reply as AssistantMessage;
  const content: FauxContentBlock[] =
    typeof reply === "string" ? [fauxText(reply)] : Array.isArray(reply) ? reply : [reply];
  const hasToolCall = content.some((block) => (block as { type?: string }).type === "toolCall");
  return fauxAssistantMessage(content, { stopReason: hasToolCall ? "toolUse" : "stop" });
}

interface ChildPiShim {
  /** Path to the installed shim binary (platform-appropriate). */
  shimBinaryPath: string;
  /** Undo shim installation and restore PATH / env / argv. */
  uninstall: () => void;
}

function installChildPiShim(childText: string): ChildPiShim {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "pi-real-session-cli-"));
  const binDir = path.join(rootDir, "bin");
  const previousPath = process.env.PATH;
  const previousChildText = process.env.PI_SUBAGENTS_E2E_CHILD_TEXT;
  const previousArgv1 = process.argv[1];

  writeFileSync(path.join(rootDir, ".keep"), "");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(binDir, "pi"),
    `#!/bin/sh\nexec "${process.execPath}" "${CHILD_CLI_PATH}" "$@"\n`,
    {
      mode: 0o755,
    },
  );
  writeFileSync(
    path.join(binDir, "pi.cmd"),
    `@echo off\r\n"${process.execPath}" "${CHILD_CLI_PATH}" %*\r\n`,
  );

  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  process.env.PI_SUBAGENTS_E2E_CHILD_TEXT = childText;
  if (process.platform === "win32") process.argv[1] = CHILD_CLI_PATH;

  // Platform-appropriate path to the shim binary. Used by callers to set
  // PI_SUBAGENT_PI_BINARY so that the fork's pi-spawn resolution (which
  // prefers the installed @earendil-works/pi-coding-agent CLI over PATH) is
  // bypassed in favour of this test shim.
  const shimBinaryPath = path.join(binDir, process.platform === "win32" ? "pi.cmd" : "pi");

  return {
    shimBinaryPath,
    uninstall: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousChildText === undefined) delete process.env.PI_SUBAGENTS_E2E_CHILD_TEXT;
      else process.env.PI_SUBAGENTS_E2E_CHILD_TEXT = previousChildText;
      if (process.platform === "win32") {
        if (previousArgv1 === undefined) delete process.argv[1];
        else process.argv[1] = previousArgv1;
      }
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [name, value] of snapshot) setEnv(name, value);
}

export async function runRealSubagentSession(
  options: RealSessionRunOptions,
): Promise<RealSessionRun> {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-real-session-cwd-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-real-session-home-"));
  const previousCwd = process.cwd();
  const envSnapshot = new Map([
    ["HOME", process.env.HOME],
    ["USERPROFILE", process.env.USERPROFILE],
    ["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR],
    ["PI_SUBAGENT_EXTRA_AGENT_DIRS", process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS],
    ["PI_SUBAGENT_CHILD", process.env.PI_SUBAGENT_CHILD],
    ["PI_SUBAGENT_FANOUT_CHILD", process.env.PI_SUBAGENT_FANOUT_CHILD],
    ["PI_SUBAGENT_DEPTH", process.env.PI_SUBAGENT_DEPTH],
    ["PI_SUBAGENT_MAX_DEPTH", process.env.PI_SUBAGENT_MAX_DEPTH],
    ["PI_SUBAGENT_PARENT_SESSION", process.env.PI_SUBAGENT_PARENT_SESSION],
    ["PI_SUBAGENT_PI_BINARY", process.env.PI_SUBAGENT_PI_BINARY],
    [
      "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
      process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT,
    ],
  ]);
  const { shimBinaryPath, uninstall: uninstallChildPi } = installChildPiShim(options.childText);
  let session: AgentSession | undefined;
  let modelRuntime: ModelRuntime | undefined;
  let faux: ReturnType<typeof fauxProvider> | undefined;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      // The session may already be shut down by the child-process fixture.
    }
    try {
      session?.dispose();
    } catch {
      // Disposal is best effort during test teardown.
    }
    uninstallChildPi();
    restoreEnv(envSnapshot);
    try {
      process.chdir(previousCwd);
    } catch {
      // The temporary cwd may already have been removed by a failed fixture.
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };

  try {
    options.setup?.({ cwd, home });
    process.chdir(cwd);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PI_CODING_AGENT_DIR = home;
    delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_FANOUT_CHILD;
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_MAX_DEPTH;
    delete process.env.PI_SUBAGENT_PARENT_SESSION;
    // Set PI_SUBAGENT_PI_BINARY to the shim binary so the fork's pi-spawn
    // resolution (which resolves the installed @earendil-works/pi-coding-agent
    // CLI instead of using PATH) falls back to this test shim. This env var has
    // top-priority in getPiSpawnCommand for both upstream and the fork.
    process.env.PI_SUBAGENT_PI_BINARY = shimBinaryPath;
    delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;

    faux = fauxProvider({
      provider: "faux-e2e-parent",
      models: [{ id: "parent", contextWindow: 200_000 }],
    });
    modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      authPath: path.join(home, "auth.json"),
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = faux.getModel();
    const respond = options.respond;
    const responseFactory: FauxResponseFactory = async (context, _streamOptions, state) =>
      toAssistantMessage(await respond(context, state));
    faux.setResponses(Array.from({ length: 8 }, () => responseFactory));

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: home,
      settingsManager,
      additionalExtensionPaths: [EXTENSION_PATH],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt:
        "You are an E2E parent. Delegate with the subagent tool, then report the tool result.",
    });
    await loader.reload();

    const created = await createAgentSession({
      cwd,
      agentDir: home,
      model,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.create(cwd, path.join(home, "sessions")),
      settingsManager,
    });
    session = created.session;
    session.setSessionName("real-session-e2e-parent");

    let responseText = "";
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_start") responseText = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        responseText += event.assistantMessageEvent.delta;
      }
    });

    await session.bindExtensions({ mode: options.extensionMode ?? "tui" });
    const timeoutMs = options.timeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.prompt(options.prompt, { expandPromptTemplates: false }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`real-session E2E timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }

    return {
      responseText: responseText.trim() || session.getLastAssistantText()?.trim() || "",
      parentSession: session,
      modelCalls: faux.state.callCount,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/**
 * Run an async subagent lifecycle E2E test.
 *
 * Like {@link runRealSubagentSession} but keeps the session subscription alive
 * after the initial prompt (launch receipt turn) and waits for the
 * notification-driven parent turn triggered by the background completion nudge.
 * The full wait is bounded by `notificationTimeoutMs` (default 60 s, scaled by
 * `TLH_TEST_TIMEOUT_SCALE` if set).
 */
export async function runRealAsyncSubagentSession(
  options: RealSessionRunOptions & { notificationTimeoutMs?: ScaledMs },
): Promise<RealAsyncSessionRun> {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-real-session-async-cwd-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-real-session-async-home-"));
  const previousCwd = process.cwd();
  const envSnapshot = new Map([
    ["HOME", process.env.HOME],
    ["USERPROFILE", process.env.USERPROFILE],
    ["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR],
    ["PI_SUBAGENT_EXTRA_AGENT_DIRS", process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS],
    ["PI_SUBAGENT_CHILD", process.env.PI_SUBAGENT_CHILD],
    ["PI_SUBAGENT_FANOUT_CHILD", process.env.PI_SUBAGENT_FANOUT_CHILD],
    ["PI_SUBAGENT_DEPTH", process.env.PI_SUBAGENT_DEPTH],
    ["PI_SUBAGENT_MAX_DEPTH", process.env.PI_SUBAGENT_MAX_DEPTH],
    ["PI_SUBAGENT_PARENT_SESSION", process.env.PI_SUBAGENT_PARENT_SESSION],
    ["PI_SUBAGENT_PI_BINARY", process.env.PI_SUBAGENT_PI_BINARY],
    [
      "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
      process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT,
    ],
  ]);
  const { shimBinaryPath, uninstall: uninstallChildPi } = installChildPiShim(options.childText);
  let session: AgentSession | undefined;
  let modelRuntime: ModelRuntime | undefined;
  let faux: ReturnType<typeof fauxProvider> | undefined;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      // The session may already be shut down by the child-process fixture.
    }
    try {
      session?.dispose();
    } catch {
      // Disposal is best effort during test teardown.
    }
    uninstallChildPi();
    restoreEnv(envSnapshot);
    try {
      process.chdir(previousCwd);
    } catch {
      // The temporary cwd may already have been removed by a failed fixture.
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };

  try {
    options.setup?.({ cwd, home });
    process.chdir(cwd);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PI_CODING_AGENT_DIR = home;
    delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_FANOUT_CHILD;
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_MAX_DEPTH;
    delete process.env.PI_SUBAGENT_PARENT_SESSION;
    process.env.PI_SUBAGENT_PI_BINARY = shimBinaryPath;
    delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;

    faux = fauxProvider({
      provider: "faux-e2e-async-parent",
      models: [{ id: "async-parent", contextWindow: 200_000 }],
    });
    modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      authPath: path.join(home, "auth.json"),
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = faux.getModel();
    const respond = options.respond;
    const responseFactory: FauxResponseFactory = async (context, _streamOptions, state) =>
      toAssistantMessage(await respond(context, state));
    faux.setResponses(Array.from({ length: 12 }, () => responseFactory));

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: home,
      settingsManager,
      additionalExtensionPaths: [EXTENSION_PATH],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt:
        "You are an E2E parent. Delegate async with the subagent tool, then acknowledge the receipt and later relay the completion report.",
    });
    await loader.reload();

    const created = await createAgentSession({
      cwd,
      agentDir: home,
      model,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.create(cwd, path.join(home, "sessions")),
      settingsManager,
    });
    session = created.session;
    session.setSessionName("real-session-async-e2e-parent");

    // Tracking for both turns. The subscriber MUST be set up before
    // session.prompt() so that fast-child completions (where the notification
    // arrives during the initial prompt) are not missed.
    let receiptTurnText = "";
    let notifyTurnText = "";
    let notifyCount = 0;
    let currentText = "";
    let agentSettledCount = 0;

    let resolveNotifyTurn: (() => void) | undefined;
    let rejectNotifyTurn: ((e: Error) => void) | undefined;
    const notifyTurnDone = new Promise<void>((res, rej) => {
      resolveNotifyTurn = res;
      rejectNotifyTurn = rej;
    });

    // Subscribe before binding extensions so every event is captured.
    const unsub = session.subscribe((event: AgentSessionEvent) => {
      // pi.sendMessage({ customType: "subagent-notify" }) emits message_start/message_end,
      // NOT entry_appended. Detect the notify via message_start.
      if (
        event.type === "message_start" &&
        (event.message as { role?: string }).role === "custom" &&
        (event.message as { customType?: string }).customType === "subagent-notify"
      ) {
        notifyCount++;
      }

      if (event.type === "message_start") {
        currentText = "";
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        currentText += event.assistantMessageEvent.delta;
      }

      if (event.type === "agent_settled") {
        agentSettledCount++;
        const settled =
          currentText.trim() || (session as AgentSession).getLastAssistantText()?.trim() || "";
        if (agentSettledCount === 1) {
          receiptTurnText = settled;
        } else {
          // Second+ settle: this is the notification-driven turn (or a later one).
          // Capture text and resolve only if we already saw a notify.
          notifyTurnText = settled;
          if (notifyCount > 0) {
            resolveNotifyTurn?.();
          }
        }
      }
    });

    await session.bindExtensions({ mode: "tui" });

    const initialTimeoutMs = options.timeoutMs ?? 30_000;
    let initialTimer: ReturnType<typeof setTimeout> | undefined;

    // Run the initial prompt (tool call → launch receipt → acknowledgement).
    try {
      await Promise.race([
        session.prompt(options.prompt, { expandPromptTemplates: false }),
        new Promise<never>((_, reject) => {
          initialTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `real-session async E2E initial prompt timed out after ${initialTimeoutMs}ms`,
                ),
              ),
            initialTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (initialTimer) clearTimeout(initialTimer);
    }

    // If the notification turn resolved during the initial prompt (fast child),
    // notifyTurnDone is already settled. Otherwise wait for it.
    const notifyTimeoutMs = options.notificationTimeoutMs ?? scaleTestTimeout(60_000);
    let notifyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        notifyTurnDone,
        new Promise<never>(() => {
          notifyTimer = setTimeout(() => {
            rejectNotifyTurn?.(
              new Error(
                `real-session async E2E notification-driven turn timed out after ${notifyTimeoutMs}ms (notifyCount=${notifyCount}, agentSettledCount=${agentSettledCount})`,
              ),
            );
          }, notifyTimeoutMs);
        }),
      ]);
    } finally {
      if (notifyTimer) clearTimeout(notifyTimer);
      unsub();
    }

    const fauxState = (faux as ReturnType<typeof fauxProvider>).state;

    return {
      responseText: notifyTurnText || session.getLastAssistantText()?.trim() || "",
      receiptTurnText,
      notifyTurnText,
      notifyCount,
      notifyTurnCount: Math.max(0, agentSettledCount - 1),
      parentSession: session,
      modelCalls: fauxState.callCount,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
