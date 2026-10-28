import { Key } from "@earendil-works/pi-tui";

export const SUBAGENT_LIVE_DETAIL_SHORTCUT = Key.ctrlShift("d");
export const SUBAGENT_PAUSE_ALL_SHORTCUT = Key.ctrlShift("u");

export interface SubagentLiveDetailController {
  isExpanded(): boolean;
  toggle(): boolean;
  setExpanded(expanded: boolean): boolean;
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
  return {
    isExpanded: () => expanded,
    toggle: () => {
      expanded = !expanded;
      return expanded;
    },
    setExpanded: (nextExpanded: boolean) => {
      expanded = nextExpanded;
      return expanded;
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
