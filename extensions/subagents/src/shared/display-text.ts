/**
 * Terminal-safe text boundary for untrusted child transcript/status content.
 *
 * Apply {@link safeTerminalText} only at display/render surfaces. Do not apply
 * it to durable files such as transcript JSONL, output artifacts, metadata, or
 * log files: those paths must remain byte-faithful.
 */

/** Returned when input contains binary-looking content. */
export const BINARY_CONTENT_PLACEHOLDER = "[binary content]";

/** More than half unsafe control characters makes text binary-looking. */
const BINARY_DENSITY_THRESHOLD = 0.5;

/**
 * C0 controls other than tab and LF, DEL, and C1 controls are not safe to
 * pass through a terminal display boundary.
 */
function isUnsafeControlCode(codePoint: number): boolean {
  return (
    (codePoint >= 0x01 && codePoint <= 0x08) ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f)
  );
}

interface SanitizedTerminalText {
  normalized: string;
  cleaned: string;
  unsafeCount: number;
}

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

/**
 * Strip terminal controls without applying the leaf binary-content policy.
 *
 * Bare controls between two non-whitespace spans get one separator so
 * `echo\\x01rm` remains readable as `echo rm`. Escape sequences are consumed
 * as inert terminal syntax and do not add separators of their own.
 */
function sanitizeTerminalDocument(input: string): SanitizedTerminalText {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let cleaned = "";
  let unsafeCount = 0;
  let bareControlPending = false;
  const length = normalized.length;

  const appendVisible = (character: string): void => {
    const previous = cleaned[cleaned.length - 1];
    if (
      bareControlPending &&
      previous !== undefined &&
      !isWhitespace(previous) &&
      !isWhitespace(character)
    ) {
      cleaned += " ";
    }
    cleaned += character;
    bareControlPending = false;
  };

  for (let index = 0; index < length; index++) {
    const codePoint = normalized.charCodeAt(index);

    if (codePoint === 0x1b) {
      unsafeCount++;
      const next = normalized.charCodeAt(index + 1);
      if (next === 0x5b) {
        // CSI: ESC [ parameter bytes, then a final byte in 0x40–0x7e.
        index++;
        while (index + 1 < length) {
          index++;
          const finalCode = normalized.charCodeAt(index);
          if (finalCode >= 0x40 && finalCode <= 0x7e) break;
        }
      } else if (next === 0x5d) {
        // OSC: ESC ] payload, terminated by BEL or ST (ESC backslash).
        index++;
        while (index + 1 < length) {
          index++;
          const sequenceCode = normalized.charCodeAt(index);
          if (sequenceCode === 0x07) break;
          if (sequenceCode === 0x1b && normalized.charCodeAt(index + 1) === 0x5c) {
            index++;
            break;
          }
        }
      }
      continue;
    }

    if (codePoint === 0x9b) {
      // 8-bit CSI introducer.
      unsafeCount++;
      while (index + 1 < length) {
        index++;
        const finalCode = normalized.charCodeAt(index);
        if (finalCode >= 0x40 && finalCode <= 0x7e) break;
      }
      continue;
    }

    if (codePoint === 0x9d) {
      // 8-bit OSC introducer, terminated by BEL, ST, or ESC backslash.
      unsafeCount++;
      while (index + 1 < length) {
        index++;
        const sequenceCode = normalized.charCodeAt(index);
        if (sequenceCode === 0x07 || sequenceCode === 0x9c) break;
        if (sequenceCode === 0x1b && normalized.charCodeAt(index + 1) === 0x5c) {
          index++;
          break;
        }
      }
      continue;
    }

    if (codePoint === 0x00 || isUnsafeControlCode(codePoint)) {
      unsafeCount++;
      bareControlPending = true;
      continue;
    }

    // Append the original code unit so surrogate pairs and all ordinary
    // Unicode remain byte-for-byte equivalent in the JS string.
    appendVisible(normalized[index]);
  }

  return { normalized, cleaned, unsafeCount };
}

/**
 * Sanitize untrusted child text for safe terminal display.
 *
 * CRLF and lone CR are normalized to LF. ANSI CSI and OSC sequences are
 * consumed as a unit, while a bare ESC and other unsafe controls are removed.
 * Tabs and newlines remain usable for readable display text. Ordinary Unicode
 * is copied unchanged. Inputs containing a NUL or a high density of unsafe
 * controls are represented by a short placeholder instead of partial output.
 */
export function safeTerminalText(input: string): string {
  const sanitized = sanitizeTerminalDocument(input);
  if (
    sanitized.normalized.includes("\x00") ||
    (sanitized.normalized.length > 0 &&
      sanitized.unsafeCount / sanitized.normalized.length > BINARY_DENSITY_THRESHOLD)
  ) {
    return BINARY_CONTENT_PLACEHOLDER;
  }
  return sanitized.cleaned;
}

/**
 * Sanitize a composed display document without applying the leaf binary
 * placeholder policy. Use this only after child-derived leaves have been
 * sanitized at their individual display boundaries.
 */
export function safeTerminalDocument(input: string): string {
  return sanitizeTerminalDocument(input).cleaned;
}
