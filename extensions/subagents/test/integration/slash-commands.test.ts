import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type RegisteredSlashCommand = {
  handler(args: string, ctx: unknown): Promise<void>;
  getArgumentCompletions?: (
    prefix: string,
  ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
};

interface EventBus {
  readonly emitted: string[];
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

interface RegisterSlashCommandsModule {
  registerSlashCommands?: (
    pi: {
      events: EventBus;
      getSessionName(): string | undefined;
      registerCommand(name: string, spec: RegisteredSlashCommand): void;
      sendMessage(message: unknown): void;
    },
    state: {
      baseCwd: string;
      currentSessionId: string | null;
      asyncJobs: Map<string, unknown>;
      cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
      lastUiContext: unknown;
      poller: NodeJS.Timeout | null;
      completionSeen: Map<string, number>;
      watcher: unknown;
      watcherRestartTimer: ReturnType<typeof setTimeout> | null;
      resultFileCoalescer: { schedule(file: string, delayMs?: number): boolean; clear(): void };
    },
    config: unknown,
  ) => void;
}

const SLASH_TEXT_RESULT_TYPE = "subagent-slash-text-result";

const slashCommandsModule: unknown = await import("../../src/slash/slash-commands.ts");
const { registerSlashCommands } = slashCommandsModule as RegisterSlashCommandsModule;
const available = true;

function createEventBus(): EventBus {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const emitted: string[] = [];
  return {
    emitted,
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(
          event,
          current.filter((entry) => entry !== handler),
        );
      };
    },
    emit(event, data) {
      emitted.push(event);
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
  };
}

function createState(cwd: string) {
  return {
    baseCwd: cwd,
    currentSessionId: null,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
}

function createCommandContext(
  overrides: Partial<{
    cwd: string;
    hasUI: boolean;
    sessionManager: unknown;
  }> = {},
) {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    hasUI: overrides.hasUI ?? false,
    ui: {
      notify: () => {},
      confirm: async () => false,
      setStatus: () => {},
      setToolsExpanded: () => {},
      onTerminalInput: () => () => {},
      custom: async () => undefined,
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    sessionManager: overrides.sessionManager ?? {
      getSessionFile: () => null,
      getSessionId: () => "session-test",
    },
  };
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-home-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function registerCommands(cwd: string, sent: unknown[] = [], config: unknown = {}) {
  const commands = new Map<string, RegisteredSlashCommand>();
  const events = createEventBus();
  const pi = {
    events,
    getSessionName: () => undefined,
    registerCommand(name: string, spec: RegisteredSlashCommand) {
      commands.set(name, spec);
    },
    sendMessage(message: unknown) {
      sent.push(message);
    },
  };
  registerSlashCommands!(pi as never, createState(cwd), config);
  return { commands, events, pi };
}

describe(
  "slash command registration",
  { skip: !available ? "slash-commands.ts not importable" : undefined },
  () => {
    it("registers only the doctor command", async () => {
      await withIsolatedHome(async () => {
        const { commands } = registerCommands(process.cwd());
        assert.deepEqual([...commands.keys()], ["subagents-doctor"]);
        assert.equal(commands.has("subagent-cost"), false);
        assert.equal(commands.has("subagents-fleet"), false);
      });
    });

    it("does not register removed workflow or mutating profile commands", async () => {
      await withIsolatedHome(async () => {
        const { commands } = registerCommands(process.cwd());
        for (const removed of [
          "run",
          "chain",
          "parallel",
          "run-chain",
          "subagents-load-profile",
          "subagents-refresh-provider-models",
          "subagents-generate-profiles",
          "subagents-status",
          "subagents-models",
          "subagents-profiles",
          "subagents-check-profile",
        ]) {
          assert.equal(commands.has(removed), false, `${removed} should not be registered`);
        }
      });
    });
  },
);

describe(
  "subagents-doctor slash command",
  {
    skip: !available ? "slash-commands.ts not importable" : undefined,
  },
  () => {
    it("runs diagnostics directly with the active context and renders plain text", async () => {
      await withIsolatedHome(async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-doctor-"));
        try {
          const sent: unknown[] = [];
          const config = { intercomBridge: { mode: "off" } };
          const { commands, events } = registerCommands(cwd, sent, config);
          const sessionFile = path.join(cwd, "sessions", "parent.jsonl");
          await commands.get("subagents-doctor")!.handler(
            "",
            createCommandContext({
              cwd,
              sessionManager: {
                getSessionFile: () => sessionFile,
                getSessionId: () => "session-active",
              },
            }),
          );

          assert.deepEqual(events.emitted, []);
          assert.equal(sent.length, 1);
          const message = sent[0] as {
            customType?: unknown;
            content?: unknown;
            display?: unknown;
            details?: unknown;
          };
          assert.equal(message.customType, SLASH_TEXT_RESULT_TYPE);
          assert.equal(message.display, true);
          assert.equal("details" in message, false);
          const content = String(message.content);
          assert.match(content, /^Subagents doctor report/);
          assert.ok(content.includes(`- cwd: ${cwd}`));
          assert.match(content, /- current session file: .*parent\.jsonl/);
          assert.match(content, /- current session id: session-active/);
          assert.ok(content.includes("- bridge: inactive (bridge mode is off)"));
        } finally {
          fs.rmSync(cwd, { recursive: true, force: true });
        }
      });
    });

    it("does not register the removed subagents-status overlay command", async () => {
      await withIsolatedHome(async () => {
        const { commands } = registerCommands(process.cwd());
        assert.equal(commands.has("subagents-status"), false);
      });
    });
  },
);
