import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type AsyncStatusCorruptionKind = "json_parse" | "persisted_validation";

export interface AsyncStatusCorruptionFingerprint {
  readonly algorithm: "sha256";
  readonly value: string;
}

export class AsyncStatusCorruptionError extends Error {
  readonly name = "AsyncStatusCorruptionError";
  readonly kind: AsyncStatusCorruptionKind;
  readonly asyncDir: string;
  readonly statusPath: string;
  readonly fingerprint?: AsyncStatusCorruptionFingerprint;

  constructor(input: {
    message: string;
    kind: AsyncStatusCorruptionKind;
    asyncDir: string;
    statusPath?: string;
    content?: string;
    fingerprint?: AsyncStatusCorruptionFingerprint;
    cause?: Error;
  }) {
    super(input.message, input.cause ? { cause: input.cause } : undefined);
    this.kind = input.kind;
    this.asyncDir = input.asyncDir;
    this.statusPath = input.statusPath ?? path.join(input.asyncDir, "status.json");
    this.fingerprint =
      input.fingerprint ??
      (typeof input.content === "string"
        ? fingerprintAsyncStatusContent(input.content)
        : undefined);
  }
}

export function fingerprintAsyncStatusContent(content: string): AsyncStatusCorruptionFingerprint {
  return Object.freeze({
    algorithm: "sha256" as const,
    value: createHash("sha256").update(content, "utf8").digest("hex"),
  });
}

export function fingerprintAsyncStatusFile(
  asyncDir: string,
  statusPath = path.join(asyncDir, "status.json"),
): AsyncStatusCorruptionFingerprint | undefined {
  try {
    return fingerprintAsyncStatusContent(fs.readFileSync(statusPath, "utf-8"));
  } catch {
    return undefined;
  }
}

export function isAsyncStatusCorruptionError(error: unknown): error is AsyncStatusCorruptionError {
  return error instanceof AsyncStatusCorruptionError;
}

export function createAsyncStatusJsonParseError(input: {
  asyncDir: string;
  statusPath?: string;
  content?: string;
  cause: unknown;
}): AsyncStatusCorruptionError {
  const cause = input.cause instanceof Error ? input.cause : new Error(String(input.cause));
  const statusPath = input.statusPath ?? path.join(input.asyncDir, "status.json");
  return new AsyncStatusCorruptionError({
    message: `Failed to parse async status file '${statusPath}': ${cause.message}`,
    kind: "json_parse",
    asyncDir: input.asyncDir,
    statusPath,
    content: input.content,
    cause,
  });
}

export function createAsyncStatusValidationError(input: {
  asyncDir: string;
  message: string;
  statusPath?: string;
  fingerprint?: AsyncStatusCorruptionFingerprint;
}): AsyncStatusCorruptionError {
  const statusPath = input.statusPath ?? path.join(input.asyncDir, "status.json");
  return new AsyncStatusCorruptionError({
    message: `Invalid async status '${statusPath}': ${input.message}`,
    kind: "persisted_validation",
    asyncDir: input.asyncDir,
    statusPath,
    fingerprint: input.fingerprint,
  });
}
