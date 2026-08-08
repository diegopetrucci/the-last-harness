import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Compile } from "typebox/compile";
export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";
export function assertJsonSchemaObject(schema, label = "outputSchema") {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        throw new Error(`${label} must be a JSON Schema object.`);
    }
}
export function createStructuredOutputRuntime(schema, baseDir) {
    assertJsonSchemaObject(schema);
    const rootDir = baseDir ?? os.tmpdir();
    fs.mkdirSync(rootDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-structured-"));
    const schemaPath = path.join(dir, "schema.json");
    const outputPath = path.join(dir, "output.json");
    fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    return { schema, schemaPath, outputPath };
}
export function validateStructuredOutputValue(schema, value) {
    let validator;
    try {
        validator = Compile(schema);
    }
    catch (error) {
        return {
            status: "invalid",
            message: `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (validator.Check(value))
        return { status: "valid" };
    const errors = [...validator.Errors(value)].slice(0, 8).map((error) => {
        const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
        return `${pathText}: ${error.message}`;
    });
    return { status: "invalid", message: errors.join("; ") || "schema validation failed" };
}
export function readStructuredOutput(runtime) {
    if (!fs.existsSync(runtime.outputPath)) {
        return {
            error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output.",
        };
    }
    let value;
    try {
        value = JSON.parse(fs.readFileSync(runtime.outputPath, "utf-8"));
    }
    catch (error) {
        return { error: `Failed to read structured output: ${error instanceof Error ? error.message : String(error)}` };
    }
    const validation = validateStructuredOutputValue(runtime.schema, value);
    if (validation.status === "invalid")
        return { error: `Structured output validation failed: ${validation.message}` };
    return { value };
}
export function cleanupStructuredOutputRuntime(runtime) {
    if (!runtime)
        return;
    try {
        fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
    }
    catch {
    }
}
