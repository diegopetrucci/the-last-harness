import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Ticket IDs accepted by the explicit subagent ticket boundary. */
export const TICKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
export const MAX_TICKET_ID_LENGTH = 128;

/** Keep a ticket lookup from hanging a dispatch or filling a process buffer. */
export const TICKET_LOOKUP_TIMEOUT_MS = 5_000;
export const TICKET_LOOKUP_MAX_OUTPUT_BYTES = 512 * 1024;

export interface NormalizedTicketId {
  ticketId?: string;
  error?: string;
}

/**
 * Normalize one caller-provided ticket ID without ever treating it as shell
 * syntax. Whitespace around an ID is harmless; every other character must be
 * part of the deliberately small ticket-ID alphabet.
 */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function normalizeTicketId(value: unknown, field = "ticket"): NormalizedTicketId {
  if (value === undefined) return {};
  if (typeof value !== "string") return { error: `${field} must be a string.` };
  const ticketId = value.trim();
  if (ticketId.length === 0) return { error: `${field} must not be empty.` };
  if (ticketId.length > MAX_TICKET_ID_LENGTH) {
    return { error: `${field} must be at most ${MAX_TICKET_ID_LENGTH} characters.` };
  }
  if (hasControlCharacters(ticketId)) {
    return { error: `${field} contains control characters.` };
  }
  if (!TICKET_ID_PATTERN.test(ticketId)) {
    return {
      error: `${field} must be a safe ticket ID containing only letters, numbers, and hyphens.`,
    };
  }
  return { ticketId };
}

/** Best-effort normalization for values read from persisted status files. */
export function persistedTicketId(value: unknown): string | undefined {
  return normalizeTicketId(value).ticketId;
}

/** Stable cache key for one normalized ticket lookup in one dispatch. */
export function ticketLookupKey(cwd: string, ticketId: string): string {
  const resolvedCwd = path.resolve(cwd);
  const comparableCwd = process.platform === "win32" ? resolvedCwd.toLowerCase() : resolvedCwd;
  return `${comparableCwd}\u0000${ticketId}`;
}

function ticketCwdError(ticketId: string, cwd: string): string | undefined {
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return `Unable to load ticket '${ticketId}' in '${cwd}': the task cwd is not a directory.`;
    }
    return undefined;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return `Unable to load ticket '${ticketId}' in '${cwd}': the task cwd does not exist.`;
    }
    return `Unable to load ticket '${ticketId}' in '${cwd}': the task cwd could not be inspected.`;
  }
}

export interface TicketBodyResult {
  ticketId: string;
  body?: string;
  error?: string;
}

/**
 * Read the ticket through argv, in the child's effective cwd. No shell is
 * involved, stderr is deliberately excluded from diagnostics, and stdout is
 * bounded before it can become prompt input.
 */
export function readTicketBody(ticketId: string, cwd: string, field = "ticket"): TicketBodyResult {
  const normalized = normalizeTicketId(ticketId, field);
  if (!normalized.ticketId) {
    return { ticketId, error: normalized.error ?? `${field} is invalid.` };
  }
  const id = normalized.ticketId;
  const cwdError = ticketCwdError(id, cwd);
  if (cwdError) return { ticketId: id, error: cwdError };

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("tk", ["show", id], {
      cwd,
      encoding: "utf-8",
      timeout: TICKET_LOOKUP_TIMEOUT_MS,
      maxBuffer: TICKET_LOOKUP_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch {
    return {
      ticketId: id,
      error: `Unable to load ticket '${id}' in '${cwd}': the tk command could not be started.`,
    };
  }

  const processError = result.error as NodeJS.ErrnoException | undefined;
  if (processError) {
    if (processError.code === "ENOENT") {
      const currentCwdError = ticketCwdError(id, cwd);
      return {
        ticketId: id,
        error:
          currentCwdError ??
          `Unable to load ticket '${id}' in '${cwd}': the tk command is unavailable.`,
      };
    }
    if (processError.code === "ETIMEDOUT" || result.signal) {
      return {
        ticketId: id,
        error: `Unable to load ticket '${id}' in '${cwd}': tk show timed out.`,
      };
    }
    if (processError.code === "ENOBUFS") {
      return {
        ticketId: id,
        error: `Unable to load ticket '${id}' in '${cwd}': ticket output exceeded the ${TICKET_LOOKUP_MAX_OUTPUT_BYTES}-byte limit.`,
      };
    }
    return {
      ticketId: id,
      error: `Unable to load ticket '${id}' in '${cwd}': tk show could not be completed.`,
    };
  }
  if (result.status !== 0) {
    const exit = typeof result.status === "number" ? `exit code ${result.status}` : "failed";
    return {
      ticketId: id,
      error: `Unable to load ticket '${id}' in '${cwd}': tk show returned ${exit}.`,
    };
  }

  const body = typeof result.stdout === "string" ? result.stdout : "";
  if (body.trim().length === 0) {
    return {
      ticketId: id,
      error: `Unable to load ticket '${id}' in '${cwd}': tk show returned no ticket body.`,
    };
  }
  return { ticketId: id, body };
}

/** Append the exact ticket output to the initial user prompt only. */
export function injectTicketBody(task: string, ticketId: string, body: string): string {
  return `${task}\n\n## Ticket ${ticketId}\n${body}`;
}
