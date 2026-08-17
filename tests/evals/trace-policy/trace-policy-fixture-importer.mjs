import { readFileSync } from "node:fs";
import process from "node:process";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeFixtureId(value) {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "imported-trace";
}

function titleFromFixtureId(value) {
  return sanitizeFixtureId(value).replace(/-/g, " ");
}

function isSensitiveKey(key) {
  return /(?:token|secret|password|passwd|api[_-]?keys?|auth(?:orization)?|bearer|cookie|session)/i.test(
    normalizeText(key),
  );
}

const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const GENERATED_ID_PATTERN =
  /\b(?:(?:call|msg|req|run|toolu|trace)_(?=[a-z0-9_-]*\d)[a-z0-9_-]{6,}|(?:req|session|trace)-(?=[a-z0-9_-]*\d)[a-z0-9_-]{6,})\b/gi;
const LONG_HEX_ID_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s"']+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|AUTH|BEARER)[A-Z0-9_]*)=([^\s"']+|"[^"]*"|'[^']*')/gi;
const WINDOWS_HOME_PATTERN = /[A-Za-z]:\\Users\\[^\\/:\s]+(?:\\[^\\\s"')\]]+)*/g;
const WINDOWS_TEMP_PATTERN =
  /[A-Za-z]:\\(?:Users\\[^\\/:\s]+\\AppData\\Local\\Temp|Temp)(?:\\[^\\\s"')\]]+)*/g;
const POSIX_HOME_PATTERN = /\/(?:Users|home)\/[^/:\s"')\]]+(?:\/[^\s"')\]]+)*/g;
const ROOT_HOME_PATTERN = /\/root(?:\/[^\s"')\]]+)*/g;
const POSIX_TEMP_PATTERN =
  /(?<!<HOME>)\/(?:private\/tmp|tmp|var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/T)?)(?:\/[^\s"')\]]+)*/g;

function replacePathRoot(rawPath, rootPattern, replacement) {
  return rawPath.replace(rootPattern, (match) => {
    const normalized = match.replaceAll("\\", "/");
    const segments = normalized.split("/").filter(Boolean);
    const remainder =
      replacement === "<HOME>"
        ? segments.slice(
            normalized.startsWith("/root") ? 1 : normalized.match(/^[A-Za-z]:\//) ? 3 : 2,
          )
        : normalized.startsWith("/var/folders/")
          ? segments.slice(segments[4] === "T" ? 5 : 4)
          : normalized.startsWith("/private/tmp/")
            ? segments.slice(2)
            : normalized.startsWith("/tmp/")
              ? segments.slice(1)
              : normalized.match(/^[A-Za-z]:\//)
                ? replacement === "<HOME>"
                  ? segments.slice(3)
                  : segments.slice(segments[1] === "Users" ? 6 : 1)
                : [];
    return remainder.length > 0 ? `${replacement}/${remainder.join("/")}` : replacement;
  });
}

function normalizeString(value) {
  let normalized = String(value);
  normalized = replacePathRoot(normalized, WINDOWS_TEMP_PATTERN, "<TMP>");
  normalized = replacePathRoot(normalized, WINDOWS_HOME_PATTERN, "<HOME>");
  normalized = replacePathRoot(normalized, POSIX_HOME_PATTERN, "<HOME>");
  normalized = replacePathRoot(normalized, ROOT_HOME_PATTERN, "<HOME>");
  normalized = replacePathRoot(normalized, POSIX_TEMP_PATTERN, "<TMP>");
  normalized = normalized.replace(ISO_TIMESTAMP_PATTERN, "<TIMESTAMP>");
  normalized = normalized.replace(UUID_PATTERN, "<UUID>");
  normalized = normalized.replace(GENERATED_ID_PATTERN, "<ID>");
  normalized = normalized.replace(LONG_HEX_ID_PATTERN, "<ID>");
  normalized = normalized.replace(BEARER_PATTERN, "Bearer <REDACTED>");
  normalized = normalized.replace(SECRET_ASSIGNMENT_PATTERN, "$1=<REDACTED>");
  return normalized;
}

function normalizeContentText(value) {
  if (typeof value === "string") {
    return normalizeString(value);
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return normalizeString(entry);
      }
      if (!isRecord(entry)) {
        return "";
      }
      return normalizeString(
        normalizeText(
          entry.text || entry.value || entry.content || entry.output_text || entry.outputText,
        ),
      );
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

const VOLATILE_FIELD_KEYS = new Set([
  "id",
  "uuid",
  "timestamp",
  "timestamp_ms",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "startedAt",
  "started_at",
  "finishedAt",
  "finished_at",
  "ts",
  "trace_id",
  "request_id",
  "response_id",
  "message_id",
  "session_id",
  "run_id",
]);

function normalizeValue(value, key, sensitiveContext = false) {
  if (sensitiveContext || isSensitiveKey(key)) {
    return "<REDACTED>";
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return normalizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, undefined, sensitiveContext));
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const output = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (VOLATILE_FIELD_KEYS.has(entryKey)) {
      continue;
    }
    const normalizedEntryValue = normalizeValue(
      entryValue,
      entryKey,
      sensitiveContext || isSensitiveKey(entryKey),
    );
    if (normalizedEntryValue !== undefined) {
      output[entryKey] = normalizedEntryValue;
    }
  }
  return output;
}

function normalizeToolName(step) {
  return normalizeText(step.tool || step.name || step.tool_name || step.toolName);
}

function flattenMessageRecord(record) {
  if (!isRecord(record)) {
    return record;
  }
  return isRecord(record.message) ? { ...record, ...record.message } : record;
}

function normalizeAssistantLikeStep(type, step) {
  const normalized = { type };
  const action = normalizeText(step.action);
  const text = normalizeContentText(step.text || step.content || step.message || step.output);
  if (action) {
    normalized.action = normalizeString(action);
  }
  if (text) {
    normalized.text = text;
  }
  return normalized;
}

const TOOL_STEP_PROMOTED_ARGUMENT_KEYS = new Set([
  "command",
  "path",
  "query",
  "url",
  "status",
  "argv",
  "exitCode",
  "ok",
  "mutates",
]);

function toolStepFromToolCallBlock(block) {
  const argumentsValue = isRecord(block.arguments) ? block.arguments : {};
  const step = {
    type: "tool",
    tool: block.name,
    ...argumentsValue,
  };
  if (Object.keys(argumentsValue).some((key) => !TOOL_STEP_PROMOTED_ARGUMENT_KEYS.has(key))) {
    step.input = argumentsValue;
  }
  return normalizeToolStep(step);
}

function normalizeToolStep(step) {
  const normalized = {
    type: "tool",
    tool: normalizeString(normalizeToolName(step) || "unknown-tool"),
  };
  for (const key of ["command", "path", "query", "url", "status"]) {
    if (typeof step[key] === "string") {
      normalized[key] = normalizeString(step[key]);
    }
  }
  if (Array.isArray(step.argv)) {
    normalized.argv = step.argv.map((entry) => normalizeString(String(entry)));
  }
  if (typeof step.exitCode === "number") {
    normalized.exitCode = step.exitCode;
  }
  if (typeof step.ok === "boolean") {
    normalized.ok = step.ok;
  }
  if (typeof step.mutates === "boolean") {
    normalized.mutates = step.mutates;
  }
  if (step.input !== undefined) {
    normalized.input = normalizeValue(step.input, "input");
  }
  return normalized;
}

function isToolResultRecord(record) {
  return (
    normalizeText(record?.role || record?.actor || record?.sender).toLowerCase() === "toolresult"
  );
}

function normalizeToolResultFailure(step) {
  const details = isRecord(step.details) ? step.details : {};
  const exitCode = Number.isInteger(step.exitCode)
    ? step.exitCode
    : Number.isInteger(details.exitCode)
      ? details.exitCode
      : undefined;
  const ok =
    typeof step.ok === "boolean"
      ? step.ok
      : typeof details.ok === "boolean"
        ? details.ok
        : undefined;
  const rawStatus =
    typeof step.status === "string"
      ? step.status
      : typeof details.status === "string"
        ? details.status
        : undefined;
  const status = rawStatus ? normalizeString(rawStatus) : undefined;
  const failed =
    step.isError === true ||
    ok === false ||
    status === "failed" ||
    (Number.isInteger(exitCode) && exitCode !== 0);
  if (!failed) {
    return undefined;
  }
  const normalized = {
    ok: false,
    status: status || "failed",
  };
  if (Number.isInteger(exitCode)) {
    normalized.exitCode = exitCode;
  }
  return normalized;
}

function toolStepFromToolResultRecord(record) {
  const normalized = normalizeToolStep({
    type: "tool",
    tool: normalizeToolName(record) || "unknown-tool",
    ...normalizeToolResultFailure(record),
  });
  return normalized;
}

function normalizeTraceSteps(records) {
  const steps = [];
  const toolCallIndexes = new Map();

  for (const rawRecord of records) {
    const record = flattenMessageRecord(rawRecord);
    if (!isRecord(record)) {
      continue;
    }

    const type = normalizeText(record.type).toLowerCase();
    const role = normalizeText(record.role || record.actor || record.sender).toLowerCase();
    if (type === "assistant" || role === "assistant") {
      const assistantStep = normalizeAssistantLikeStep("assistant", record);
      if (assistantStep.action || assistantStep.text) {
        steps.push(assistantStep);
      }
      if (Array.isArray(record.content)) {
        for (const block of record.content) {
          if (!isRecord(block) || normalizeText(block.type) !== "toolCall") {
            continue;
          }
          steps.push(toolStepFromToolCallBlock(block));
          const toolCallId = normalizeText(block.id);
          if (toolCallId) {
            toolCallIndexes.set(toolCallId, steps.length - 1);
          }
        }
      }
      continue;
    }
    if (type === "user" || role === "user") {
      steps.push(normalizeAssistantLikeStep("user", record));
      continue;
    }
    if (isToolResultRecord(record)) {
      const toolCallId = normalizeText(record.toolCallId);
      const toolCallIndex = toolCallId ? toolCallIndexes.get(toolCallId) : undefined;
      if (toolCallIndex !== undefined) {
        const failure = normalizeToolResultFailure(record);
        if (failure) {
          steps[toolCallIndex] = {
            ...steps[toolCallIndex],
            ...failure,
          };
        }
        continue;
      }
      steps.push(toolStepFromToolResultRecord(record));
      continue;
    }
    if (type === "tool" || role === "tool" || normalizeToolName(record)) {
      steps.push(normalizeToolStep(record));
    }
  }

  return steps;
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`, { cause: error });
      }
    });
}

function parseTraceInput(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    throw new Error("trace input is empty");
  }
  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    try {
      return JSON.parse(normalized);
    } catch {
      return parseJsonLines(normalized);
    }
  }
  return parseJsonLines(normalized);
}

function extractAgent(source, fallbackAgent, options = {}) {
  const directAgent = options.allowRoleFallback
    ? normalizeText(source?.agent || source?.role || source?.actor)
    : normalizeText(source?.agent);
  if (directAgent) {
    return normalizeString(directAgent);
  }
  return normalizeString(fallbackAgent || "developer");
}

function isStandaloneTraceRecord(record) {
  return isRecord(record) && normalizeTraceSteps([record]).length > 0;
}

function extractStepRecords(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed?.steps)) {
    return parsed.steps;
  }
  if (Array.isArray(parsed?.transcript?.steps)) {
    return parsed.transcript.steps;
  }
  if (Array.isArray(parsed?.events)) {
    return parsed.events;
  }
  if (Array.isArray(parsed?.messages)) {
    return parsed.messages;
  }
  if (isStandaloneTraceRecord(parsed)) {
    return [parsed];
  }
  throw new Error("trace input does not include a recognizable steps/events/messages array");
}

function isStandaloneTraceSelection(parsed, records) {
  return isRecord(parsed) && records.length === 1 && records[0] === parsed;
}

export function importTracePolicyFixtureFromText(text, options = {}) {
  const parsed = parseTraceInput(text);
  const stepRecords = extractStepRecords(parsed);
  const standaloneTraceRecord = isStandaloneTraceSelection(parsed, stepRecords);
  const transcriptSource = isRecord(parsed?.transcript) ? parsed.transcript : parsed;
  const steps = normalizeTraceSteps(stepRecords).filter(Boolean);
  if (steps.length === 0) {
    throw new Error("trace input did not yield any assistant/user/tool steps");
  }

  const fixtureSource = options.id || options.inputPath || "imported-trace";
  const fixtureSourceName = basename(fixtureSource, extname(fixtureSource));
  const fixtureId = sanitizeFixtureId(fixtureSourceName);
  const agent = extractAgent(transcriptSource, options.agent, {
    allowRoleFallback: !standaloneTraceRecord,
  });
  return {
    id: fixtureId,
    name: normalizeString(options.name || `imported ${titleFromFixtureId(fixtureId)}`),
    expectedResult: options.expectedResult === "reject" ? "reject" : "allow",
    transcript: {
      agent,
      steps,
    },
  };
}

function formatScalar(value) {
  return JSON.stringify(value);
}

function formatObjectKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function formatFixtureValue(value, indent = 0) {
  const pad = "\t".repeat(indent);
  const childPad = "\t".repeat(indent + 1);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return formatScalar(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return (
      `[` +
      value.map((entry) => `\n${childPad}${formatFixtureValue(entry, indent + 1)}`).join(",") +
      `\n${pad}]`
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }
  return (
    `{` +
    entries
      .map(
        ([key, entryValue]) =>
          `\n${childPad}${formatObjectKey(key)}: ${formatFixtureValue(entryValue, indent + 1)}`,
      )
      .join(",") +
    `\n${pad}}`
  );
}

export function formatTracePolicyFixtureSkeleton(fixture) {
  return `${formatFixtureValue(fixture)},`;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent") {
      options.agent = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--id") {
      options.id = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--name") {
      options.name = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--reject") {
      options.expectedResult = "reject";
      continue;
    }
    if (arg === "--allow") {
      options.expectedResult = "allow";
      continue;
    }
    if (!options.inputPath) {
      options.inputPath = arg;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return options;
}

function readCliInput(inputPath) {
  if (inputPath) {
    return readFileSync(inputPath, "utf8");
  }
  if (process.stdin.isTTY) {
    throw new Error(
      "usage: node tests/evals/trace-policy/trace-policy-fixture-importer.mjs <trace.json|trace.jsonl> [--agent NAME] [--id ID] [--name TEXT] [--allow|--reject]",
    );
  }
  return readFileSync(0, "utf8");
}

function isCliEntryPoint() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isCliEntryPoint()) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const input = readCliInput(options.inputPath);
    const fixture = importTracePolicyFixtureFromText(input, options);
    process.stdout.write(`${formatTracePolicyFixtureSkeleton(fixture)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
