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
 * Maximum number of UTF-16 code units shown for a rejection reason on any
 * supervisor-facing surface. One shared constant prevents the two render sites
 * (status lines and completion notifications) from drifting independently.
 */
export const REJECTION_REASON_MAX_LENGTH = 200;

/**
 * Normalize control whitespace in a rejection reason to single spaces before
 * truncation. Collapsing `\n`, `\r`, `\t`, and related control characters
 * prevents a child-authored reason that contains newlines from forging
 * additional status or notification lines when the reason is interpolated into
 * a line-oriented rendering.
 *
 * Normalization must happen before truncation so that a newline surviving
 * inside a truncated string cannot break the line layout.
 */
export function normalizeRejectionReason(reason: string): string {
  return reason
    .replace(/[\r\n\t\v\f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Normalize and truncate a rejection reason to `REJECTION_REASON_MAX_LENGTH`
 * code units, appending "\u2026" when truncation is necessary. Uses
 * `truncateWithMarker`, which is surrogate-safe and will not produce an
 * ill-formed string at the cut point.
 */
export function formatRejectionReason(reason: string): string {
  return truncateWithMarker(
    normalizeRejectionReason(reason),
    REJECTION_REASON_MAX_LENGTH,
    "\u2026",
  );
}
