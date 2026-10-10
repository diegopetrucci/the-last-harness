import * as path from "node:path";
import { TEMP_ROOT_DIR } from "../../shared/types.js";
export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
function isSafeNestedId(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        !path.isAbsolute(value) &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !value.includes(".."));
}
export function assertSafeNestedId(label, value) {
    if (!isSafeNestedId(value))
        throw new Error(`${label} must be a non-empty safe id token.`);
}
