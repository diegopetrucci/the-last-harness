import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  beginTlhModelSelectionDefaultSuppression,
  beginTlhThinkingLevelSelection,
  chooseTlhThinkingSelectionScope,
  discardTlhThinkingLevelSelection,
  endTlhThinkingLevelSelectionCapture,
  persistTlhStandaloneThinkingDefaults,
  persistTlhThinkingLevelSelection,
  replayTlhUnmatchedModelSelectionDefaults,
  runTlhThinkingChangeContext,
} from "./model-selection-scope.js";
import { selectProviderAwareAgentDefaults } from "./model-defaults.js";
import type { TlhPrimaryAgentRuntime } from "./primary-agent-runtime.js";
import {
  formatThinkingLevelOption,
  getAvailableThinkingLevels,
  isThinkingLevel,
  parseThinkingLevelOption,
  setExtensionThinkingLevel,
  thinkingLevelAtLeast,
} from "./thinking.js";
import type { ReasoningModel } from "./types.js";

export async function handleThinkingLevelCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  runtime?: TlhPrimaryAgentRuntime,
): Promise<void> {
  const primary = runtime?.activePrimaryAgentPrompt();

  if (primary?.lockThinking) {
    const defaults = selectProviderAwareAgentDefaults(primary, [], ctx.model?.provider);
    const level = defaults.thinking ?? "off";
    ctx.ui.notify(
      `Thinking is locked at "${level}" for the ${primary.name} primary agent.`,
      "error",
    );
    return;
  }

  const currentLevel = pi.getThinkingLevel();
  const availableLevels = getAvailableThinkingLevels(ctx.model as ReasoningModel | undefined);
  const requestedLevel = args.trim().toLowerCase();
  const minThinking = primary?.minThinking;

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
    if (minThinking !== undefined && !thinkingLevelAtLeast(requestedLevel, minThinking)) {
      ctx.ui.notify(`${primary!.name} requires at least ${minThinking} thinking.`, "error");
      return;
    }
    setExtensionThinkingLevel(pi, requestedLevel);
    runtime?.recordUserThinkingLevel?.(pi.getThinkingLevel());
    ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()}.`, "info");
    return;
  }

  const pickerLevels =
    minThinking !== undefined
      ? availableLevels.filter((level) => thinkingLevelAtLeast(level, minThinking))
      : availableLevels;

  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Available thinking levels: ${pickerLevels.join(", ")}. Current: ${currentLevel}.`,
      "info",
    );
    return;
  }

  const options = pickerLevels.map((level) => formatThinkingLevelOption(level, currentLevel));
  const selected = await ctx.ui.select("Pick thinking level", options);
  const selectedLevel = selected ? parseThinkingLevelOption(selected) : undefined;
  if (!selectedLevel) {
    return;
  }

  // Pi writes the profile default synchronously before emitting its async
  // thinking_level_select notification. Drain an earlier standalone write first
  // so the scope decision cannot reorder delayed extension events. A failed
  // native model-selector attempt is another bounded write that must be replayed
  // before this thinking-only capture takes ownership of the next write.
  await persistTlhStandaloneThinkingDefaults();
  replayTlhUnmatchedModelSelectionDefaults();
  const thinkingCapture = beginTlhThinkingLevelSelection();
  let thinkingSelection = thinkingCapture;
  try {
    try {
      runTlhThinkingChangeContext("interactive", () =>
        setExtensionThinkingLevel(pi, selectedLevel),
      );
    } finally {
      // Never leave process-global capture state open while awaiting the scope
      // picker. The bounded claim remains local to this command invocation.
      thinkingSelection = endTlhThinkingLevelSelectionCapture(thinkingCapture);
    }

    const nextLevel = pi.getThinkingLevel();
    if (nextLevel === currentLevel) {
      discardTlhThinkingLevelSelection(thinkingSelection);
      ctx.ui.notify(`Thinking level set to ${nextLevel}.`, "info");
      return;
    }

    // If the persistence shim is unavailable, preserve upstream behavior rather
    // than pretending a session-only choice can be made safely.
    if (!thinkingSelection) {
      runtime?.recordUserThinkingLevel?.(nextLevel);
      ctx.ui.notify(`Thinking level set to ${nextLevel}.`, "info");
      return;
    }

    const scope = await chooseTlhThinkingSelectionScope(ctx);
    if (scope === "cancel") {
      discardTlhThinkingLevelSelection(thinkingSelection);
      let resultingLevel: typeof currentLevel | undefined;
      const releaseDefaultSuppression = beginTlhModelSelectionDefaultSuppression();
      try {
        try {
          runTlhThinkingChangeContext("internal", () =>
            setExtensionThinkingLevel(pi, currentLevel),
          );
        } catch {
          // Verify the active level below even when the upstream setter fails or
          // applies only part of the restoration.
        }
      } finally {
        releaseDefaultSuppression();
      }
      try {
        resultingLevel = pi.getThinkingLevel();
      } catch {
        // A missing result is reported as unverifiable rather than as success.
      }
      if (resultingLevel === currentLevel) {
        ctx.ui.notify(
          `Kept thinking level at ${resultingLevel} after cancelling thinking selection.`,
          "info",
        );
      } else if (resultingLevel !== undefined) {
        ctx.ui.notify(
          `TLH could not restore thinking level to ${currentLevel} after cancelling thinking selection; active level remains ${resultingLevel}.`,
          "warning",
        );
      } else {
        ctx.ui.notify(
          `TLH could not verify the active thinking level after cancelling thinking selection; expected ${currentLevel}.`,
          "warning",
        );
      }
      return;
    }
    if (scope === "session-only") {
      discardTlhThinkingLevelSelection(thinkingSelection);
      runtime?.recordUserThinkingLevel?.(nextLevel);
      ctx.ui.notify(`Thinking level set to ${nextLevel} for this session.`, "info");
      return;
    }

    const persisted = await persistTlhThinkingLevelSelection(thinkingSelection);
    runtime?.recordUserThinkingLevel?.(nextLevel);
    if (!persisted) {
      ctx.ui.notify(
        `Thinking level set to ${nextLevel} for this session, but TLH could not update the persistent default.`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(`Thinking level set to ${nextLevel}.`, "info");
  } catch (error) {
    // Before an explicit scope decision, replay any captured upstream write on
    // unexpected failure rather than silently converting it to session-only.
    await persistTlhThinkingLevelSelection(thinkingSelection);
    throw error;
  }
}
