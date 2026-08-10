/**
 * Retain the same bounded window for completed tool records as live output.
 * Arguments stay exact; only entries older than the newest 50 are discarded.
 */
export const RECENT_PROGRESS_ITEM_LIMIT = 50;

export function appendRecentProgressItem<T>(items: T[], item: T): void {
	items.push(item);
	if (items.length > RECENT_PROGRESS_ITEM_LIMIT) {
		items.splice(0, items.length - RECENT_PROGRESS_ITEM_LIMIT);
	}
}
