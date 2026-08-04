import { Key } from "@earendil-works/pi-tui";
export const SUBAGENT_LIVE_DETAIL_SHORTCUT = Key.ctrlShift("d");
export const SUBAGENT_PAUSE_ALL_SHORTCUT = Key.ctrlShift("u");
export function createSubagentLiveDetailController(initialExpanded = false) {
    let expanded = initialExpanded;
    let generation = 0;
    const toolRows = new Map();
    let probedRendererStates = new WeakSet();
    let pendingProbes = new WeakMap();
    let activeProbe = null;
    const runProbe = (probe) => {
        if (generation !== probe.generation || pendingProbes.get(probe.rendererState) !== probe)
            return;
        pendingProbes.delete(probe.rendererState);
        const existing = toolRows.get(probe.toolCallId);
        let probeFailed = false;
        activeProbe = probe;
        try {
            probe.invalidate();
        }
        catch {
            probeFailed = true;
        }
        finally {
            if (activeProbe === probe)
                activeProbe = null;
        }
        if (generation !== probe.generation)
            return;
        if (probeFailed || !probe.reclaimed) {
            const registered = toolRows.get(probe.toolCallId);
            if (registered?.rendererState === probe.rendererState) {
                if (existing)
                    toolRows.set(probe.toolCallId, existing);
                else
                    toolRows.delete(probe.toolCallId);
            }
        }
    };
    const scheduleProbe = (toolCallId, rendererState, invalidate) => {
        const pending = pendingProbes.get(rendererState);
        if (pending?.generation === generation) {
            pending.toolCallId = toolCallId;
            pending.invalidate = invalidate;
            return;
        }
        if (probedRendererStates.has(rendererState))
            return;
        const probe = {
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
    const invalidateToolRows = () => {
        for (const row of toolRows.values()) {
            try {
                row.invalidate();
            }
            catch {
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
        setExpanded: (nextExpanded) => {
            expanded = nextExpanded;
            invalidateToolRows();
            return expanded;
        },
        registerToolRow: (toolCallId, rendererState, invalidate) => {
            if (activeProbe?.generation === generation
                && activeProbe.toolCallId === toolCallId
                && activeProbe.rendererState === rendererState) {
                toolRows.set(toolCallId, { rendererState, invalidate });
                activeProbe.reclaimed = true;
                return true;
            }
            const existing = toolRows.get(toolCallId);
            if (existing?.rendererState === rendererState) {
                toolRows.set(toolCallId, { rendererState, invalidate });
                return true;
            }
            scheduleProbe(toolCallId, rendererState, invalidate);
            return false;
        },
        clearToolRows: () => {
            generation++;
            toolRows.clear();
            probedRendererStates = new WeakSet();
            pendingProbes = new WeakMap();
            activeProbe = null;
        },
    };
}
export function formatShortcutDisplay(key) {
    return key
        .split("/")
        .map((binding) => binding
        .split("+")
        .map((part) => part.length === 1 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join("+"))
        .join("/");
}
export function liveDetailShortcutDisplay() {
    return formatShortcutDisplay(SUBAGENT_LIVE_DETAIL_SHORTCUT);
}
export function pauseAllShortcutDisplay() {
    return formatShortcutDisplay(SUBAGENT_PAUSE_ALL_SHORTCUT);
}
export function subagentRunningHintText() {
    return `Press ${liveDetailShortcutDisplay()} for live detail · ${pauseAllShortcutDisplay()} pauses all`;
}
