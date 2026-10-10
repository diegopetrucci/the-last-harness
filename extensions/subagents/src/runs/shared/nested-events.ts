import * as path from "node:path";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";

/** Legacy artifact root retained only for the one-release janitor. */
export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");

function isSafeNestedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !path.isAbsolute(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..")
  );
}

/**
 * Validate an id before using it to resolve a retained async artifact.
 *
 * The nested orchestration protocol is retired, but ordinary run lookup still
 * accepts an id supplied by the user. Keep this boundary helper until the
 * legacy janitor no longer needs the nested artifact layout.
 */
export function assertSafeNestedId(label: string, value: string): void {
  if (!isSafeNestedId(value)) throw new Error(`${label} must be a non-empty safe id token.`);
}
