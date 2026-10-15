import { readFileSync } from "node:fs";

function readLinuxProcStat(pid) {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}

/**
 * Extract the Linux process state from /proc/<pid>/stat.
 *
 * The comm field is parenthesized but may contain spaces and parentheses, so
 * the final closing parenthesis is the delimiter before the state field.
 *
 * @param {string} stat
 * @returns {string | undefined}
 */
export function parseLinuxProcStatState(stat) {
  if (typeof stat !== "string") return undefined;

  const openParen = stat.indexOf("(");
  if (openParen < 1 || !/^\d+\s+$/.test(stat.slice(0, openParen))) return undefined;

  const closeParen = stat.lastIndexOf(")");
  if (closeParen <= openParen || !/^\s/.test(stat.slice(closeParen + 1))) return undefined;

  const state = stat
    .slice(closeParen + 1)
    .trimStart()
    .split(/\s+/, 1)[0];
  return /^[A-Za-z]$/.test(state) ? state : undefined;
}

/**
 * Check whether a fixture-owned process is still live.
 *
 * @param {number} pid
 * @param {{ platform?: string; kill?: (pid: number, signal: number) => void; readProcStat?: (pid: number) => string }} [probes]
 */
export function isProcessAlive(
  pid,
  {
    platform = process.platform,
    kill = (target, signal) => process.kill(target, signal),
    readProcStat = readLinuxProcStat,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    kill(pid, 0);
  } catch (error) {
    return error?.code === "EPERM";
  }

  if (platform !== "linux") return true;

  try {
    return parseLinuxProcStatState(readProcStat(pid)) !== "Z";
  } catch {
    // A process that cannot be inspected must not be treated as gone.
    return true;
  }
}
