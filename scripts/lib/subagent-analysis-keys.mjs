// Generated from scripts/lib/subagent-analysis-keys.mts by scripts/runtime-typescript.mjs; edit the source, not this file.
/** Collision-free keys for internal maps over opaque telemetry values. */
/**
 * Encode a tuple without a delimiter so opaque strings cannot collide with
 * tuple boundaries. Numeric and string values retain their JSON types, and
 * undefined is distinct from every string value.
 */
export function tupleKey(...parts) {
    return JSON.stringify(parts);
}
