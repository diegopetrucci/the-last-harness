import { Type } from "typebox";
function keepTopLevelParameterDescriptions(schema) {
    return pruneNestedDescriptions(schema, []);
}
function pruneNestedDescriptions(value, path) {
    if (!value || typeof value !== "object")
        return value;
    const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor)
            continue;
        if (key === "description" && !isTopLevelParameterDescription(path))
            continue;
        if ("value" in descriptor) {
            const nextPath = typeof key === "string" ? [...path, key] : path;
            descriptor.value = pruneNestedDescriptions(descriptor.value, nextPath);
        }
        Object.defineProperty(result, key, descriptor);
    }
    return result;
}
function isTopLevelParameterDescription(path) {
    return path.length === 2 && path[0] === "properties";
}
const OutputOverride = Type.Unsafe({
    anyOf: [{ type: "string" }, { type: "boolean" }],
    description: "Output filename/path (string), or false to disable file output",
});
const OutputModeOverride = Type.String({
    enum: ["inline", "file-only"],
    description: "Return saved output inline (default) or only a concise file reference. file-only requires output to be a path.",
});
const ReadsOverride = Type.Unsafe({
    anyOf: [{ type: "array", items: { type: "string" } }, { type: "boolean" }],
    description: "Files to read before running (array of filenames), or false to disable",
});
const FallbackModelsOverride = Type.Array(Type.String(), {
    description: "Per-execution fallback models to try after the primary model and before any agent fallbackModels.",
});
const TaskItem = Type.Object({
    agent: Type.String(),
    task: Type.String(),
    count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." })),
    output: Type.Optional(OutputOverride),
    outputMode: Type.Optional(OutputModeOverride),
    reads: Type.Optional(ReadsOverride),
    progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking for this task" })),
    model: Type.Optional(Type.String({ description: "Override model for this task" })),
}, { additionalProperties: false });
const SubagentParamsSchema = Type.Object({
    agent: Type.Optional(Type.String({ description: "Agent name for SINGLE mode or action='get'." })),
    task: Type.Optional(Type.String({ description: "Task (SINGLE mode, optional for self-contained agents)" })),
    tasks: Type.Optional(Type.Array(TaskItem, {
        description: "PARALLEL mode: [{agent, task, count?, output?, outputMode?, reads?, progress?, model?}, ...]",
    })),
    concurrency: Type.Optional(Type.Integer({
        minimum: 1,
        description: "Top-level PARALLEL mode only: max concurrent tasks. Defaults to config.parallel.concurrency or 4.",
    })),
    context: Type.Optional(Type.String({
        enum: ["fresh", "fork"],
        description: "'fresh' or 'fork' to branch from parent session. Explicit context overrides every child in the invocation. If omitted, each requested agent uses its own defaultContext; agents without defaultContext: 'fork' run fresh.",
    })),
    async: Type.Optional(Type.Boolean({ description: "Launch detached background work (default: false, or per config)" })),
    action: Type.Optional(Type.String({
        enum: ["list", "get", "status", "interrupt", "resume", "steer", "doctor"],
        description: "Management action. One of: list, get, status, interrupt, resume, steer, doctor. Omit for execution mode (single agent or parallel tasks).",
    })),
    id: Type.Optional(Type.String({
        description: "Run id or prefix for action='status', action='interrupt', action='resume', or action='steer', including durable paused-awaiting-supervisor runs.",
    })),
    index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for actions that target a specific child." })),
    message: Type.Optional(Type.String({
        description: "Optional guidance for action='resume' (omit for unchanged resume), or required guidance for action='steer'.",
    })),
    agentScope: Type.Optional(Type.String({
        description: "Agent discovery scope: 'user', 'project', or 'both' (default: 'both'; project wins on name collisions)",
    })),
    output: Type.Optional(Type.Unsafe({
        anyOf: [{ type: "string" }, { type: "boolean" }],
        description: "Output file for single agent (string), or false to disable. Relative paths resolve against cwd.",
    })),
    outputMode: Type.Optional(OutputModeOverride),
    model: Type.Optional(Type.String({ description: "Override model for single agent (e.g. 'anthropic/claude-sonnet-4')" })),
    fallbackModels: Type.Optional(FallbackModelsOverride),
    timeoutMs: Type.Optional(Type.Integer({
        minimum: 1,
        description: "Optional run-level timeout in ms for foreground and async/background runs.",
    })),
    cwd: Type.Optional(Type.String()),
    artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
    includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
}, { additionalProperties: false });
export const SubagentParams = keepTopLevelParameterDescriptions(SubagentParamsSchema);
