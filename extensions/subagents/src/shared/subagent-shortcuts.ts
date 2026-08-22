import { Key } from "@earendil-works/pi-tui";

export const SUBAGENT_LIVE_DETAIL_SHORTCUT = Key.ctrlShift("d");
export const SUBAGENT_PAUSE_ALL_SHORTCUT = Key.ctrlShift("u");

export interface SubagentLiveDetailController {
  isExpanded(): boolean;
  toggle(): boolean;
  setExpanded(expanded: boolean): boolean;
  /** Claim or refresh a confirmed renderer state, deferring one liveness probe for unknown states. */
  registerToolRow(toolCallId: string, rendererState: WeakKey, invalidate: () => void): boolean;
  clearToolRows(): void;
}

/**
 * Keep subagent live detail local to the current extension instance. Pi's
 * tool-output expansion is intentionally not part of this controller because
 * the shortcut has no focused tool-row identity.
 */
export function createSubagentLiveDetailController(
  initialExpanded = false,
): SubagentLiveDetailController {
  let expanded = initialExpanded;
  let generation = 0;
  const toolRows = new Map<string, { rendererState: WeakKey; invalidate: () => void }>();
  type Probe = {
    toolCallId: string;
    rendererState: WeakKey;
    invalidate: () => void;
    generation: number;
    reclaimed: boolean;
  };
  let probedRendererStates = new WeakSet<WeakKey>();
  let pendingProbes = new WeakMap<WeakKey, Probe>();
  let activeProbe: Probe | null = null;

  const runProbe = (probe: Probe): void => {
    if (generation !== probe.generation || pendingProbes.get(probe.rendererState) !== probe) return;
    pendingProbes.delete(probe.rendererState);

    const existing = toolRows.get(probe.toolCallId);
    let probeFailed = false;
    activeProbe = probe;
    try {
      probe.invalidate();
    } catch {
      probeFailed = true;
    } finally {
      if (activeProbe === probe) activeProbe = null;
    }

    // Session/tree cleanup may run from inside invalidation. Never let an old
    // probe restore or retain a row after its generation has been cleared.
    if (generation !== probe.generation) return;
    if (probeFailed || !probe.reclaimed) {
      const registered = toolRows.get(probe.toolCallId);
      if (registered?.rendererState === probe.rendererState) {
        if (existing) toolRows.set(probe.toolCallId, existing);
        else toolRows.delete(probe.toolCallId);
      }
    }
  };

  const scheduleProbe = (
    toolCallId: string,
    rendererState: WeakKey,
    invalidate: () => void,
  ): void => {
    const pending = pendingProbes.get(rendererState);
    if (pending?.generation === generation) {
      // Pi recreates the context wrapper on each render. Keep the latest
      // callback without scheduling another probe for the same state.
      pending.toolCallId = toolCallId;
      pending.invalidate = invalidate;
      return;
    }
    if (probedRendererStates.has(rendererState)) return;

    const probe: Probe = {
      toolCallId,
      rendererState,
      invalidate,
      generation,
      reclaimed: false,
    };
    probedRendererStates.add(rendererState);
    pendingProbes.set(rendererState, probe);
    queueMicrotask(() => runProbe(probe));
  };

  const invalidateToolRows = (): void => {
    for (const row of toolRows.values()) {
      try {
        row.invalidate();
      } catch {
        // A row can disappear between registration and a shortcut press.
      }
    }
  };

  return {
    isExpanded: () => expanded,
    toggle: () => {
      expanded = !expanded;
      invalidateToolRows();
      return expanded;
    },
    setExpanded: (nextExpanded: boolean) => {
      expanded = nextExpanded;
      invalidateToolRows();
      return expanded;
    },
    registerToolRow: (toolCallId: string, rendererState: WeakKey, invalidate: () => void) => {
      if (
        activeProbe?.generation === generation &&
        activeProbe.toolCallId === toolCallId &&
        activeProbe.rendererState === rendererState
      ) {
        // The deferred live invalidator synchronously re-enters here. Replacing
        // the map entry releases the detached component and its callback.
        toolRows.set(toolCallId, { rendererState, invalidate });
        activeProbe.reclaimed = true;
        return true;
      }

      const existing = toolRows.get(toolCallId);
      if (existing?.rendererState === rendererState) {
        toolRows.set(toolCallId, { rendererState, invalidate });
        return true;
      }

      // Returning non-live for this render preserves export behavior and avoids
      // mutating Pi's ToolExecutionComponent container during renderResult.
      scheduleProbe(toolCallId, rendererState, invalidate);
      return false;
    },
    clearToolRows: () => {
      generation++;
      toolRows.clear();
      probedRendererStates = new WeakSet<WeakKey>();
      pendingProbes = new WeakMap<WeakKey, Probe>();
      activeProbe = null;
    },
  };
}

function formatShortcutDisplay(key: string): string {
  return key
    .split("/")
    .map((binding) =>
      binding
        .split("+")
        .map((part) =>
          part.length === 1
            ? part.toUpperCase()
            : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
        )
        .join("+"),
    )
    .join("/");
}

export function liveDetailShortcutDisplay(): string {
  return formatShortcutDisplay(SUBAGENT_LIVE_DETAIL_SHORTCUT);
}
