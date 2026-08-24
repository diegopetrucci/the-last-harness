/**
 * Shared surrogate-safe string helpers used across the subagent extension.
 *
 * A single canonical copy is kept here so every call site shares one correct
 * implementation; duplicating the logic on separate paths risks divergence.
 */

/**
 * Slice a string to at most `end` UTF-16 code units, then back up by one unit
 * when the last kept code unit is a UTF-16 high surrogate (U+D800–U+DBFF). A
 * high surrogate without its paired low surrogate produces an ill-formed string;
 * backing up one code unit keeps the string well-formed at the cost of one
 * fewer character of context.
 */
export function sliceSafe(value: string, end: number): string {
  const sliced = value.slice(0, end);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Truncate `value` to at most `maxChars` UTF-16 code units, appending `marker`
 * when truncation is necessary. If the budget cannot even hold the full marker,
 * the marker itself is sliced to fit. The slice is surrogate-safe: the function
 * will not produce an ill-formed string at the cut point for any input, including
 * non-BMP markers.
 */
export function truncateWithMarker(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) return value;
  if (marker.length >= maxChars) return sliceSafe(marker, maxChars);
  return `${sliceSafe(value, maxChars - marker.length)}${marker}`;
}

/**
 * Maximum UTF-16 code units allowed for a rendered rejection reason.
 * Shared between run-status.ts and notify.ts so both render sites stay in sync.
 */
export const REJECTION_REASON_MAX_LENGTH = 200;

/**
 * Collapse whitespace characters in a child-controlled reason string so it
 * cannot forge additional status or notification lines. Specifically:
 * - replaces runs of whitespace control characters (\r, \n, \t, \v, \f) with a
 *   single space,
 * - then collapses runs of two or more ordinary spaces to a single space,
 * - then trims leading/trailing whitespace.
 *
 * Normalization MUST precede truncation so a newline cannot survive inside
 * the truncated result.
 */
export function normalizeRejectionReason(reason: string): string {
  return reason
    .replace(/[\r\n\t\v\f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Normalize then truncate a rejection reason to at most
 * REJECTION_REASON_MAX_LENGTH UTF-16 code units, appending a Unicode
 * ellipsis (U+2026) when truncation is necessary.
 *
 * Callers own display budget decisions. This helper is intentionally
 * side-effect-free and may be called multiple times.
 */
export function formatRejectionReason(reason: string): string {
  return truncateWithMarker(
    normalizeRejectionReason(reason),
    REJECTION_REASON_MAX_LENGTH,
    "\u2026",
  );
}
