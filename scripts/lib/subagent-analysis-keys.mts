/** Collision-free keys for internal maps over opaque telemetry values. */

export type TupleKeyPart = string | number | undefined;

/**
 * Encode a tuple without a delimiter so opaque strings cannot collide with
 * tuple boundaries. Numeric and string values retain their JSON types, and
 * undefined is distinct from every string value.
 */
export function tupleKey(...parts: TupleKeyPart[]): string {
  return JSON.stringify(parts);
}
