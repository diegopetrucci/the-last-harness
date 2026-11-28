/**
 * Node `--import` preload for the tlh OSC 7577 (Program Resume Protocol) bridge.
 *
 * Active only when OSC7577_TOKEN is non-empty AND TLH_PROGRAM_RESUME_ACTIVE is "1" (a marker the tlh
 * wrapper sets for eligible launches); otherwise it does nothing at all, so children that inherit
 * execArgv stay inert. When active it:
 *   1. moves the real terminal token and the marker out of process.env into a module-local closure,
 *   2. hooks process.stdout.write so Pi's decoy-signed resume frames are re-signed as the tlh wrapper
 *      command (or a clear) with the real token,
 *   3. pins process.title to the wrapper name so Pi's later `process.title = "pi"` is a no-op,
 *   4. hands Pi a fresh random decoy token. Pi takes (and deletes) it, so children get no token.
 * A setup failure inside install() leaves the token deleted and installs nothing else: tlh starts without
 * resume. A missing, unreadable or corrupt preload dependency (this file or ./lib/program-resume-frame.mjs)
 * instead fails Node module loading before that handling runs; the wrapper preflight only checks presence
 * and readability.
 *
 * Threat model: this guarantees that unmodified, supported Pi only emits re-signed wrapper/clear reports
 * and that its children get no token. It is NOT a boundary against hostile startup code (NODE_OPTIONS
 * preloads), same-process extensions, or debuggers, which can read the closure or write to fd 1 directly.
 *
 * Hook contract: write(chunk, encoding?, callback?) keeps its signature, arguments and return value
 * (backpressure). Chunks without ESC ] 7577 ; pass through untouched. For complete frames: verified with
 * the decoy and pid === process.pid -> transformed and real-signed; decoy-authenticated with pid !==
 * process.pid -> dropped (no clear); decoy-authenticated but unsupported or failing to transform ->
 * real-signed clear; unparseable or unauthenticated frames -> dropped individually (no clear). Bytes around frames are preserved exactly. Incomplete (split) frames pass through unchanged
 * (decoy-signed, so the terminal rejects them); nothing is buffered across chunks. An unexpected exception
 * outside per-frame handling writes the chunk minus frames plus one real-signed clear.
 */
import { randomBytes } from "node:crypto";

import {
  findFrames,
  formatClear,
  formatReport,
  isValidWrapperName,
  parseFrame,
  transformPiReport,
  verifyFrame,
} from "./lib/program-resume-frame.mjs";

const TOKEN_ENV = "OSC7577_TOKEN";
const MARKER_ENV = "TLH_PROGRAM_RESUME_ACTIVE";
const TEST_FAIL_ENV = "TLH_PROGRAM_RESUME_TEST_FAIL";
const INTRODUCER = "\x1b]7577;";

type Piece = string | Buffer;

/** OSC 7577 `time` is Unix seconds. */
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function install(): void {
  const realToken = process.env[TOKEN_ENV];
  if (!realToken || process.env[MARKER_ENV] !== "1") return;

  const wrapperName = process.env.TLH_RUNTIME_WRAPPER_NAME;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env[TOKEN_ENV];
  delete process.env[MARKER_ENV];
  // Test-only failure injection, deleted here: "frame" fails each authenticated frame's transform,
  // "transform" fails the whole-chunk normal path, "all" also fails the whole-chunk fallback.
  const testFail = process.env[TEST_FAIL_ENV];
  delete process.env[TEST_FAIL_ENV];

  const stream = process.stdout;
  const original = stream.write;
  try {
    if (!isValidWrapperName(wrapperName) || !agentDir) return;
    const name: string = wrapperName;
    const decoy = randomBytes(32).toString("hex");
    const introducerBytes = Buffer.from(INTRODUCER, "latin1");
    let inHook = false;

    const signedClear = (time: string | number): string =>
      formatClear({ pid: process.pid, time, token: realToken });

    /** Rewrite frames in `text` (1 char === 1 byte for latin1 text); returns pieces keyed by offsets. */
    const rewrite = (
      text: string,
      slice: (start: number, end: number) => Piece,
      fallbackClear: boolean,
    ): Piece[] => {
      const pieces: Piece[] = [];
      let cursor = 0;
      for (const location of findFrames(text)) {
        if (location.start > cursor) pieces.push(slice(cursor, location.start));
        cursor = location.end;
        if (fallbackClear) continue;
        // Per-frame handling: anything unparseable or not authenticated by the decoy is dropped alone.
        let parsed: ReturnType<typeof parseFrame>;
        try {
          parsed = parseFrame(location.frame);
          if (parsed === undefined || !verifyFrame(parsed, decoy)) continue;
          // Decoy-verified but reported for another pid: drop without a clear.
          if (parsed.pid !== String(process.pid)) continue;
        } catch {
          continue;
        }
        // Authenticated by the decoy: a failure to transform or sign yields a real-signed clear.
        let replacement: string | undefined;
        try {
          if (testFail === "frame") throw new Error("injected test failure");
          const result = transformPiReport(parsed, {
            expectedAgentDir: agentDir,
            wrapperName: name,
            pid: process.pid,
          });
          if (result.kind === "report") {
            replacement = formatReport(
              result.cwd === undefined
                ? { argv: result.argv }
                : { argv: result.argv, cwd: result.cwd },
              { pid: process.pid, time: parsed.time, token: realToken },
            );
          }
        } catch {
          replacement = undefined;
        }
        pieces.push(Buffer.from(replacement ?? signedClear(parsed.time), "latin1"));
      }
      if (cursor < text.length) pieces.push(slice(cursor, text.length));
      if (fallbackClear) pieces.push(Buffer.from(signedClear(nowSeconds()), "latin1"));
      return pieces;
    };

    const transform = (chunk: string | Uint8Array, fallbackClear: boolean): string | Buffer => {
      if (testFail === "all" || (testFail === "transform" && !fallbackClear)) {
        throw new Error("injected test failure");
      }
      if (typeof chunk === "string") {
        const pieces = rewrite(chunk, (start, end) => chunk.slice(start, end), fallbackClear);
        return pieces
          .map((piece) => (typeof piece === "string" ? piece : piece.toString("latin1")))
          .join("");
      }
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const pieces = rewrite(
        bytes.toString("latin1"),
        (start, end) => bytes.subarray(start, end),
        fallbackClear,
      );
      return Buffer.concat(
        pieces.map((piece) => (typeof piece === "string" ? Buffer.from(piece, "latin1") : piece)),
      );
    };

    const hooked = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
      const call = (replacement: unknown): boolean =>
        original.call(this as typeof stream, replacement as string, ...(rest as []));
      if (inHook) return call(chunk);
      inHook = true;
      try {
        let subject: string | Uint8Array;
        if (typeof chunk === "string") {
          const encoding = typeof rest[0] === "string" ? rest[0].toLowerCase() : "utf8";
          subject =
            encoding === "utf8" || encoding === "utf-8"
              ? chunk
              : Buffer.from(chunk, rest[0] as BufferEncoding);
        } else if (chunk instanceof Uint8Array) {
          subject = chunk;
        } else {
          return call(chunk);
        }
        const hasIntroducer =
          typeof subject === "string"
            ? subject.includes(INTRODUCER)
            : Buffer.from(subject.buffer, subject.byteOffset, subject.byteLength).indexOf(
                introducerBytes,
              ) !== -1;
        if (!hasIntroducer) return call(chunk);
        let replacement: unknown;
        try {
          replacement = transform(subject, false);
        } catch {
          try {
            replacement = transform(subject, true);
          } catch {
            replacement = Buffer.from(signedClear(nowSeconds()), "latin1");
          }
        }
        // Call the underlying writer exactly once, outside the fallback chain, so its
        // (or a synchronous callback's) exceptions propagate and are never retried.
        return call(replacement);
      } finally {
        inHook = false;
      }
    };

    stream.write = hooked as typeof stream.write;
    try {
      process.title = name;
      Object.defineProperty(process, "title", {
        configurable: true,
        enumerable: true,
        get: () => name,
        set: () => {},
      });
      process.env[TOKEN_ENV] = decoy;
    } catch (error) {
      stream.write = original;
      throw error;
    }
  } catch {
    delete process.env[TOKEN_ENV];
    if (stream.write !== original) stream.write = original;
  }
}

install();
