export function handleSubagentLiveDetailShortcut(controller, ctx, rerenderWidget) {
    const expanded = controller.toggle();
    if (ctx.hasUI)
        rerenderWidget?.();
    return expanded;
}
