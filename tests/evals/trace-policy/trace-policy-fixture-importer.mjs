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
	return /(?:token|secret|password|passwd|api[_-]?keys?|auth(?:orization)?|cookie|session)/i.test(normalizeText(key));
}

const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const GENERATED_ID_PATTERN = /\b(?:(?:call|msg|req|run|toolu|trace)_(?=[a-z0-9_-]*\d)[a-z0-9_-]{6,}|(?:req|session|trace)-(?=[a-z0-9_-]*\d)[a-z0-9_-]{6,})\b/gi;
const LONG_HEX_ID_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s"']+/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|AUTH)[A-Z0-9_]*)=([^\s"']+|"[^"]*"|'[^']*')/gi;
const WINDOWS_HOME_PATTERN = /[A-Za-z]:\\Users\\[^\\/:\s]+(?:\\[^\\\s"')\]]+)*/g;
const WINDOWS_TEMP_PATTERN = /[A-Za-z]:\\(?:Users\\[^\\/:\s]+\\AppData\\Local\\Temp|Temp)(?:\\[^\\\s"')\]]+)*/g;
const POSIX_HOME_PATTERN = /\/(?:Users|home)\/[^/:\s"')\]]+(?:\/[^\s"')\]]+)*/g;
const ROOT_HOME_PATTERN = /\/root(?:\/[^\s"')\]]+)*/g;
const POSIX_TEMP_PATTERN = /(?<!<HOME>)\/(?:private\/tmp|tmp|var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/T)?)(?:\/[^\s"')\]]+)*/g;

function replacePathRoot(rawPath, rootPattern, replacement) {
	return rawPath.replace(rootPattern, (match) => {
		const normalized = match.replaceAll("\\", "/");
		const segments = normalized.split("/").filter(Boolean);
		const remainder = replacement === "<HOME>"
			? segments.slice(normalized.startsWith("/root") ? 1 : normalized.match(/^[A-Za-z]:\//) ? 3 : 2)
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
			return normalizeString(normalizeText(entry.text || entry.value || entry.content || entry.output_text || entry.outputText));
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
		const normalizedEntryValue = normalizeValue(entryValue, entryKey, sensitiveContext || isSensitiveKey(entryKey));
		if (normalizedEntryValue !== undefined) {
			output[entryKey] = normalizedEntryValue;
		}
	}
	return output;
}

function normalizeToolName(step) {
	return normalizeText(step.tool || step.name || step.tool_name || step.toolName);
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

function toStep(record) {
	if (!isRecord(record)) {
		return undefined;
	}
	if (isRecord(record.message)) {
		return toStep({ ...record, ...record.message });
	}

	const type = normalizeText(record.type).toLowerCase();
	const role = normalizeText(record.role || record.actor || record.sender).toLowerCase();
	if (type === "assistant" || role === "assistant") {
		return normalizeAssistantLikeStep("assistant", record);
	}
	if (type === "user" || role === "user") {
		return normalizeAssistantLikeStep("user", record);
	}
	if (type === "tool" || role === "tool" || normalizeToolName(record)) {
		return normalizeToolStep(record);
	}
	return undefined;
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

function extractAgent(source, fallbackAgent) {
	const directAgent = normalizeText(source?.agent || source?.role || source?.actor);
	if (directAgent) {
		return normalizeString(directAgent);
	}
	return normalizeString(fallbackAgent || "developer");
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
	throw new Error("trace input does not include a recognizable steps/events/messages array");
}

export function importTracePolicyFixtureFromText(text, options = {}) {
	const parsed = parseTraceInput(text);
	const transcriptSource = isRecord(parsed?.transcript) ? parsed.transcript : parsed;
	const steps = extractStepRecords(parsed)
		.map((step) => toStep(step))
		.filter(Boolean);
	if (steps.length === 0) {
		throw new Error("trace input did not yield any assistant/user/tool steps");
	}

	const fixtureSource = options.id || options.inputPath || "imported-trace";
	const fixtureSourceName = basename(fixtureSource, extname(fixtureSource));
	const fixtureId = sanitizeFixtureId(fixtureSourceName);
	const agent = extractAgent(transcriptSource, options.agent);
	return {
		id: fixtureId,
		name: normalizeString(options.name || `imported ${titleFromFixtureId(fixtureId)}`),
		expectedResult: options.expectedResult === "reject" ? "reject" : "allow",
		valid: options.expectedResult === "reject" ? false : true,
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
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return formatScalar(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "[]";
		}
		return `[` + value.map((entry) => `\n${childPad}${formatFixtureValue(entry, indent + 1)}`).join(",") + `\n${pad}]`;
	}
	const entries = Object.entries(value);
	if (entries.length === 0) {
		return "{}";
	}
	return `{` + entries.map(([key, entryValue]) => `\n${childPad}${formatObjectKey(key)}: ${formatFixtureValue(entryValue, indent + 1)}`).join(",") + `\n${pad}}`;
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
		throw new Error("usage: node tests/evals/trace-policy/trace-policy-fixture-importer.mjs <trace.json|trace.jsonl> [--agent NAME] [--id ID] [--name TEXT] [--allow|--reject]");
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
