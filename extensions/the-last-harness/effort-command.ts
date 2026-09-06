import {
  ThinkingSelectorComponent,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { formatHomePath, isRecord, readText } from "./common.js";
import { safeTlhProfileFilePath, withLockedTlhSettingsWrite } from "./profile-state.js";
import type { TlhPrimaryAgentRuntime } from "./primary-agent-runtime.js";
import {
  getAvailableThinkingLevels,
  isThinkingLevel,
  setExtensionThinkingLevel,
} from "./thinking.js";
import type { ReasoningModel, ThinkingLevel } from "./types.js";

type TlhThinkingDefaultWriteResult = {
  settingsPath: string;
  backupPath?: string;
  changed: boolean;
};

type ThinkingPickerResult = {
  level: ThinkingLevel;
  persisted: boolean;
};

function parseSettingsObject(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
  if (!isRecord(parsed)) {
    throw new Error("settings.json must contain a JSON object");
  }
  return parsed;
}

function readTlhThinkingDefault(): ThinkingLevel | undefined {
  const settingsPath = safeTlhProfileFilePath("settings.json");
  const content = settingsPath ? readText(settingsPath) : undefined;
  if (!content || !content.trim()) {
    return undefined;
  }
  try {
    const settings = parseSettingsObject(content);
    const level = settings.defaultThinkingLevel;
    return typeof level === "string" && isThinkingLevel(level) ? level : undefined;
  } catch {
    return undefined;
  }
}

/** Persist a thinking default only in the guarded isolated TLH profile. */
export function persistTlhThinkingDefault(
  cwd: string,
  level: ThinkingLevel,
): TlhThinkingDefaultWriteResult {
  return withLockedTlhSettingsWrite(
    cwd,
    "Refusing to write thinking defaults outside the isolated TLH profile.",
    (current) => {
      const settings = current && current.trim() ? parseSettingsObject(current) : {};
      if (settings.defaultThinkingLevel === level) {
        return { changed: false };
      }
      return {
        changed: true,
        nextContent: `${JSON.stringify({ ...settings, defaultThinkingLevel: level }, null, 2)}\n`,
      };
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBackupNotice(result: TlhThinkingDefaultWriteResult): string {
  return result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
}

export async function handleThinkingLevelCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  runtime?: TlhPrimaryAgentRuntime,
): Promise<void> {
  const currentLevel = pi.getThinkingLevel();
  const availableLevels = getAvailableThinkingLevels(ctx.model as ReasoningModel | undefined);
  const requestedLevel = args.trim().toLowerCase();

  if (requestedLevel) {
    if (!isThinkingLevel(requestedLevel)) {
      ctx.ui.notify(
        `Unknown thinking level "${args.trim()}". Available: ${availableLevels.join(", ")}.`,
        "error",
      );
      return;
    }
    if (!availableLevels.includes(requestedLevel)) {
      ctx.ui.notify(
        `Thinking level "${requestedLevel}" is not available for the current model. Available: ${availableLevels.join(", ")}.`,
        "warning",
      );
      return;
    }
    setExtensionThinkingLevel(pi, requestedLevel);
    runtime?.recordUserThinkingLevel?.(pi.getThinkingLevel());
    ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()} for this session.`, "info");
    return;
  }

  const pickerLevels = availableLevels;

  if (pickerLevels.length === 0) {
    ctx.ui.notify("No thinking levels are available for the current model.", "warning");
    return;
  }

  // `ThinkingSelectorComponent` is a public Pi component. It owns the picker
  // and visibly documents Enter (session), the `app.thinking.save` keybinding
  // (Ctrl+S by default, configurable since 0.85.1) to set as default, and
  // `tui.select.cancel` (Escape/Ctrl+C) to cancel. TLH deliberately keeps the
  // persistence callback separate so Pi's ExtensionAPI setter can never write
  // an unguarded default.
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") {
    ctx.ui.notify(
      `Available thinking levels: ${pickerLevels.join(", ")}. Current: ${currentLevel}.`,
      "info",
    );
    return;
  }

  try {
    await ctx.ui.custom<ThinkingPickerResult | undefined>((_tui, _theme, _keybindings, done) => {
      let savingDefault = false;

      const selectForSession = (level: ThinkingLevel): void => {
        try {
          setExtensionThinkingLevel(pi, level);
          const nextLevel = pi.getThinkingLevel();
          runtime?.recordUserThinkingLevel?.(nextLevel);
          ctx.ui.notify(`Thinking level set to ${nextLevel} for this session.`, "info");
          done({ level: nextLevel, persisted: false });
        } catch (error) {
          ctx.ui.notify(`Could not set thinking level: ${errorMessage(error)}`, "error");
          done(undefined);
        }
      };

      const selectAsDefault = (level: ThinkingLevel): void => {
        if (savingDefault) {
          return;
        }
        savingDefault = true;

        let nextLevel: ThinkingLevel;
        try {
          setExtensionThinkingLevel(pi, level);
          nextLevel = pi.getThinkingLevel();
          runtime?.recordUserThinkingLevel?.(nextLevel);
        } catch (error) {
          ctx.ui.notify(`Could not set thinking level: ${errorMessage(error)}`, "error");
          done(undefined);
          return;
        }

        void (async () => {
          try {
            const result = persistTlhThinkingDefault(ctx.cwd, nextLevel);
            ctx.ui.notify(
              `Thinking level set to ${nextLevel} and saved as the default for future sessions.${formatBackupNotice(result)}`,
              "info",
            );
            done({ level: nextLevel, persisted: true });
          } catch (error) {
            ctx.ui.notify(
              `Thinking level set to ${nextLevel} for this session only; TLH could not save the persistent default: ${errorMessage(error)}`,
              "warning",
            );
            done({ level: nextLevel, persisted: false });
          }
        })();
      };

      return new ThinkingSelectorComponent(
        currentLevel,
        pickerLevels,
        selectForSession,
        () => done(undefined),
        selectAsDefault,
        readTlhThinkingDefault(),
      );
    });
  } catch (error) {
    // A missing/broken TUI component must not change session or profile state.
    ctx.ui.notify(`Could not open thinking level picker: ${errorMessage(error)}`, "error");
  }
}
