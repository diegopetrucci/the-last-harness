import assert from "node:assert/strict";
import { describe, it } from "node:test";

type JsonSchemaNode = Record<string, unknown>;

function anyOfBranches(schema: JsonSchemaNode | undefined): JsonSchemaNode[] {
  const anyOf = schema?.anyOf;
  if (!Array.isArray(anyOf)) return [];
  return anyOf.filter((branch): branch is JsonSchemaNode => !!branch && typeof branch === "object");
}

function hasAnyOfType(schema: JsonSchemaNode | undefined, type: string): boolean {
  return anyOfBranches(schema).some((branch) => branch.type === type);
}

function hasAnyOfArrayWithStringItems(schema: JsonSchemaNode | undefined): boolean {
  return anyOfBranches(schema).some((branch) => {
    if (branch.type !== "array") return false;
    const items = branch.items;
    return !!items && typeof items === "object" && (items as JsonSchemaNode).type === "string";
  });
}

function isSchemaObject(value: unknown): value is JsonSchemaNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSchemaObject(value: unknown, label: string): JsonSchemaNode {
  if (!isSchemaObject(value)) throw new Error(`${label} must be a schema object`);
  return value;
}

function getPropertySchema(
  schema: JsonSchemaNode | undefined,
  path: string[],
): JsonSchemaNode | undefined {
  let current: unknown = schema;
  for (const key of path) {
    if (!isSchemaObject(current) || !isSchemaObject(current.properties)) return undefined;
    current = current.properties[key];
  }
  return isSchemaObject(current) ? current : undefined;
}

// Import from the real module so the compiler tracks the actual exports.
// The concrete TypeBox object remains the owner of SubagentParams' shape; the
// open-object checks below deliberately inspect its provider-facing JSON view.
const schemasModule = await import("../../src/extension/schemas.ts");
const SubagentParams = requireSchemaObject(schemasModule.SubagentParams, "SubagentParams");
const schemas: Record<string, unknown> = Object.fromEntries(Object.entries(schemasModule));
type CompileSchemaFunction = (schema: unknown) => {
  Check(value: unknown): boolean;
  Errors(value: unknown): Iterable<{ message: string }>;
};
const { Compile: CompileSchema } = (await import("typebox/compile")) as {
  Compile: CompileSchemaFunction;
};

describe("SubagentParams schema", () => {
  it("includes context field for fresh/fork execution mode", () => {
    const contextSchema = getPropertySchema(SubagentParams, ["context"]);
    assert.ok(contextSchema, "context schema should exist");
    assert.equal(contextSchema.type, "string");
    assert.deepEqual(contextSchema.enum, ["fresh", "fork"]);
    const description = String(contextSchema.description ?? "");
    assert.match(description, /fresh/);
    assert.match(description, /fork/);
    assert.match(description, /each requested agent/);
    assert.match(description, /overrides every child/);
  });

  it("includes count and concurrency on top-level parallel mode", () => {
    const taskSchemaOwner = getPropertySchema(SubagentParams, ["tasks"]);
    const taskItemsSchema = isSchemaObject(taskSchemaOwner?.items)
      ? taskSchemaOwner.items
      : undefined;
    const taskProperties: unknown = taskItemsSchema?.properties;
    const taskSchema = isSchemaObject(taskProperties) ? taskProperties : undefined;
    const taskCountSchema = isSchemaObject(taskSchema?.count) ? taskSchema.count : undefined;
    assert.ok(taskCountSchema, "tasks[].count schema should exist");
    assert.equal(taskCountSchema.minimum, 1);
    assert.equal(taskItemsSchema?.additionalProperties, false, "tasks[] items must be fail-closed");
    assert.deepEqual(
      Object.keys(taskSchema ?? {}).sort(),
      [
        "agent",
        "task",
        "ticket",
        "count",
        "output",
        "outputMode",
        "reads",
        "progress",
        "model",
      ].sort(),
      "tasks[] allowlist mismatch",
    );
    assert.equal(taskSchema?.cwd, undefined, "tasks[] must not expose cwd");
    const outputSchema = isSchemaObject(taskSchema?.output) ? taskSchema.output : undefined;
    assert.equal(outputSchema?.type, undefined);
    assert.equal(hasAnyOfType(outputSchema, "string"), true);
    assert.equal(hasAnyOfType(outputSchema, "boolean"), true);
    const readsSchema = isSchemaObject(taskSchema?.reads) ? taskSchema.reads : undefined;
    assert.equal(readsSchema?.type, undefined);
    assert.equal(hasAnyOfArrayWithStringItems(readsSchema), true);
    assert.equal(hasAnyOfType(readsSchema, "boolean"), true);
    const progressSchema = isSchemaObject(taskSchema?.progress) ? taskSchema.progress : undefined;
    assert.equal(progressSchema?.type, "boolean");

    const concurrencySchema = getPropertySchema(SubagentParams, ["concurrency"]);
    assert.ok(concurrencySchema, "concurrency schema should exist");
    assert.equal(concurrencySchema.minimum, 1);
    assert.match(String(concurrencySchema.description ?? ""), /parallel/i);
  });

  it("requires explicit ticket metadata for bundled developer dispatches", () => {
    const taskSchemaOwner = getPropertySchema(SubagentParams, ["tasks"]);
    const taskItemsSchema = isSchemaObject(taskSchemaOwner?.items)
      ? taskSchemaOwner.items
      : undefined;
    const taskProperties = isSchemaObject(taskItemsSchema?.properties)
      ? taskItemsSchema.properties
      : undefined;
    const taskTicketSchema = isSchemaObject(taskProperties?.ticket)
      ? taskProperties.ticket
      : undefined;
    assert.ok(taskTicketSchema, "tasks[].ticket schema should exist");
    assert.equal(taskTicketSchema.type, "string");
    assert.equal(taskTicketSchema.minLength, 1);
    const topLevelTicketSchema = getPropertySchema(SubagentParams, ["ticket"]);
    assert.ok(topLevelTicketSchema, "top-level ticket schema should exist");
    assert.equal(topLevelTicketSchema.type, "string");
    assert.equal(topLevelTicketSchema.minLength, 1);
    const description = String(topLevelTicketSchema.description ?? "");
    assert.match(description, /developer-only/i);
    assert.match(description, /required.*bundled TLH developer/i);
    assert.match(description, /task text.*not used.*infer/i);
  });

  it("action is a closed enum with exactly the TLH-minimal management values", () => {
    const actionSchema = getPropertySchema(SubagentParams, ["action"]);
    assert.ok(actionSchema, "action schema should exist");
    assert.equal(actionSchema.type, "string");
    assert.deepEqual(actionSchema.enum, [
      "list",
      "get",
      "status",
      "interrupt",
      "resume",
      "steer",
      "doctor",
    ]);
    const description = String(actionSchema.description ?? "");
    assert.match(description, /Management action/);
    assert.match(description, /list/);
    assert.match(description, /interrupt/);
    assert.match(description, /resume/);
  });

  it("includes foreground timeout", () => {
    const timeoutSchema = getPropertySchema(SubagentParams, ["timeoutMs"]);
    assert.ok(timeoutSchema, "timeoutMs schema should exist");
    assert.equal(timeoutSchema.minimum, 1);
    assert.match(String(timeoutSchema.description ?? ""), /foreground and async\/background/i);
    assert.doesNotMatch(String(timeoutSchema.description ?? ""), /foreground-only/i);
  });

  it("includes id, index, and message control parameters", () => {
    const idSchema = getPropertySchema(SubagentParams, ["id"]);
    assert.ok(idSchema, "id schema should exist");
    assert.equal(idSchema.type, "string");
    assert.match(String(idSchema.description ?? ""), /status/i);
    assert.match(String(idSchema.description ?? ""), /interrupt/i);
    assert.match(String(idSchema.description ?? ""), /resume/i);
    assert.match(String(idSchema.description ?? ""), /durable paused-awaiting-supervisor/i);
    const asyncSchema = getPropertySchema(SubagentParams, ["async"]);
    assert.match(String(asyncSchema?.description ?? ""), /detached background work/i);
    const messageSchema = getPropertySchema(SubagentParams, ["message"]);
    assert.match(String(messageSchema?.description ?? ""), /omit for unchanged resume/i);
  });

  it("does not emit description-only schema nodes", () => {
    const descriptionOnlyPaths: string[] = [];

    for (const [name, schema] of Object.entries(schemas)) {
      const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (!current.value || typeof current.value !== "object") continue;

        const node = current.value as JsonSchemaNode;
        if (
          Object.hasOwn(node, "description") &&
          !Object.hasOwn(node, "type") &&
          !Object.hasOwn(node, "anyOf")
        ) {
          descriptionOnlyPaths.push(current.path);
        }

        if (Array.isArray(current.value)) {
          current.value.forEach((value, index) =>
            stack.push({ path: `${current.path}[${index}]`, value }),
          );
          continue;
        }

        for (const [key, value] of Object.entries(node)) {
          stack.push({ path: `${current.path}.${key}`, value });
        }
      }
    }

    assert.deepEqual(descriptionOnlyPaths, []);
  });

  it("does not emit array-typed schema nodes without items", () => {
    const missingItemsPaths: string[] = [];

    for (const [name, schema] of Object.entries(schemas)) {
      const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (!current.value || typeof current.value !== "object") continue;

        const node = current.value as JsonSchemaNode;
        if (node.type === "array" && !Object.hasOwn(node, "items")) {
          missingItemsPaths.push(current.path);
        }

        if (Array.isArray(current.value)) {
          current.value.forEach((value, index) =>
            stack.push({ path: `${current.path}[${index}]`, value }),
          );
          continue;
        }

        for (const [key, value] of Object.entries(node)) {
          stack.push({ path: `${current.path}.${key}`, value });
        }
      }
    }

    assert.deepEqual(missingItemsPaths, []);
  });

  it("keeps only top-level parameter descriptions to keep the provider payload compact", () => {
    assert.ok(SubagentParams, "SubagentParams schema should exist");
    const schema = SubagentParams;
    const serialized = JSON.stringify(schema);
    assert.ok(
      serialized.length < 15_000,
      `expected compact schema under 15k chars, got ${serialized.length}`,
    );
    assert.equal(serialized.includes('"$ref"'), false);
    assert.equal(serialized.includes('"$defs"'), false);
    const agentDescription = String(getPropertySchema(schema, ["agent"])?.description ?? "");
    assert.match(agentDescription, /SINGLE mode/);
    assert.match(agentDescription, /action='get'/);
    assert.doesNotMatch(agentDescription, /update|delete/);

    const nestedDescriptionPaths: string[] = [];
    const stack: Array<{ path: string; value: unknown }> = [
      { path: "SubagentParams", value: schema },
    ];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (!current.value || typeof current.value !== "object") continue;
      const node = current.value as JsonSchemaNode;
      const pathParts = current.path.split(".");
      const isTopLevelParameter =
        pathParts.length === 3 &&
        pathParts[0] === "SubagentParams" &&
        pathParts[1] === "properties";
      if (typeof node.description === "string" && !isTopLevelParameter)
        nestedDescriptionPaths.push(`${current.path}.description`);
      if (Array.isArray(current.value)) {
        current.value.forEach((value, index) =>
          stack.push({ path: `${current.path}[${index}]`, value }),
        );
      } else {
        for (const [key, value] of Object.entries(node))
          stack.push({ path: `${current.path}.${key}`, value });
      }
    }
    assert.deepEqual(nestedDescriptionPaths, []);
  });

  it("preserves TypeBox metadata while pruning provider-visible descriptions", () => {
    assert.ok(SubagentParams, "SubagentParams schema should exist");
    const schema = SubagentParams;
    const rootKind = Object.getOwnPropertyDescriptor(schema, "~kind");
    assert.equal(rootKind?.value, "Object");
    assert.equal(rootKind?.enumerable, false);

    const agentSchema = getPropertySchema(schema, ["agent"]);
    assert.equal(Object.getOwnPropertyDescriptor(agentSchema, "~kind")?.enumerable, false);
    assert.equal(Object.getOwnPropertyDescriptor(agentSchema, "~optional")?.value, true);
    assert.equal(Object.getOwnPropertyDescriptor(agentSchema, "~optional")?.enumerable, false);

    const tasksSchema = getPropertySchema(schema, ["tasks"]);
    const taskItemsSchema = isSchemaObject(tasksSchema?.items) ? tasksSchema.items : undefined;
    const taskCountSchema = getPropertySchema(taskItemsSchema, ["count"]);
    assert.equal(Object.getOwnPropertyDescriptor(taskCountSchema, "~kind")?.enumerable, false);
    assert.equal(Object.getOwnPropertyDescriptor(taskCountSchema, "~optional")?.value, true);
    assert.equal(Object.getOwnPropertyDescriptor(taskCountSchema, "~optional")?.enumerable, false);
  });

  it("does not emit provider-rejected schema shapes", () => {
    const rejectedPaths: string[] = [];
    const rejectedKeywords = ["allOf", "const", "if", "then", "not"];

    for (const [name, schema] of Object.entries(schemas)) {
      const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (!current.value || typeof current.value !== "object") continue;

        const node = current.value as JsonSchemaNode;
        if (Array.isArray(node.type)) {
          rejectedPaths.push(`${current.path}.type`);
        }
        if (Object.hasOwn(node, "anyOf") && Object.hasOwn(node, "type")) {
          rejectedPaths.push(`${current.path}.type+anyOf`);
        }
        for (const keyword of rejectedKeywords) {
          if (Object.hasOwn(node, keyword)) rejectedPaths.push(`${current.path}.${keyword}`);
        }

        if (Array.isArray(current.value)) {
          current.value.forEach((value, index) =>
            stack.push({ path: `${current.path}[${index}]`, value }),
          );
          continue;
        }

        for (const [key, value] of Object.entries(node)) {
          stack.push({ path: `${current.path}.${key}`, value });
        }
      }
    }

    assert.deepEqual(rejectedPaths, []);
  });

  it("uses provider-friendly anyOf unions for flexible top-level fields", () => {
    const outputSchema = getPropertySchema(SubagentParams, ["output"]);
    assert.ok(outputSchema, "output schema should exist");
    assert.equal(outputSchema.type, undefined);
    assert.equal(hasAnyOfType(outputSchema, "string"), true);
    assert.equal(hasAnyOfType(outputSchema, "boolean"), true);
  });

  it("validates representative flexible field values with TypeBox compiler", () => {
    assert.ok(SubagentParams, "SubagentParams schema should exist");
    assert.ok(CompileSchema, "TypeBox compiler should exist");
    const validator = CompileSchema(SubagentParams);
    const validValues = [
      { agent: "reviewer", task: "check this" },
      { tasks: [{ agent: "reviewer", task: "check this", reads: false }] },
      {
        tasks: [
          {
            agent: "reviewer",
            task: "check this",
            output: "review.md",
            reads: ["input.md"],
            progress: true,
          },
        ],
      },
      { tasks: [{ agent: "reviewer", task: "check this", model: "anthropic/claude-sonnet-4" }] },
      { agent: "worker", task: "Fix", timeoutMs: 1000 },
      { action: "status", id: "run-1" },
      { action: "interrupt", id: "run-1" },
      { action: "resume", id: "run-1", message: "focus on tests" },
      { action: "resume", id: "run-1", index: 0, message: "focus on tests" },
      { action: "steer", id: "run-1", message: "focus on error handling" },
      { action: "steer", id: "run-1", message: "adjust approach", index: 0 },
      { action: "list" },
      { action: "get", agent: "developer" },
      { action: "doctor" },
      { agent: "worker", task: "Fix", output: "out.md" },
      { agent: "worker", task: "Fix", output: false },
      { agent: "worker", task: "Fix", fallbackModels: ["openai/gpt-4o"] },
      { tasks: [{ agent: "worker", task: "Fix" }], concurrency: 2 },
      { agent: "worker", task: "Fix", context: "fresh" },
      { agent: "worker", task: "Fix", context: "fork" },
      { agent: "worker", task: "Fix", agentScope: "user" },
      { agent: "worker", task: "Fix", artifacts: false, includeProgress: true },
      { agent: "worker", task: "Fix", async: true },
    ];
    const invalidValues = [
      { output: 123 },
      { timeoutMs: 0 },
      { tasks: [{ agent: "reviewer", task: "check this", reads: "input.md" }] },
      { tasks: [{ agent: "reviewer", task: "check this", cwd: "/tmp" }] },
      { tasks: [{ agent: "reviewer", task: "check this", arbitrary: true }] },
      {
        tasks: [
          { agent: "reviewer", task: "check this", output: "ok.md", nested: { surprise: true } },
        ],
      },
      // action enum violations
      { action: "create" },
      { action: "not-a-real-action" },
      // additionalProperties: false violations at root
      { skill: "review" },
      { chain: [{ agent: "reviewer" }] },
      { clarify: true },
      { maxRuntimeMs: 1000 },
      { acceptance: "checked" },
      { config: { name: "reviewer" } },
      { runId: "run-1" },
      { turnBudget: { maxTurns: 5 } },
      { toolBudget: { hard: 3 } },
      { share: true },
      { sessionDir: "/tmp/session" },
      { control: {} },
      { dir: "/tmp" },
      { view: "fleet" },
      { lines: 80 },
      { scheduleName: "nightly" },
      { chainDir: "/tmp/chain" },
      { chainName: "my-chain" },
      { schedule: "+10m" },
    ];

    for (const value of validValues) {
      assert.doesNotThrow(
        () => validator.Check(value),
        `validator should not throw for ${JSON.stringify(value)}`,
      );
      assert.equal(
        validator.Check(value),
        true,
        `${JSON.stringify(value)} should validate: ${[...validator.Errors(value)].map((error) => error.message).join(", ")}`,
      );
    }
    for (const value of invalidValues) {
      assert.equal(validator.Check(value), false, `${JSON.stringify(value)} should not validate`);
    }
  });

  it("serialized byte size is within token-budget ceiling", () => {
    assert.ok(SubagentParams, "SubagentParams schema should exist");
    const serialized = JSON.stringify(SubagentParams);
    assert.ok(
      serialized.length <= 4600,
      `SubagentParams serialized byte size ${serialized.length} exceeds 4600-byte ceiling`,
    );
  });

  it("top-level property allowlist and action enum match TLH-minimal contract snapshot", () => {
    assert.ok(SubagentParams, "SubagentParams schema should exist");
    const schema = SubagentParams;
    const properties = isSchemaObject(schema.properties) ? schema.properties : {};
    const actualProps = Object.keys(properties).sort();
    const expectedProps = [
      "agent",
      "task",
      "tasks",
      "ticket",
      "concurrency",
      "context",
      "async",
      "action",
      "id",
      "index",
      "message",
      "agentScope",
      "output",
      "outputMode",
      "model",
      "fallbackModels",
      "timeoutMs",
      "cwd",
      "artifacts",
      "includeProgress",
    ].sort();
    assert.deepEqual(actualProps, expectedProps, "top-level property allowlist mismatch");
    const actionEnum = getPropertySchema(schema, ["action"])?.enum;
    assert.deepEqual(
      actionEnum,
      ["list", "get", "status", "interrupt", "resume", "steer", "doctor"],
      "action enum mismatch",
    );
    assert.equal(schema.additionalProperties, false, "root must have additionalProperties: false");
  });

  it("rejects removed top-level parameters and removed action values", () => {
    assert.ok(SubagentParams, "SubagentParams schema should exist");
    assert.ok(CompileSchema, "TypeBox compiler should exist");
    const validator = CompileSchema(SubagentParams);
    const removedKeys = [
      "clarify",
      "share",
      "schedule",
      "scheduleName",
      "chain",
      "chainName",
      "config",
      "control",
      "dir",
      "view",
      "lines",
      "sessionDir",
      "runId",
      "maxRuntimeMs",
      "toolBudget",
      "turnBudget",
      "acceptance",
      "skill",
      "chainDir",
      "__unknown__",
    ];
    const removedNestedTaskKeys = [
      "cwd",
      "clarify",
      "share",
      "chain",
      "chainName",
      "skill",
      "acceptance",
      "toolBudget",
      "fallbackModels",
      "modelFallbackNotice",
      "outputSchema",
      "arbitrary",
    ];
    for (const key of removedKeys) {
      const value = { [key]: "test" };
      assert.equal(
        validator.Check(value),
        false,
        `{ ${key}: ... } should be rejected by additionalProperties: false`,
      );
    }
    const removedActions = [
      "single",
      "parallel",
      "tasks",
      "create",
      "update",
      "delete",
      "eject",
      "disable",
      "enable",
      "reset",
      "append-step",
      "schedule-list",
      "models",
    ];
    for (const action of removedActions) {
      assert.equal(
        validator.Check({ action }),
        false,
        `action '${action}' should be rejected (not in enum)`,
      );
    }
    for (const key of removedNestedTaskKeys) {
      assert.equal(
        validator.Check({ tasks: [{ agent: "reviewer", task: "check this", [key]: "test" }] }),
        false,
        `tasks[].${key} should be rejected by additionalProperties: false`,
      );
    }
    assert.equal(
      validator.Check({
        tasks: [
          { agent: "reviewer", task: "check this", output: "ok.md", nested: { surprise: true } },
        ],
      }),
      false,
      "tasks[].nested should be rejected by additionalProperties: false",
    );
  });
});
