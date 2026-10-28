// Generated from extensions/subagents/src/shared/subagent-shortcuts.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { Key } from "@earendil-works/pi-tui";
export const SUBAGENT_LIVE_DETAIL_SHORTCUT = Key.ctrlShift("d");
export const SUBAGENT_PAUSE_ALL_SHORTCUT = Key.ctrlShift("u");
export function createSubagentLiveDetailController(initialExpanded = false) {
    let expanded = initialExpanded;
    return {
        isExpanded: () => expanded,
        toggle: () => {
            expanded = !expanded;
            return expanded;
        },
        setExpanded: (nextExpanded) => {
            expanded = nextExpanded;
            return expanded;
        },
    };
}
function formatShortcutDisplay(key) {
    return key
        .split("/")
        .map((binding) => binding
        .split("+")
        .map((part) => part.length === 1
        ? part.toUpperCase()
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join("+"))
        .join("/");
}
export function liveDetailShortcutDisplay() {
    return formatShortcutDisplay(SUBAGENT_LIVE_DETAIL_SHORTCUT);
}
