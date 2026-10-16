// Generated from extensions/subagents/src/extension/live-detail-shortcut.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
export function handleSubagentLiveDetailShortcut(controller, ctx, rerenderWidget) {
    const expanded = controller.toggle();
    if (ctx.hasUI)
        rerenderWidget?.();
    return expanded;
}
