/**
 * Shared constants for the detached runtime-cleanup scheduler and runner.
 *
 * This module must remain side-effect-free so it can be imported by the
 * extension registration path without triggering any cleanup work.
 */

/** Filename of the cleanup throttle marker, placed directly in TEMP_ROOT_DIR. */
export const RUNTIME_CLEANUP_MARKER_NAME = ".runtime-cleanup-marker";

/** How long a completed-sweep marker is considered fresh (24 h). */
export const CLEANUP_MARKER_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Mtime offset used when writing the pre-spawn lease marker.
 *
 * The marker is backdated by (24h - 10min) so that further launches within
 * the next ~10 min see a fresh marker and skip spawning. A crashed runner is
 * retried after the lease expires (~10 min).
 */
export const CLEANUP_MARKER_LEASE_OFFSET_MS = CLEANUP_MARKER_FRESH_WINDOW_MS - 10 * 60 * 1000;
