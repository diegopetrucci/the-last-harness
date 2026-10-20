// Generated from extensions/subagents/src/shared/recent-progress.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
export const RECENT_PROGRESS_ITEM_LIMIT = 50;
export function appendRecentProgressItem(items, item) {
    items.push(item);
    if (items.length > RECENT_PROGRESS_ITEM_LIMIT) {
        items.splice(0, items.length - RECENT_PROGRESS_ITEM_LIMIT);
    }
}
