export const RECENT_PROGRESS_ITEM_LIMIT = 50;
export function appendRecentProgressItem(items, item) {
    items.push(item);
    if (items.length > RECENT_PROGRESS_ITEM_LIMIT) {
        items.splice(0, items.length - RECENT_PROGRESS_ITEM_LIMIT);
    }
}
