/**
 * OSC 7577 (Program Resume Protocol) frame codec and transform for the tlh resume bridge.
 *
 * Mirrors Pi 1.7.0 pi-tui `program-resume.js` byte for byte on the producing side and adds a strict
 * parser and verifier on the consuming side. Dependency-free: `node:` imports only.
 *
 * Frame: ESC ] 7577 ; body ESC \ where body is `pid=..:time=..:(argv=..[:cwd=..]|clear=1):mac=<hex>`
 * and mac = sha256(body_without_mac + ":" + token) (plain SHA-256, not HMAC).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export const MAX_SEQUENCE_BYTES = 2048;
export const MAX_ARGV_ELEMENTS = 64;

const FRAME_PREFIX = "\x1b]7577;";
const FRAME_SUFFIX = "\x1b\\";

/** Cc: C0 and C1 control characters, as pi-tui rejects them. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
const MAC_PATTERN = /^[0-9a-f]{64}$/;
const DIGITS = /^[0-9]{1,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FrameSender {
  pid: number | string;
  time: number | string;
  token: string;
}

export interface ResumeCommand {
  argv: readonly string[];
  cwd?: string;
}

export interface FrameLocation {
  /** Index of the ESC that starts the frame. */
  start: number;
  /** Index just past the ST terminator. */
  end: number;
  frame: string;
}

export interface ParsedFrame {
  pid: string;
  time: string;
  /** Decoded argv, absent for a clear frame. */
  argv?: string[];
  cwd?: string;
  clear: boolean;
  /** Everything before `:mac=`; the MAC input is `${body}:${token}`. */
  body: string;
  mac: string;
}

export type FrameTransform = { kind: "report"; argv: string[]; cwd?: string } | { kind: "clear" };

export interface TransformOptions {
  expectedAgentDir: string;
  wrapperName: string;
  /** Pid the caller will sign the rewritten frame with. */
  pid: number | string;
  /** Time the caller will sign with; defaults to the incoming frame's time. Only used for size checks. */
  time?: number | string;
}

/** Locate complete frames (ESC ] 7577 ; ... ESC \) in `text`. Bodies never contain ESC or BEL. */
export function findFrames(text: string): FrameLocation[] {
  const frames: FrameLocation[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(FRAME_PREFIX, from);
    if (start === -1) return frames;
    const bodyStart = start + FRAME_PREFIX.length;
    let end = bodyStart;
    while (end < text.length && text[end] !== "\x1b" && text[end] !== "\x07") end += 1;
    if (text.startsWith(FRAME_SUFFIX, end)) {
      const stop = end + FRAME_SUFFIX.length;
      frames.push({ start, end: stop, frame: text.slice(start, stop) });
      from = stop;
    } else {
      from = bodyStart;
    }
  }
}

function isReportableText(text: string): boolean {
  return text.isWellFormed() && !hasControlCharacter(text);
}

function isBareName(program: string): boolean {
  return program.length > 0 && !program.startsWith("-") && !/[\\/]/.test(program);
}

/** A launcher name that is safe to type into a login shell: non-empty, no path separators, not an option. */
export function isValidWrapperName(name: unknown): name is string {
  return typeof name === "string" && isBareName(name) && isReportableText(name);
}

function isReportableCommand(command: ResumeCommand): boolean {
  const [program] = command.argv;
  if (program === undefined || command.argv.length > MAX_ARGV_ELEMENTS) return false;
  if (!isBareName(program) && !isAbsolute(program)) return false;
  if (command.cwd !== undefined && !(isAbsolute(command.cwd) && isReportableText(command.cwd))) {
    return false;
  }
  return command.argv.every(isReportableText);
}

function encodeText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function sign(body: string, token: string): string {
  return createHash("sha256").update(`${body}:${token}`, "utf8").digest("hex");
}

function frameFromPairs(pairs: string[], sender: FrameSender): string {
  const body = [`pid=${sender.pid}`, `time=${sender.time}`, ...pairs].join(":");
  return `${FRAME_PREFIX}${body}:mac=${sign(body, sender.token)}${FRAME_SUFFIX}`;
}

/** Encode a report of `command`; undefined when the protocol cannot carry it (same rules as pi-tui). */
export function formatReport(command: ResumeCommand, sender: FrameSender): string | undefined {
  if (!isReportableCommand(command)) return undefined;
  const pairs = [`argv=${command.argv.map(encodeText).join(",")}`];
  if (command.cwd !== undefined) pairs.push(`cwd=${encodeText(command.cwd)}`);
  const sequence = frameFromPairs(pairs, sender);
  return Buffer.byteLength(sequence, "utf8") <= MAX_SEQUENCE_BYTES ? sequence : undefined;
}

/** Encode a report that removes the sender's command. */
export function formatClear(sender: FrameSender): string {
  return frameFromPairs(["clear=1"], sender);
}

/** Strictly decode canonical base64 of well-formed UTF-8; undefined otherwise. */
function decodeText(encoded: string): string | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Strict parser. Accepts only the canonical layout pi-tui produces: pid, time, then `argv` (+ optional
 * `cwd`) or `clear=1`, then `mac` last; no duplicate or unknown keys. Returns undefined for anything else.
 * This does not check the MAC; call {@link verifyFrame}.
 */
export function parseFrame(frame: string): ParsedFrame | undefined {
  if (typeof frame !== "string" || Buffer.byteLength(frame, "utf8") > MAX_SEQUENCE_BYTES) {
    return undefined;
  }
  if (!frame.startsWith(FRAME_PREFIX) || !frame.endsWith(FRAME_SUFFIX)) return undefined;
  const inner = frame.slice(FRAME_PREFIX.length, frame.length - FRAME_SUFFIX.length);
  if (hasControlCharacter(inner)) return undefined;

  const pairs = inner.split(":");
  const parsedPairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return undefined;
    const key = pair.slice(0, eq);
    if (seen.has(key)) return undefined;
    seen.add(key);
    parsedPairs.push([key, pair.slice(eq + 1)]);
  }

  const keys = parsedPairs.map(([key]) => key).join(",");
  if (!["pid,time,argv,mac", "pid,time,argv,cwd,mac", "pid,time,clear,mac"].includes(keys)) {
    return undefined;
  }
  const values = new Map(parsedPairs);
  const pid = values.get("pid") as string;
  const time = values.get("time") as string;
  const mac = values.get("mac") as string;
  if (!DIGITS.test(pid) || !DIGITS.test(time) || !MAC_PATTERN.test(mac)) return undefined;
  const body = inner.slice(0, inner.length - ":mac=".length - mac.length);

  if (values.has("clear")) {
    if (values.get("clear") !== "1") return undefined;
    return { pid, time, clear: true, body, mac };
  }

  const argv = (values.get("argv") as string).split(",").map(decodeText);
  if (argv.length > MAX_ARGV_ELEMENTS) return undefined;
  const decoded: string[] = [];
  for (const element of argv) {
    if (element === undefined || !isReportableText(element)) return undefined;
    decoded.push(element);
  }
  const program = decoded[0];
  if (program === undefined || !(isBareName(program) || isAbsolute(program))) return undefined;

  let cwd: string | undefined;
  if (values.has("cwd")) {
    cwd = decodeText(values.get("cwd") as string);
    if (cwd === undefined || !isAbsolute(cwd) || !isReportableText(cwd)) return undefined;
  }
  return cwd === undefined
    ? { pid, time, argv: decoded, clear: false, body, mac }
    : { pid, time, argv: decoded, cwd, clear: false, body, mac };
}

/** True when the frame's MAC matches `token` (constant-time compare). */
export function verifyFrame(parsed: ParsedFrame, token: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const expected = Buffer.from(sign(parsed.body, token), "utf8");
  const actual = Buffer.from(parsed.mac, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Decide what tlh should report for a verified Pi frame. A wrapper report is produced only for exactly
 * `pi --agent-dir <expectedAgentDir> --session <uuid>`; every other shape (including `clear` frames and an
 * invalid `wrapperName`) yields a clear. The caller signs the result with its own token.
 */
export function transformPiReport(parsed: ParsedFrame, options: TransformOptions): FrameTransform {
  const clear: FrameTransform = { kind: "clear" };
  const { argv, cwd } = parsed;
  if (parsed.clear || argv === undefined || !isValidWrapperName(options.wrapperName)) return clear;
  if (argv.length !== 5 || argv[0] !== "pi" || argv[1] !== "--agent-dir") return clear;
  if (argv[3] !== "--session" || !UUID_PATTERN.test(argv[4] as string)) return clear;

  const reportedDir = argv[2] as string;
  // Pi always reports an absolute agent dir; a relative value never comes from unmodified Pi.
  if (!isAbsolute(reportedDir)) return clear;
  if (resolve(reportedDir) !== resolve(options.expectedAgentDir)) return clear;

  const command: ResumeCommand =
    cwd === undefined
      ? { argv: [options.wrapperName, "--session", argv[4] as string] }
      : { argv: [options.wrapperName, "--session", argv[4] as string], cwd };
  // Size and reportability check; the MAC length does not depend on the token.
  const probe = formatReport(command, {
    pid: options.pid,
    time: options.time ?? parsed.time,
    token: "",
  });
  if (probe === undefined) return clear;
  return cwd === undefined
    ? { kind: "report", argv: [...command.argv] }
    : { kind: "report", argv: [...command.argv], cwd };
}
