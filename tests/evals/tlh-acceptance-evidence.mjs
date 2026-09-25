#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import {
  createAcceptanceEvidenceScenarioResult,
  createAcceptanceEvidenceSuiteResult,
  createEvidenceScoreCheck,
} from "./tlh-live-eval-results.mjs";

export const ACCEPTANCE_EVIDENCE_REPORT_FILE = "acceptance-results.json";
export const ACCEPTANCE_SUITE_ID = "tlh-packaged-acceptance";
export const ACCEPTANCE_SUITE_VERSION = 1;
export const ACCEPTANCE_EVIDENCE_SCHEMA_VERSION = 1;

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const MACHINE_CHECK = "deterministic";
const MANUAL_CHECK = "manual";
const NATIVE_LIFECYCLE_ARTIFACT_VERSION = 1;
const acceptanceModelPattern = /^[^/\s]+\/[^\s:]+:(off|minimal|low|medium|high|xhigh|max)$/;
const allowedManifestStatuses = new Set(["prepared", "blocked", "pending", "failed", "passed"]);
const allowedSessionTypes = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const allowedSessionMessageRoles = new Set([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "hookMessage",
]);
const nativeEventTypes = new Set([
  "subagent.run.started",
  "subagent.run.completed",
  "subagent.run.pausing",
  "subagent.run.paused",
  "subagent.run.timed_out",
  "subagent.run.repaired_stale",
  "subagent.step.started",
  "subagent.step.completed",
  "subagent.step.failed",
  "subagent.step.paused",
  "subagent.resume.requested",
  "subagent.steer.requested",
  "subagent.control",
  "subagent.child.stdout",
  "subagent.child.stderr",
  "subagent.child.stderr.truncated",
  "subagent.child.stderr.overflow",
  "subagent.child.protocol_output_limit",
  "subagent.nested.started",
  "subagent.nested.updated",
  "subagent.nested.completed",
  "subagent.nested.interrupt_failed",
  "subagent.nested.timeout_failed",
  "subagent.events.truncated",
  "tool_execution_start",
  "tool_execution_end",
  "message_end",
  "tool_result_end",
]);
const nonCorrelatingNativeEventTypes = new Set([
  "subagent.control",
  "subagent.events.truncated",
  "subagent.nested.started",
  "subagent.nested.updated",
  "subagent.nested.completed",
  "subagent.nested.interrupt_failed",
  "subagent.nested.timeout_failed",
  "subagent.child.stdout",
  "subagent.child.stderr",
  "subagent.child.stderr.truncated",
  "subagent.child.stderr.overflow",
  "subagent.child.protocol_output_limit",
  "tool_execution_start",
  "tool_execution_end",
  "message_end",
  "tool_result_end",
]);
const evidenceKinds = new Set([
  "approval",
  "dispatch",
  "execution",
  "role-result",
  "job",
  "runtime",
  "session",
  "fixture-change",
  "fixture-test",
  "test-result",
  "human-review",
  "manual-review",
  "no-launch",
  "blocked-dispatch",
  "orchestration",
  "actor-trace",
  "assistant-claim",
  "source-validation",
  "capability",
  "lifecycle",
]);
const terminalStates = new Set([
  "complete",
  "completed",
  "failed",
  "paused",
  "continued",
  "cancelled",
]);

function isAssistantClaim(record) {
  return (
    record.kind === "assistant-claim" ||
    record.source === "assistant" ||
    record.assistantClaim === true ||
    record.modelClaim === true
  );
}

export class AcceptanceEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "AcceptanceEvidenceError";
  }
}

function fail(message) {
  throw new AcceptanceEvidenceError(message);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizePathValue(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function pathIsWithinRoot(target, root) {
  const child = resolve(target);
  const parent = resolve(root);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function assertNoSymlinkComponents(target, root, label, allowMissing = false) {
  if (!pathIsWithinRoot(target, root)) fail(`${label} escapes the evaluation workspace`);
  let current = resolve(root);
  const parts = relative(resolve(root), resolve(target)).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (allowMissing) return;
        fail(`${label} is missing: ${normalizePathValue(relative(root, target))}`);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) fail(`${label} contains a symlink component`);
  }
}

function resolveOwnedReference(workspace, value, label, { allowMissing = true } = {}) {
  const text = nonEmptyString(value);
  if (!text) fail(`${label} must be a non-empty relative path`);
  if (text.includes("\0")) fail(`${label} contains a NUL byte`);
  const normalized = normalizePathValue(text);
  const target = resolve(workspace, normalized);
  assertNoSymlinkComponents(target, workspace, label, allowMissing);
  if (!allowMissing && !existsSync(target)) fail(`${label} is missing`);
  return target;
}

function workspaceRelative(workspace, target) {
  const value = normalizePathValue(relative(resolve(workspace), resolve(target)));
  return value || ".";
}

function normalizeOwnedWorkspacePath(workspace, value, label) {
  if (!value) return "";
  const target = resolveOwnedReference(workspace, value, label, { allowMissing: true });
  return workspaceRelative(workspace, target);
}

function readOwnedFile(workspace, reference, label, maxBytes = MAX_TEXT_BYTES) {
  const target = resolveOwnedReference(workspace, reference, label, { allowMissing: false });
  const stats = lstatSync(target);
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (stats.size > maxBytes) fail(`${label} exceeds the offline evidence size limit`);
  return { target, text: readFileSync(target, "utf8") };
}

function readJsonFile(workspace, reference, label) {
  const { target, text } = readOwnedFile(workspace, reference, label, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) fail(`${label} must contain a JSON object`);
    return { target, value };
  } catch (error) {
    if (error instanceof AcceptanceEvidenceError) throw error;
    fail(`${label} is malformed JSON`);
  }
}

function parseStrictJsonlText(text, label) {
  if (!text) return [];
  if (!text.endsWith("\n")) fail(`${label} is truncated (JSONL has no terminating newline)`);
  const lines = text.split("\n");
  lines.pop();
  const records = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) fail(`${label} contains a blank JSONL line at ${index + 1}`);
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
      fail(`${label} contains an oversized JSONL line at ${index + 1}`);
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      fail(`${label} contains malformed JSON at line ${index + 1}`);
    }
    if (!isObject(value)) fail(`${label} line ${index + 1} must be a JSON object`);
    records.push({ value, line: index + 1 });
  }
  return records;
}

function readJsonlFile(workspace, reference, label) {
  const { target, text } = readOwnedFile(workspace, reference, label, MAX_JSON_BYTES);
  return {
    target,
    records: parseStrictJsonlText(text, label),
  };
}

function recordCandidateCommit(record) {
  const identity = isObject(record.identity) ? record.identity : {};
  const candidate = isObject(record.candidate) ? record.candidate : {};
  return nonEmptyString(
    record.candidateCommit ||
      identity.candidateCommit ||
      candidate.commit ||
      candidate.candidateCommit,
  );
}

function candidateIdentityMatches(record, manifest) {
  const expectedCommit = nonEmptyString(
    manifest.candidate?.commit || manifest.candidate?.candidateCommit,
  );
  return Boolean(expectedCommit && recordCandidateCommit(record) === expectedCommit);
}

function validateIdentity(record, manifest, sourceReference) {
  if (record.identity !== undefined && !isObject(record.identity))
    fail(`evidence ${sourceReference} has malformed identity`);
  if (record.candidate !== undefined && !isObject(record.candidate))
    fail(`evidence ${sourceReference} has malformed candidate identity`);
  if (
    isObject(record.candidate) &&
    ["commit", "candidateCommit"].some(
      (field) =>
        record.candidate[field] !== undefined && typeof record.candidate[field] !== "string",
    )
  ) {
    fail(`evidence ${sourceReference} has malformed candidate identity`);
  }
  const identity = isObject(record.identity) ? record.identity : {};
  for (const field of ["suiteId", "scenarioId", "candidateCommit"]) {
    if (record[field] !== undefined && typeof record[field] !== "string")
      fail(`evidence ${sourceReference} has malformed ${field}`);
  }
  for (const field of ["suiteId", "scenarioId", "candidateCommit"]) {
    if (identity[field] !== undefined && typeof identity[field] !== "string")
      fail(`evidence ${sourceReference} has malformed identity ${field}`);
  }
  const suiteId = nonEmptyString(record.suiteId || identity.suiteId);
  if (suiteId && suiteId !== manifest.suiteId) {
    fail(`evidence ${sourceReference} belongs to another suite`);
  }
  const scenarioId = nonEmptyString(record.scenarioId || identity.scenarioId);
  if (scenarioId && scenarioId !== manifest.scenarioId) {
    fail(`evidence ${sourceReference} belongs to another scenario`);
  }
  const candidateCommit = recordCandidateCommit(record);
  const expectedCommit = nonEmptyString(
    manifest.candidate?.commit || manifest.candidate?.candidateCommit,
  );
  if (candidateCommit && expectedCommit && candidateCommit !== expectedCommit) {
    fail(`evidence ${sourceReference} belongs to another candidate`);
  }
  if (
    record.checkId !== undefined &&
    (typeof record.checkId !== "string" || !record.checkId.trim())
  ) {
    fail(`evidence ${sourceReference} has a malformed check id`);
  }
  if (record.checkIds !== undefined && !Array.isArray(record.checkIds))
    fail(`evidence ${sourceReference} has malformed check ids`);
  if (
    Array.isArray(record.checkIds) &&
    record.checkIds.some((id) => typeof id !== "string" || !id.trim())
  )
    fail(`evidence ${sourceReference} has malformed check ids`);
  const checkId = nonEmptyString(record.checkId);
  if (checkId && !manifest.checkIds.has(checkId)) {
    fail(`evidence ${sourceReference} references an unknown check`);
  }
  for (const id of record.checkIds || []) {
    if (typeof id !== "string" || !manifest.checkIds.has(id)) {
      fail(`evidence ${sourceReference} references an unknown check`);
    }
  }
}

function normalizeEvidenceRecord(value, sourceReference, line, manifest, checkIds) {
  validateIdentity(value, manifest, sourceReference);
  const explicitKind = nonEmptyString(value.kind || value.evidenceKind || value.category);
  const type = nonEmptyString(value.type);
  let kind = explicitKind;
  if (!kind && nativeEventTypes.has(type)) kind = "runtime";
  if (!kind && (value.assistantClaim === true || value.modelClaim === true))
    kind = "assistant-claim";
  if (!kind) fail(`evidence ${sourceReference}:${line} has no recognized kind`);
  if (!evidenceKinds.has(kind)) fail(`evidence ${sourceReference}:${line} has an unknown kind`);
  const explicitIds = new Set();
  if (value.checkId) explicitIds.add(value.checkId);
  for (const id of value.checkIds || []) explicitIds.add(id);
  const ids = new Set(checkIds);
  for (const id of explicitIds) ids.add(id);
  return {
    ...value,
    kind,
    sourceReference,
    line,
    checkIds: [...ids].filter((id) => typeof id === "string"),
    explicitCheckIds: [...explicitIds].filter((id) => typeof id === "string"),
  };
}

function captureReferenceForManifest(manifest, reference) {
  const normalized = normalizePathValue(reference);
  if (normalized.startsWith("fixture/")) {
    const fixturePath = nonEmptyString(manifest.fixture?.workspacePath);
    if (!fixturePath) return "";
    return normalizePathValue(join(fixturePath, normalized.slice("fixture/".length)));
  }
  return normalized;
}

function manifestCaptureReferences(manifest) {
  const references = new Map();
  for (const check of manifest.checks) {
    for (const raw of check.captureLocations || check.capture?.locations || []) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const normalized = normalizePathValue(raw);
      if (!references.has(normalized)) references.set(normalized, new Set());
      references.get(normalized).add(check.id);
    }
  }
  return references;
}

function sessionMessageMalformed(message) {
  if (!isObject(message) || typeof message.role !== "string") return true;
  if (
    message.content !== undefined &&
    !Array.isArray(message.content) &&
    typeof message.content !== "string"
  )
    return true;
  const content = Array.isArray(message.content) ? message.content : [];
  if (
    content.some(
      (part) =>
        isObject(part) &&
        part.type === "toolCall" &&
        (typeof part.id !== "string" ||
          !part.id.trim() ||
          typeof part.name !== "string" ||
          !part.name.trim() ||
          !isObject(part.arguments)),
    )
  )
    return true;
  return (
    message.role === "toolResult" &&
    (typeof message.toolCallId !== "string" || !message.toolCallId.trim())
  );
}

function classifySessionMessage(message) {
  if (sessionMessageMalformed(message)) return null;
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  const toolCalls = content.filter(
    (part) =>
      isObject(part) &&
      part.type === "toolCall" &&
      typeof part.id === "string" &&
      typeof part.name === "string" &&
      isObject(part.arguments),
  );
  const text = content
    .filter((part) => isObject(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
  return {
    role: message.role,
    toolCalls,
    text,
    toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
    toolName: typeof message.toolName === "string" ? message.toolName : "",
    isError: message.isError === true,
    details: isObject(message.details) ? message.details : undefined,
  };
}

function parseSessionFile(workspace, reference, expected = {}) {
  const normalizedReference = normalizePathValue(reference);
  const { target, records } = readJsonlFile(workspace, normalizedReference, "session evidence");
  if (records.length < 1) fail("session evidence is empty");
  const header = records[0].value;
  if (header.type !== "session" || typeof header.id !== "string" || !header.id.trim()) {
    fail("session evidence does not start with a valid session header");
  }
  if (header.parentSession !== undefined && !nonEmptyString(header.parentSession)) {
    fail("session evidence header has a malformed parent session identity");
  }
  const version = header.version === undefined ? 1 : header.version;
  if (!Number.isInteger(version) || version < 1 || version > 3) fail("unsupported session version");
  if (header.timestamp !== undefined && Number.isNaN(Date.parse(header.timestamp)))
    fail("session evidence header has an invalid timestamp");
  const entries = [];
  const ids = new Set();
  let priorId = null;
  for (const [index, record] of records.slice(1).entries()) {
    const raw = record.value;
    if (!nonEmptyString(raw.type) || !allowedSessionTypes.has(raw.type)) {
      fail(`session evidence contains an unsupported entry type at line ${index + 2}`);
    }
    const id = version === 1 ? `legacy-${index + 1}` : nonEmptyString(raw.id);
    const parentId =
      version === 1 ? priorId : raw.parentId === null ? null : nonEmptyString(raw.parentId);
    if (!id) fail(`session evidence entry at line ${index + 2} has no id`);
    if (ids.has(id)) fail(`session evidence contains a duplicate entry id: ${id}`);
    if (parentId !== null && !parentId)
      fail(`session evidence entry ${id} has an invalid parent id`);
    const timestamp = nonEmptyString(raw.timestamp);
    const legacyMessageTimestamp = raw.message?.timestamp;
    if (version > 1 && (!timestamp || Number.isNaN(Date.parse(timestamp)))) {
      fail(`session evidence entry ${id} has an invalid timestamp`);
    }
    if (
      version === 1 &&
      timestamp &&
      Number.isNaN(Date.parse(timestamp)) &&
      !finiteNumber(legacyMessageTimestamp)
    ) {
      fail(`session evidence entry ${id} has an invalid timestamp`);
    }
    const classifiedMessage = raw.type === "message" ? classifySessionMessage(raw.message) : null;
    if (
      raw.type === "message" &&
      (!classifiedMessage || !allowedSessionMessageRoles.has(classifiedMessage.role))
    ) {
      fail(`session evidence message entry ${id} is malformed`);
    }
    if (
      raw.type === "compaction" &&
      raw.retainedTail !== undefined &&
      !Array.isArray(raw.retainedTail)
    ) {
      fail(`session evidence compaction entry ${id} has malformed retainedTail`);
    }
    if (
      raw.type === "compaction" &&
      Array.isArray(raw.retainedTail) &&
      raw.retainedTail.some((message) => {
        const classified = classifySessionMessage(message);
        return !classified || !allowedSessionMessageRoles.has(classified.role);
      })
    ) {
      fail(`session evidence compaction entry ${id} has malformed retainedTail messages`);
    }
    entries.push({ ...raw, id, parentId, line: index + 2 });
    ids.add(id);
    priorId = id;
  }
  const roots = entries.filter((entry) => entry.parentId === null);
  if (entries.length > 0 && roots.length !== 1)
    fail("session evidence does not have exactly one root");
  for (const entry of entries) {
    if (entry.parentId !== null && !ids.has(entry.parentId)) {
      fail(`session evidence entry ${entry.id} has an unknown parent`);
    }
    if (
      entry.type === "compaction" &&
      entry.firstKeptEntryId !== undefined &&
      !ids.has(entry.firstKeptEntryId)
    ) {
      fail(`session compaction ${entry.id} references an unknown retained entry`);
    }
  }
  const active = [];
  const activeIds = new Set();
  let cursor = entries.at(-1) || null;
  while (cursor) {
    if (activeIds.has(cursor.id)) fail("session evidence contains a parent cycle");
    activeIds.add(cursor.id);
    active.unshift(cursor);
    cursor =
      cursor.parentId === null ? null : entries.find((entry) => entry.id === cursor.parentId);
  }
  const abandoned = entries.filter((entry) => !activeIds.has(entry.id));
  const activeMessages = [];
  for (const entry of active) {
    if (entry.type === "message") activeMessages.push(classifySessionMessage(entry.message));
    if (entry.type === "compaction" && Array.isArray(entry.retainedTail)) {
      for (const message of entry.retainedTail)
        activeMessages.push(classifySessionMessage(message));
    }
  }
  const calls = new Map();
  const results = [];
  const resultIds = new Set();
  for (const message of activeMessages) {
    if (!message) continue;
    for (const call of message.toolCalls) {
      if (calls.has(call.id))
        fail(`session evidence repeats native tool-call identity: ${call.id}`);
      calls.set(call.id, call);
    }
    if (message.role === "toolResult") {
      if (resultIds.has(message.toolCallId)) {
        fail(`session evidence repeats native tool-result identity: ${message.toolCallId}`);
      }
      resultIds.add(message.toolCallId);
      results.push(message);
    }
  }
  const completedToolCalls = [];
  const unresolvedToolCalls = [];
  for (const call of calls.values()) {
    const result = results.find((candidate) => candidate.toolCallId === call.id);
    if (result) completedToolCalls.push({ call, result });
    else unresolvedToolCalls.push(call);
  }
  const supervisorCalls = completedToolCalls.filter(
    ({ call }) => call.name === "contact_supervisor",
  );
  const userMessages = active.filter((entry) => {
    if (entry.type !== "message") return false;
    return entry.message?.role === "user";
  });
  const parsed = {
    target,
    reference: workspaceRelative(workspace, target),
    header,
    id: header.id,
    version,
    entries,
    activeEntries: active,
    abandonedEntries: abandoned,
    activeEntryIds: [...activeIds],
    abandonedEntryIds: abandoned.map((entry) => entry.id),
    completedToolCalls,
    unresolvedToolCalls,
    supervisorCalls,
    userMessages,
  };
  if (expected.sessionId && expected.sessionId !== parsed.id) {
    fail("child/session identity association does not match the observed session header");
  }
  if (expected.entryId && !activeIds.has(expected.entryId)) {
    // This is intentionally incomplete rather than a pass: the entry may be
    // from an abandoned branch, which is not the active runtime evidence.
    parsed.expectedEntryActive = false;
  } else if (expected.entryId) parsed.expectedEntryActive = true;
  return parsed;
}

function sessionPathFromValue(workspace, value, label) {
  if (!value) return "";
  const target = resolveOwnedReference(workspace, value, label, { allowMissing: false });
  return workspaceRelative(workspace, target);
}

function nativeEventName(event) {
  const type = nonEmptyString(event.type);
  if (type) return type;
  return nonEmptyString(event.eventType);
}

function validateOptionalArtifactCandidate(value, manifest, label) {
  if (!isObject(value)) return;
  if (value.identity !== undefined && !isObject(value.identity))
    fail(`${label} has malformed identity`);
  if (value.candidate !== undefined && !isObject(value.candidate))
    fail(`${label} has malformed candidate identity`);
  const explicitCandidateFields = [
    value.candidateCommit,
    value.identity?.candidateCommit,
    value.candidate?.commit,
    value.candidate?.candidateCommit,
  ];
  if (
    explicitCandidateFields.some(
      (candidate) => candidate !== undefined && typeof candidate !== "string",
    )
  )
    fail(`${label} has malformed candidate identity`);
  const observed = recordCandidateCommit(value);
  const expected = nonEmptyString(
    manifest.candidate?.commit || manifest.candidate?.candidateCommit,
  );
  if (observed && expected && observed !== expected) fail(`${label} belongs to another candidate`);
}

function validateNativeEvent(event, runId, label, manifest) {
  validateOptionalArtifactCandidate(event, manifest, label);
  const type = nativeEventName(event);
  if (event.runId !== undefined && !nonEmptyString(event.runId))
    fail(`${label} contains a malformed run identity`);
  if (event.subagentRunId !== undefined && !nonEmptyString(event.subagentRunId))
    fail(`${label} contains a malformed child run identity`);
  const nativeRunId = nonEmptyString(event.runId);
  const childRunId = nonEmptyString(event.subagentRunId);
  const isChildProjection = event.subagentSource === "child" && Boolean(childRunId);
  const isUnknownChildProjection =
    isChildProjection && type && !nativeEventTypes.has(type) && !type.startsWith("subagent.");
  if (!type || (!nativeEventTypes.has(type) && !isUnknownChildProjection)) {
    fail(`${label} contains an unknown native event type`);
  }
  if (nativeRunId && childRunId && nativeRunId !== childRunId) {
    fail(`${label} contains disagreeing job identities`);
  }
  const eventRunId = nativeRunId || childRunId;
  if (eventRunId && eventRunId !== runId) fail(`${label} contains an event for another job`);
  if (!eventRunId && !nonCorrelatingNativeEventTypes.has(type)) {
    fail(`${label} contains an event with no job identity`);
  }
  if (event.ts !== undefined && !finiteNumber(event.ts))
    fail(`${label} contains an invalid event timestamp`);
  return {
    type,
    traceTruncated: type === "subagent.events.truncated",
  };
}

function resultState(value) {
  if (value === "completed") return "complete";
  return typeof value === "string" ? value : "";
}

function inspectJobRecord(workspace, record, context) {
  validateOptionalArtifactCandidate(record, context.manifest, "job evidence");
  const job = isObject(record.job) ? record.job : record;
  validateOptionalArtifactCandidate(job, context.manifest, "job payload");
  const runId = nonEmptyString(record.runId || record.jobId || job.runId || job.id);
  const hasJobPath = Boolean(
    record.asyncDir || job.asyncDir || record.statusPath || job.statusPath,
  );
  if (!runId && !hasJobPath) return null;
  if (!runId) fail(`job evidence ${record.sourceReference}:${record.line} has no run id`);
  const asyncDirReference = record.asyncDir || job.asyncDir;
  const statusReference =
    record.statusPath ||
    job.statusPath ||
    (asyncDirReference ? `${normalizePathValue(asyncDirReference)}/status.json` : "");
  const eventsReference =
    record.eventsPath ||
    job.eventsPath ||
    (asyncDirReference ? `${normalizePathValue(asyncDirReference)}/events.jsonl` : "");
  const resultReference = record.resultPath || job.resultPath || job.resultsPath;
  if (!statusReference || !resultReference) {
    return {
      runId,
      record,
      nativeTerminal: false,
      terminalSuccess: false,
      incomplete: true,
    };
  }
  const statusFile = readJsonFile(workspace, statusReference, "async status evidence");
  const status = statusFile.value;
  validateOptionalArtifactCandidate(status, context.manifest, "async status evidence");
  if (status.steps !== undefined && !Array.isArray(status.steps))
    fail("async status steps must be an array");
  if (Array.isArray(status.steps) && status.steps.some((step) => !isObject(step)))
    fail("async status contains a malformed step");
  if (nonEmptyString(status.runId) !== runId) fail("async status belongs to another job");
  if (
    record.parentSessionId &&
    status.sessionId &&
    nonEmptyString(status.sessionId) !== nonEmptyString(record.parentSessionId)
  ) {
    fail("async status belongs to another parent session");
  }
  if (status.state !== undefined && typeof status.state !== "string")
    fail("async status has a malformed state");
  if (!nonEmptyString(status.state) || !terminalStates.has(status.state)) {
    return {
      runId,
      record,
      status,
      nativeTerminal: false,
      terminalSuccess: false,
      incomplete: true,
      statusReference: workspaceRelative(workspace, statusFile.target),
    };
  }
  const resultFile = readJsonFile(workspace, resultReference, "async result evidence");
  const result = resultFile.value;
  validateOptionalArtifactCandidate(result, context.manifest, "async result evidence");
  if (result.results !== undefined && !Array.isArray(result.results))
    fail("async result results must be an array");
  if (Array.isArray(result.results) && result.results.some((step) => !isObject(step)))
    fail("async result contains a malformed step");
  if (result.success !== undefined && typeof result.success !== "boolean")
    fail("async result has a malformed success flag");
  if (
    Array.isArray(result.results) &&
    result.results.some((step) => step.success !== undefined && typeof step.success !== "boolean")
  )
    fail("async result step has a malformed success flag");
  if (nonEmptyString(result.id) !== runId) fail("async result belongs to another job");
  if (result.state !== undefined && typeof result.state !== "string")
    fail("async result has a malformed state");
  const normalizedStatus = resultState(status.state);
  const normalizedResult = resultState(result.state);
  if (normalizedResult && normalizedResult !== normalizedStatus) {
    fail("async status and result terminal states disagree");
  }
  const events = [];
  let eventTypes = [];
  let eventTraceTruncated = false;
  let eventsReferenceRelative = "";
  if (eventsReference) {
    const eventFile = readJsonlFile(workspace, eventsReference, "async event evidence");
    eventsReferenceRelative = workspaceRelative(workspace, eventFile.target);
    for (const entry of eventFile.records) {
      const inspectedEvent = validateNativeEvent(
        entry.value,
        runId,
        "async event evidence",
        context.manifest,
      );
      eventTypes.push(inspectedEvent.type);
      eventTraceTruncated ||= inspectedEvent.traceTruncated;
      events.push(entry.value);
    }
  }
  const started = eventTypes.includes("subagent.run.started");
  const terminalEvent = eventTypes.some((type) =>
    ["subagent.run.completed", "subagent.run.paused", "subagent.run.timed_out"].includes(type),
  );
  const lifecycleVersions = [
    status.lifecycleArtifactVersion,
    result.lifecycleArtifactVersion,
    ...events
      .filter((event) =>
        ["subagent.run.started", "subagent.run.completed"].includes(nativeEventName(event)),
      )
      .map((event) => event.lifecycleArtifactVersion),
  ];
  const lifecycleVersionValid = lifecycleVersions.every(
    (version) => version === NATIVE_LIFECYCLE_ARTIFACT_VERSION,
  );
  const lifecycleVersionComplete = lifecycleVersions.length >= 2;
  const nativeTerminal =
    started &&
    terminalEvent &&
    lifecycleVersionValid &&
    lifecycleVersionComplete &&
    !eventTraceTruncated;
  const resultSuccess = result.success === true && normalizedResult === "complete";
  const childSessions = [];
  const sessionReferences = [];
  const addSessionReference = (value, expected = {}) => {
    if (!value) return;
    const ref = sessionPathFromValue(workspace, value, "child session evidence");
    if (sessionReferences.includes(ref)) return;
    const session = parseSessionFile(workspace, ref, expected);
    childSessions.push(session);
    sessionReferences.push(ref);
  };
  const statusSession = status.sessionFile;
  if (statusSession) addSessionReference(statusSession, { sessionId: record.childSessionId });
  for (const step of status.steps || []) {
    if (step?.sessionFile)
      addSessionReference(step.sessionFile, { sessionId: record.childSessionId });
  }
  if (result.results !== undefined && !Array.isArray(result.results))
    fail("async result results must be an array");
  for (const step of Array.isArray(result.results) ? result.results : []) {
    if (step?.sessionFile)
      addSessionReference(step.sessionFile, { sessionId: record.childSessionId });
  }
  if (record.sessionPath)
    addSessionReference(record.sessionPath, { sessionId: record.childSessionId });
  if (record.childSessionPath)
    addSessionReference(record.childSessionPath, { sessionId: record.childSessionId });
  if (record.childSessionId && childSessions.length === 0) {
    // A bare asserted id is not native identity evidence.
    return {
      runId,
      record,
      status,
      result,
      events,
      eventTypes,
      eventTraceTruncated,
      nativeTerminal,
      terminalSuccess: false,
      incomplete: true,
      statusReference: workspaceRelative(workspace, statusFile.target),
      resultReference: workspaceRelative(workspace, resultFile.target),
    };
  }
  const stepResults = Array.isArray(result.results) ? result.results : [];
  for (const step of status.steps || [])
    validateOptionalArtifactCandidate(step, context.manifest, "async status step evidence");
  for (const step of stepResults)
    validateOptionalArtifactCandidate(step, context.manifest, "async result step evidence");
  const roles = new Set([
    ...(status.steps || []).map((step) => step?.agent).filter((agent) => typeof agent === "string"),
    ...stepResults.map((step) => step?.agent).filter((agent) => typeof agent === "string"),
    ...(record.agent ? [record.agent] : []),
  ]);
  const successfulRoles = new Set(
    stepResults.filter((step) => step?.success === true).map((step) => step.agent),
  );
  const failedRoles = new Set(
    stepResults.filter((step) => step?.success === false).map((step) => step.agent),
  );
  const resumed = eventTypes.includes("subagent.resume.requested");
  const continuation = status.lifecycle?.continuation;
  const finalPidAbsent = status.pid === undefined || status.pid === null;
  if (normalizedStatus === "paused" && status.pid !== undefined && status.pid !== null) {
    fail("paused async status still claims a live child process");
  }
  const inspected = {
    runId,
    record,
    status,
    result,
    events,
    eventTypes,
    eventTraceTruncated,
    roles,
    successfulRoles,
    failedRoles,
    childSessions,
    childSessionIds: new Set(childSessions.map((session) => session.id)),
    nativeTerminal,
    terminalSuccess: nativeTerminal && resultSuccess,
    resultSuccess,
    incomplete: !nativeTerminal,
    resumed,
    continuation,
    finalPidAbsent,
    statusReference: workspaceRelative(workspace, statusFile.target),
    resultReference: workspaceRelative(workspace, resultFile.target),
    eventsReference: eventsReferenceRelative,
    references: [
      workspaceRelative(workspace, statusFile.target),
      workspaceRelative(workspace, resultFile.target),
      ...(eventsReferenceRelative ? [eventsReferenceRelative] : []),
      ...sessionReferences,
    ],
  };
  const previous = context.jobs.get(runId);
  if (previous && JSON.stringify(previous.references) !== JSON.stringify(inspected.references)) {
    fail(`job ${runId} was associated with multiple artifact identities`);
  }
  context.jobs.set(runId, inspected);
  return inspected;
}

function inspectFixtureTest(workspace, record, manifest) {
  for (const field of ["independent", "expectedBehaviorChecked", "modelClaim"]) {
    if (record[field] !== undefined && typeof record[field] !== "boolean") {
      fail(`fixture test evidence has malformed ${field}`);
    }
  }
  if (record.exitCode !== undefined && !Number.isInteger(record.exitCode)) {
    fail("fixture test evidence has malformed exit code");
  }
  const fixturePath = normalizeOwnedWorkspacePath(
    workspace,
    record.fixturePath || record.cwd,
    "fixture test workspace",
  );
  const expectedFixture = normalizePathValue(manifest.fixture?.workspacePath);
  if (!fixturePath) return { record, passed: false, reference: record.sourceReference };
  if (expectedFixture && fixturePath !== expectedFixture) {
    fail("fixture test belongs to another fixture");
  }
  const resultReference = record.resultPath || record.outputPath;
  if (!resultReference) {
    return {
      record,
      passed: false,
      reference: record.sourceReference,
      detail: "fixture test has no referenced command/output capture",
    };
  }
  const parsed = readJsonFile(workspace, resultReference, "fixture test result evidence");
  record = {
    ...record,
    result: parsed.value,
    resultReference: workspaceRelative(workspace, parsed.target),
  };
  const result = record.result;
  validateOptionalArtifactCandidate(result, manifest, "fixture test result evidence");
  for (const field of ["independent", "expectedBehaviorChecked", "modelClaim"]) {
    if (result[field] !== undefined && typeof result[field] !== "boolean") {
      fail(`fixture test result evidence has malformed ${field}`);
    }
  }
  if (result.exitCode !== undefined && !Number.isInteger(result.exitCode)) {
    fail("fixture test result evidence has malformed exit code");
  }
  if (!nonEmptyString(result.command)) {
    return {
      record,
      passed: false,
      reference: record.resultReference,
      detail: "fixture test capture has no executed command",
    };
  }
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    return {
      record,
      passed: false,
      reference: record.resultReference,
      detail: "fixture test capture has no complete stdout/stderr result",
    };
  }
  const passed =
    candidateIdentityMatches(record, manifest) &&
    candidateIdentityMatches(result, manifest) &&
    result.independent === true &&
    !isAssistantClaim(record) &&
    !isAssistantClaim(result) &&
    result.exitCode === 0 &&
    result.expectedBehaviorChecked === true &&
    record.modelClaim !== true &&
    result.modelClaim !== true;
  return { record, passed, reference: record.resultReference };
}

function inspectFixtureChange(workspace, record, manifest) {
  for (const field of ["observed", "staged", "outsideFixture"]) {
    if (record[field] !== undefined && typeof record[field] !== "boolean") {
      fail(`fixture change evidence has malformed ${field}`);
    }
  }
  const expectedFixture = normalizePathValue(manifest.fixture?.workspacePath);
  const fixturePath = normalizeOwnedWorkspacePath(
    workspace,
    record.fixturePath || record.workspacePath,
    "fixture change workspace",
  );
  if (!fixturePath)
    return { record, passed: false, violated: false, reference: record.sourceReference };
  if (expectedFixture && fixturePath !== expectedFixture)
    fail("fixture change belongs to another fixture");
  if (
    !Array.isArray(record.changedFiles) ||
    record.changedFiles.length === 0 ||
    record.changedFiles.some((file) => typeof file !== "string" || !file.trim())
  ) {
    fail("fixture change evidence has malformed changed files");
  }
  if (
    record.outsidePaths !== undefined &&
    (!Array.isArray(record.outsidePaths) ||
      record.outsidePaths.some((file) => typeof file !== "string" || !file.trim()))
  ) {
    fail("fixture change evidence has malformed outside paths");
  }
  const changedFiles = record.changedFiles;
  const outside =
    record.outsideFixture === true ||
    (Array.isArray(record.outsidePaths) && record.outsidePaths.length > 0) ||
    changedFiles.some((file) => {
      if (typeof file !== "string") return false;
      const normalized = normalizePathValue(file);
      if (normalized.includes("\0")) fail("fixture change evidence contains a NUL path");
      return (
        normalized.startsWith("/") ||
        /^[A-Za-z]:\//.test(normalized) ||
        normalized.split("/").includes("..")
      );
    });
  if (!outside) {
    const fixtureTarget = resolve(workspace, expectedFixture);
    for (const file of changedFiles) {
      const target = resolve(fixtureTarget, normalizePathValue(file));
      assertNoSymlinkComponents(target, fixtureTarget, "fixture changed file", true);
    }
  }
  return {
    record,
    passed:
      candidateIdentityMatches(record, manifest) &&
      !isAssistantClaim(record) &&
      record.observed === true &&
      changedFiles.length > 0 &&
      record.staged === false &&
      record.outsideFixture === false &&
      !outside,
    violated: outside || record.staged === true,
    reference: record.sourceReference,
  };
}

function recordsForCheck(context, check) {
  return context.records.filter((record) => {
    if (record.explicitCheckIds?.length > 0) return record.explicitCheckIds.includes(check.id);
    if (record.checkIds.includes(check.id)) return true;
    const captureIds = context.captureCheckIds.get(record.sourceReference) || new Set();
    return captureIds.has(check.id);
  });
}

function knownRunId(context, runId) {
  return Boolean(runId && context.jobs.has(runId));
}

function recordRunId(record) {
  const result = isObject(record.toolResult)
    ? record.toolResult
    : isObject(record.result)
      ? record.result
      : {};
  const details = isObject(result.details) ? result.details : {};
  return nonEmptyString(
    record.runId ||
      record.jobId ||
      record.asyncId ||
      result.runId ||
      result.asyncId ||
      result.id ||
      details.runId ||
      details.asyncId ||
      details.id,
  );
}

function recordRole(record) {
  const input = isObject(record.input) ? record.input : {};
  const call = isObject(record.toolCall)
    ? record.toolCall
    : isObject(record.call)
      ? record.call
      : {};
  return nonEmptyString(record.agent || input.agent || call.agent || call.input?.agent);
}

function dispatchCall(record) {
  const input = isObject(record.input) ? record.input : {};
  const toolCall = isObject(record.toolCall)
    ? record.toolCall
    : isObject(record.call)
      ? record.call
      : {
          name: record.toolName || record.name,
          input,
        };
  const toolName = nonEmptyString(toolCall.name || toolCall.tool || record.tool);
  const callInput = isObject(toolCall.input)
    ? toolCall.input
    : isObject(toolCall.arguments)
      ? toolCall.arguments
      : input;
  const toolResult = isObject(record.toolResult)
    ? record.toolResult
    : isObject(record.receipt)
      ? record.receipt
      : null;
  return { toolCall, toolName, callInput, toolResult };
}

function nativeToolResultDetails(toolResult, label) {
  if (!isObject(toolResult)) return null;
  if (toolResult.isError !== undefined && typeof toolResult.isError !== "boolean") {
    fail(`${label} has a malformed native error flag`);
  }
  const details = isObject(toolResult.details) ? toolResult.details : null;
  if (!details || typeof details.mode !== "string" || !Array.isArray(details.results)) return null;
  if (details.results.some((result) => !isObject(result)))
    fail(`${label} has malformed native results`);
  return details;
}

function modelReference(value) {
  if (!isObject(value)) return "";
  const identity = isObject(value.modelIdentity) ? value.modelIdentity : {};
  const provider = nonEmptyString(identity.provider);
  const identityModel = nonEmptyString(identity.model);
  const model =
    provider && identityModel ? `${provider}/${identityModel}` : nonEmptyString(value.model);
  if (!model) return "";
  const thinking = nonEmptyString(value.thinking) || nonEmptyString(identity.thinking);
  return thinking && !model.endsWith(`:${thinking}`) ? `${model}:${thinking}` : model;
}

function modelEvidenceState(value) {
  if (!isObject(value)) return { status: "pending", detail: "model execution evidence is absent" };
  if (value.attemptedModels !== undefined) {
    if (
      !Array.isArray(value.attemptedModels) ||
      value.attemptedModels.some((model) => typeof model !== "string" || !model.trim())
    ) {
      return { status: "failed", detail: "runtime model-attempt evidence is malformed" };
    }
    if (value.attemptedModels.length > 1) {
      return { status: "failed", detail: "runtime used a fallback model for the dispatched role" };
    }
  }
  if (value.modelAttempts !== undefined) {
    if (!Array.isArray(value.modelAttempts)) {
      return { status: "failed", detail: "runtime model-attempt evidence is malformed" };
    }
    if (value.modelAttempts.length > 1) {
      return { status: "failed", detail: "runtime used a fallback model for the dispatched role" };
    }
  }
  if (isObject(value.modelResolution) && value.modelResolution.kind === "fallback") {
    return { status: "failed", detail: "runtime used a fallback model for the dispatched role" };
  }
  if (nonEmptyString(value.modelFallbackNotice)) {
    return {
      status: "failed",
      detail: "runtime reported a model fallback for the dispatched role",
    };
  }
  return null;
}

function modelDispatchState(modelEvidence, expectedModel) {
  if (!expectedModel) {
    return { status: "pending", detail: "manifest has no exact requested model identity" };
  }
  const observedValues = modelEvidence.filter(isObject);
  if (observedValues.length === 0) {
    return { status: "pending", detail: "dispatch has no observed execution identity" };
  }
  for (const value of observedValues) {
    const state = modelEvidenceState(value);
    if (state) return state;
  }
  const observedModels = observedValues.map(modelReference).filter(Boolean);
  if (observedModels.length === 0) {
    return { status: "pending", detail: "dispatch has no observed execution identity" };
  }
  if (new Set(observedModels).size > 1) {
    return { status: "failed", detail: "result and status model identities disagree" };
  }
  return observedModels[0] === expectedModel
    ? null
    : { status: "failed", detail: "dispatch used a different observed provider/model/thinking" };
}

function parentDispatchEvidence(record, context, toolCall, callInput) {
  if (!record.parentSessionPath || !record.parentEntryId || !record.parentSessionId) {
    return { status: "pending", detail: "dispatch has no active parent-session correlation" };
  }
  const parent = parseSessionFile(context.workspace, record.parentSessionPath, {
    sessionId: record.parentSessionId,
    entryId: record.parentEntryId,
  });
  if (record.parentEntryId && !parent.expectedEntryActive) {
    return { status: "pending", detail: "dispatch is only present on an abandoned parent branch" };
  }
  const parentEntry = parent.activeEntries.find((entry) => entry.id === record.parentEntryId);
  const parentMessage =
    parentEntry?.type === "message" ? classifySessionMessage(parentEntry.message) : null;
  const callId = nonEmptyString(record.toolCallId || toolCall.id);
  if (!callId) return { status: "pending", detail: "dispatch has no native tool-call identity" };
  if (!parentMessage?.toolCalls.some((call) => call.id === callId && call.name === "subagent")) {
    return {
      status: "pending",
      detail: "parent entry does not contain the observed subagent call",
    };
  }
  const observed = parent.completedToolCalls.find(
    ({ call, result }) => call.id === callId && call.name === "subagent" && result.isError !== true,
  );
  if (!observed)
    return { status: "pending", detail: "active parent session has no completed dispatch" };
  const nativeDetails = nativeToolResultDetails(observed.result, "parent native dispatch result");
  if (!nativeDetails) {
    return { status: "pending", detail: "active parent result has no native subagent details" };
  }
  if (nativeDetails.results.length === 0) {
    return { status: "pending", detail: "active parent result has no child result" };
  }
  const nativeInput = isObject(observed.call.arguments) ? observed.call.arguments : {};
  for (const field of ["agent", "cwd", "model", "agentScope", "context"]) {
    if (
      nativeInput[field] !== undefined &&
      callInput[field] !== undefined &&
      nativeInput[field] !== callInput[field]
    ) {
      return { status: "failed", detail: "dispatch record disagrees with the native parent call" };
    }
  }
  return { nativeInput, nativeDetails, nativeResult: observed.result };
}

function dispatchState(record, context, manifest, role = "") {
  if (isAssistantClaim(record)) {
    return { status: "pending", detail: "assistant/model claims are not runtime evidence" };
  }
  const { toolCall, toolName, callInput, toolResult } = dispatchCall(record);
  if (record.status === "failed" || record.failed === true || record.providerFailure === true) {
    return { status: "failed", detail: "dispatch evidence records a role/provider failure" };
  }
  if (record.status === "blocked" || record.blocked === true) {
    return { status: "blocked", detail: "native dispatch was blocked before child launch" };
  }
  validateOptionalArtifactCandidate(toolResult, manifest, "dispatch result evidence");
  if (toolName !== "subagent")
    return { status: "pending", detail: "no native subagent tool call observed" };
  if (!toolResult) return { status: "pending", detail: "tool call has no returned tool result" };
  const details = nativeToolResultDetails(toolResult, "dispatch result evidence");
  if (!details) {
    return { status: "pending", detail: "returned tool result is not a native subagent result" };
  }
  if (toolResult.isError === true) {
    return { status: "failed", detail: "native dispatch returned a role/provider failure" };
  }
  if (details.results.length === 0) {
    return { status: "pending", detail: "native dispatch result has no child result" };
  }
  const parentEvidence = parentDispatchEvidence(record, context, toolCall, callInput);
  if (parentEvidence.status) return parentEvidence;
  const nativeInput = parentEvidence.nativeInput;
  const resultRunId = nonEmptyString(details.runId || details.asyncId);
  const parentRunId = nonEmptyString(
    parentEvidence.nativeDetails?.runId || parentEvidence.nativeDetails?.asyncId,
  );
  if (parentRunId && resultRunId && parentRunId !== resultRunId) {
    fail("parent and captured native results disagree on run identity");
  }
  if (!resultRunId) {
    return { status: "pending", detail: "native dispatch result has no run identity" };
  }
  const claimedRunId = nonEmptyString(record.runId || record.jobId || record.asyncId);
  if (claimedRunId && claimedRunId !== resultRunId) {
    fail("dispatch receipt and native result disagree on run identity");
  }
  const runId = resultRunId;
  const job = context.jobs.get(runId);
  if (!job) {
    return { status: "pending", detail: "dispatch result is not correlated to a native child job" };
  }
  if (!job.childSessionIds?.size) {
    return { status: "pending", detail: "native child job has no captured child session" };
  }
  const childSessionId = nonEmptyString(record.childSessionId);
  if (childSessionId && !job.childSessionIds.has(childSessionId)) {
    return { status: "failed", detail: "dispatch result points to a different child session" };
  }
  const expectedCwd = nonEmptyString(manifest.fixture?.workspacePath);
  const observedCwd = nativeInput.cwd || job.status?.cwd || job.result?.cwd;
  if (expectedCwd && !observedCwd) {
    return { status: "pending", detail: "dispatch has no independently captured fixture cwd" };
  }
  if (expectedCwd && observedCwd) {
    const normalizedCwd = normalizeOwnedWorkspacePath(
      context.workspace,
      observedCwd,
      "dispatch cwd",
    );
    if (normalizedCwd !== normalizePathValue(expectedCwd)) {
      return { status: "failed", detail: "dispatch cwd is outside the prepared fixture" };
    }
  }
  const nativeRoleResults = details.results.filter((result) => nonEmptyString(result.agent));
  const parentRoleResults = parentEvidence.nativeDetails.results.filter((result) =>
    nonEmptyString(result.agent),
  );
  const nativeObservedRoles = new Set(
    [...nativeRoleResults, ...parentRoleResults].map((result) => nonEmptyString(result.agent)),
  );
  if (role && nativeObservedRoles.size > 0 && !nativeObservedRoles.has(role)) {
    fail(
      `native dispatch result targets ${[...nativeObservedRoles].join(", ")} instead of ${role}`,
    );
  }
  if (
    nativeInput.agent &&
    nativeObservedRoles.size > 0 &&
    !nativeObservedRoles.has(nonEmptyString(nativeInput.agent))
  ) {
    fail("native dispatch input and result disagree on role identity");
  }
  const observedRole = nonEmptyString(
    nativeInput.agent || details.results[0]?.agent || job.result?.agent || job.status?.agent,
  );
  if (role && observedRole && observedRole !== role) {
    fail(`dispatch evidence targets ${observedRole} instead of ${role}`);
  }
  if (role && !observedRole)
    return { status: "pending", detail: "dispatch has no observed role identity" };
  const nativeSessionFiles = [...nativeRoleResults, ...parentRoleResults]
    .map((result) => nonEmptyString(result.sessionFile))
    .filter(Boolean);
  if (nativeSessionFiles.length > 0) {
    for (const sessionFile of nativeSessionFiles) {
      const nativeSession = parseSessionFile(context.workspace, sessionFile, {});
      if (!job.childSessionIds.has(nativeSession.id)) {
        fail("native dispatch result points to a different child session");
      }
    }
  }
  if (job?.failedRoles?.has(role || observedRole)) {
    return { status: "failed", detail: "child/provider execution failed for the dispatched role" };
  }
  if (job && !job.terminalSuccess) {
    return {
      status: job.nativeTerminal ? "failed" : "pending",
      detail: job.nativeTerminal
        ? "native child job ended unsuccessfully"
        : "native child job has no complete terminal lifecycle",
    };
  }
  const expectedModel = nonEmptyString(manifest.acceptanceModel?.requested);
  const requestedModel = modelReference(nativeInput) || nonEmptyString(nativeInput.model);
  if (requestedModel && requestedModel !== expectedModel) {
    return { status: "failed", detail: "dispatch requested a different provider/model/thinking" };
  }
  const resultSteps = Array.isArray(job.result?.results) ? job.result.results : [];
  const statusSteps = Array.isArray(job.status?.steps) ? job.status.steps : [];
  const resultIndex = resultSteps.findIndex((step) => !role || step?.agent === role);
  const statusIndex = statusSteps.findIndex((step) => !role || step?.agent === role);
  if (resultIndex < 0 || statusIndex < 0) {
    return { status: "pending", detail: "native result/status lacks a correlated role step" };
  }
  if (resultIndex !== statusIndex) {
    return { status: "failed", detail: "native result/status role steps are not correlated" };
  }
  const resultStep = resultSteps[resultIndex];
  const statusStep = statusSteps[statusIndex];
  const modelState = modelDispatchState(
    [...parentRoleResults, resultStep, statusStep],
    expectedModel,
  );
  if (modelState) return modelState;
  if (!candidateIdentityMatches(record, manifest)) {
    return { status: "pending", detail: "dispatch has no matching candidate identity" };
  }
  if (!candidateIdentityMatches(job.record, manifest)) {
    return { status: "pending", detail: "child job has no matching candidate identity" };
  }
  return {
    status: "passed",
    detail: "parent-native call/result, child session, job, and observed model are correlated",
    nativeInput,
    job,
    runId,
  };
}

function sessionEntryPosition(context, record) {
  if (!record.sessionPath || !record.entryId) return null;
  const session = parseSessionFile(context.workspace, record.sessionPath, {
    sessionId: record.parentSessionId,
    entryId: record.entryId,
  });
  if (!session.expectedEntryActive && record.entryId) return null;
  const index = session.activeEntries.findIndex((entry) => entry.id === record.entryId);
  return index < 0 ? null : index;
}

function activeApprovalRecord(context, record) {
  if (!candidateIdentityMatches(record, context.manifest)) return false;
  if (
    record.kind !== "approval" ||
    record.actor !== "user" ||
    !["approve", "approved", "yes"].includes(record.decision) ||
    !record.sessionPath ||
    !record.entryId
  )
    return false;
  const session = parseSessionFile(context.workspace, record.sessionPath, {
    sessionId: record.parentSessionId,
    entryId: record.entryId,
  });
  return (
    session.expectedEntryActive === true &&
    session.userMessages.some((entry) => entry.id === record.entryId)
  );
}

function evidenceBefore(context, earlier, later) {
  if (finiteNumber(earlier.sequence) && finiteNumber(later.sequence)) {
    return earlier.sequence < later.sequence;
  }
  if (
    earlier.sessionPath &&
    later.parentSessionPath &&
    normalizePathValue(earlier.sessionPath) === normalizePathValue(later.parentSessionPath)
  ) {
    const earlierPosition = sessionEntryPosition(context, earlier);
    const laterPosition = sessionEntryPosition(context, {
      sessionPath: later.parentSessionPath,
      entryId: later.parentEntryId,
      parentSessionId: later.parentSessionId,
    });
    return earlierPosition !== null && laterPosition !== null && earlierPosition < laterPosition;
  }
  return null;
}

function architectWorkflowOrder(records, context) {
  const order = ["developer", "test-runner", "code-reviewer"];
  const dispatches = records.filter(
    (record) =>
      record.kind === "dispatch" &&
      !isAssistantClaim(record) &&
      order.includes(recordRole(record)) &&
      candidateIdentityMatches(record, context.manifest),
  );
  if (dispatches.length < order.length)
    return { status: "pending", detail: "workflow order evidence is incomplete" };
  const dispatchByRole = new Map(
    order.map((role) => [role, dispatches.find((record) => recordRole(record) === role)]),
  );
  for (const role of order) {
    const dispatch = dispatchByRole.get(role);
    if (!dispatch) return { status: "pending", detail: "workflow order evidence is incomplete" };
    const outcome = dispatchState(dispatch, context, context.manifest, role);
    if (outcome.status !== "passed") return outcome;
  }
  const positions = order.map((role) => {
    const record = dispatchByRole.get(role);
    return {
      record,
      sequence: finiteNumber(record.sequence) ? record.sequence : null,
      sessionPosition: sessionEntryPosition(context, {
        sessionPath: record.parentSessionPath,
        entryId: record.parentEntryId,
        parentSessionId: record.parentSessionId,
      }),
      sessionPath: normalizePathValue(record.parentSessionPath || ""),
    };
  });
  const useSequences = positions.every((position) => position.sequence !== null);
  const useSessionPositions = positions.every(
    (position) => position.sessionPosition !== null && position.sessionPath,
  );
  if (!useSequences && !useSessionPositions) {
    return { status: "pending", detail: "workflow order evidence is incomplete" };
  }
  if (useSessionPositions && !useSequences) {
    const sessions = new Set(positions.map((position) => position.sessionPath));
    if (sessions.size !== 1) {
      return { status: "pending", detail: "workflow order spans unrelated parent sessions" };
    }
  }
  const sorted = [...positions]
    .sort((left, right) =>
      useSequences ? left.sequence - right.sequence : left.sessionPosition - right.sessionPosition,
    )
    .map((position) => position.record);
  const adjacentPositions = positions
    .map((position) => (useSequences ? position.sequence : position.sessionPosition))
    .sort((left, right) => left - right);
  if (
    adjacentPositions.some((value, index) => index > 0 && value === adjacentPositions[index - 1])
  ) {
    return {
      status: "pending",
      detail: "workflow order evidence has ambiguous dispatch positions",
    };
  }
  const observedRoles = sorted.map(recordRole);
  if (order.some((role) => !observedRoles.includes(role))) {
    return { status: "pending", detail: "workflow order evidence is incomplete" };
  }
  const observed = order.map((role) => observedRoles.indexOf(role));
  if (!observed.every((value, index) => index === 0 || value > observed[index - 1])) {
    return {
      status: "failed",
      detail: "parent-native dispatches violate the required delegation order",
    };
  }
  const planApproval = records.find(
    (record) =>
      record.checkIds.includes("architect-plan-approval-gate") &&
      activeApprovalRecord(context, record),
  );
  const ticketApproval = records.find(
    (record) =>
      record.checkIds.includes("architect-ticket-approval-gate") &&
      activeApprovalRecord(context, record),
  );
  const developerDispatch = sorted.find((record) => recordRole(record) === "developer");
  if (!planApproval || !ticketApproval || !developerDispatch) {
    return { status: "pending", detail: "approval evidence is incomplete for workflow ordering" };
  }
  const planBefore = evidenceBefore(context, planApproval, developerDispatch);
  const ticketBefore = evidenceBefore(context, ticketApproval, developerDispatch);
  if (planBefore === false || ticketBefore === false) {
    return { status: "failed", detail: "human approval occurred after implementation dispatch" };
  }
  if (planBefore !== true || ticketBefore !== true) {
    return {
      status: "pending",
      detail: "approval and dispatch order is not independently observable",
    };
  }
  return {
    status: "passed",
    detail: "parent-native dispatches preserve the required delegation and approval order",
  };
}

function roleExecutionState(records, context, role, manifest) {
  const relevant = records.filter(
    (record) => !isAssistantClaim(record) && (recordRole(record) === role || record.agent === role),
  );
  const blocked = relevant.find((record) => record.status === "blocked" || record.blocked === true);
  if (blocked)
    return {
      status: "blocked",
      detail: "role execution was explicitly blocked by a missing capability",
    };
  const failures = relevant.find(
    (record) =>
      candidateIdentityMatches(record, manifest) &&
      (record.status === "failed" || record.failed === true || record.providerFailure === true),
  );
  if (failures) return { status: "failed", detail: "role/provider execution failure was observed" };
  const jobs = [...context.jobs.values()].filter(
    (job) =>
      job.roles?.has(role) &&
      !isAssistantClaim(job.record) &&
      candidateIdentityMatches(job.record, manifest),
  );
  const completed = jobs.find((job) => job.terminalSuccess && job.successfulRoles.has(role));
  if (!completed) {
    const failedJob = jobs.find(
      (job) => job.failedRoles?.has(role) || job.status?.state === "failed",
    );
    if (failedJob) return { status: "failed", detail: "native child job ended unsuccessfully" };
    return { status: "pending", detail: "no successful terminal native role result is available" };
  }
  const hasBoundary = completed.childSessions?.some(
    (session) => session.completedToolCalls.length > 0 && session.unresolvedToolCalls.length === 0,
  );
  if (!hasBoundary)
    return { status: "pending", detail: "child session has no complete visible tool boundary" };
  return {
    status: "passed",
    detail: "native job/result and active child-session tool boundaries are correlated",
  };
}

function humanReviewState(records, context, check) {
  const reviews = records.filter(
    (record) =>
      ["human-review", "manual-review"].includes(record.kind) && !isAssistantClaim(record),
  );
  const matching = reviews.filter((record) => record.checkIds.includes(check.id));
  if (matching.length === 0)
    return { status: "pending", detail: "explicit human TUI attestation is missing" };
  const blocked = matching.find(
    (record) =>
      record.status === "blocked" || record.blocked === true || record.supported === false,
  );
  if (blocked)
    return { status: "blocked", detail: "manual prerequisite or capability is unavailable" };
  const review = matching.find(
    (record) =>
      record.reviewerType === "human" &&
      ["pass", "passed", "approve", "approved"].includes(record.decision),
  );
  if (!review)
    return { status: "pending", detail: "AI/model review cannot award a subjective pass" };
  const reviewCandidate = recordCandidateCommit(review);
  if (!reviewCandidate)
    return { status: "pending", detail: "human review has no candidate identity" };
  if (reviewCandidate !== context.manifest.candidate?.commit) {
    fail("human review belongs to another candidate");
  }
  const runId = nonEmptyString(review.runId || review.identity?.runId);
  if (!runId || !knownRunId(context, runId)) {
    return { status: "pending", detail: "human review has no observed run identity" };
  }
  const captureReference = nonEmptyString(review.captureReference || review.captureRef);
  if (!captureReference)
    return { status: "pending", detail: "human review has no capture reference" };
  const captureTarget = resolveOwnedReference(
    context.workspace,
    captureReferenceForManifest(context.manifest, captureReference),
    "human capture reference",
    {
      allowMissing: false,
    },
  );
  if (!lstatSync(captureTarget).isFile()) fail("human capture reference must be a regular file");
  if (check.id.endsWith("max-thinking-badge") && review.maxSupported !== true) {
    return { status: "blocked", detail: "requested max-thinking capability was not supported" };
  }
  return {
    status: "passed",
    detail: "explicit human review is tied to the observed candidate, run, and capture",
  };
}

function approvalState(records, context) {
  const matching = records.filter(
    (record) => record.kind === "approval" && !isAssistantClaim(record),
  );
  if (matching.length === 0) return { status: "pending", detail: "human approval turn is missing" };
  for (const record of matching) {
    if (!candidateIdentityMatches(record, context.manifest)) continue;
    if (record.actor !== "user" || !["approve", "approved", "yes"].includes(record.decision))
      continue;
    if (!record.sessionPath || !record.entryId) continue;
    const session = parseSessionFile(context.workspace, record.sessionPath, {
      sessionId: record.parentSessionId,
      entryId: record.entryId,
    });
    if (
      session.expectedEntryActive &&
      session.userMessages.some((entry) => entry.id === record.entryId)
    ) {
      return {
        status: "passed",
        detail: "active native parent session contains the human approval turn",
      };
    }
  }
  return {
    status: "pending",
    detail: "approval evidence is absent from the active native session branch",
  };
}

function ticketApprovalState(records, context) {
  const approvals = records.filter(
    (record) =>
      record.kind === "approval" &&
      !isAssistantClaim(record) &&
      record.actor === "user" &&
      record.decision === "approved" &&
      candidateIdentityMatches(record, context.manifest),
  );
  const fixtureRoot = nonEmptyString(context.manifest.fixture?.workspacePath);
  const ticketIds = context.manifest.fixture?.ticketIds || [];
  if (
    !fixtureRoot ||
    !Array.isArray(ticketIds) ||
    ticketIds.length === 0 ||
    ticketIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    return { status: "pending", detail: "fixture ticket identity is missing" };
  }
  const approvalTicketIds = approvals.map((record) => {
    if (record.ticketIds !== undefined && !Array.isArray(record.ticketIds))
      fail("ticket approval has malformed ticket ids");
    const ids = record.ticketIds || (record.ticketId ? [record.ticketId] : []);
    if (ids.some((id) => typeof id !== "string" || !id.trim() || !ticketIds.includes(id.trim()))) {
      fail("ticket approval references an unknown ticket");
    }
    return { record, ids: ids.map((id) => id.trim()) };
  });
  const activeApprovedIds = new Set();
  for (const { record, ids } of approvalTicketIds) {
    if (!record.sessionPath || !record.entryId) continue;
    const session = parseSessionFile(context.workspace, record.sessionPath, {
      sessionId: record.parentSessionId,
      entryId: record.entryId,
    });
    if (
      session.expectedEntryActive &&
      session.userMessages.some((entry) => entry.id === record.entryId)
    ) {
      for (const id of ids) activeApprovedIds.add(id);
    }
  }
  const missing = ticketIds.filter((id) => !activeApprovedIds.has(id));
  for (const id of ticketIds) {
    const path = join(fixtureRoot, ".tickets", `${id}.md`);
    const target = resolveOwnedReference(context.workspace, path, "fixture ticket", {
      allowMissing: false,
    });
    const stats = lstatSync(target);
    if (!stats.isFile()) fail("fixture ticket is not a regular file");
  }
  if (missing.length > 0)
    return { status: "pending", detail: "not every fixture ticket has a human approval turn" };
  return {
    status: "passed",
    detail: "fixture tickets and active human approval evidence are correlated",
  };
}

function noLaunchState(records, context, manifest) {
  const record = records.find(
    (candidate) =>
      !isAssistantClaim(candidate) &&
      (candidate.kind === "no-launch" || candidate.kind === "blocked-dispatch"),
  );
  if (!record) return { status: "pending", detail: "blocked-before-launch evidence is missing" };
  if (!candidateIdentityMatches(record, manifest)) {
    return { status: "pending", detail: "blocked evidence has no matching candidate identity" };
  }
  const target = nonEmptyString(record.target || record.agent);
  const allowed = manifest.dispatchPolicy?.allowedRoles || [];
  if (!target || allowed.includes(target))
    return { status: "failed", detail: "negative evidence does not target a denied role" };
  if (record.launchObserved === true || record.childLaunched === true || record.runId) {
    return { status: "failed", detail: "denied target launched a child despite the block" };
  }
  if (!record.parentSessionPath || !record.parentSessionId || !record.parentEntryId) {
    return {
      status: "pending",
      detail: "blocked evidence has no active parent-session correlation",
    };
  }
  const parent = parseSessionFile(context.workspace, record.parentSessionPath, {
    sessionId: record.parentSessionId,
    entryId: record.parentEntryId,
  });
  if (!parent.expectedEntryActive) {
    return {
      status: "pending",
      detail: "blocked evidence is only present on an abandoned parent branch",
    };
  }
  const parentEntry = parent.activeEntries.find((entry) => entry.id === record.parentEntryId);
  const parentMessage =
    parentEntry?.type === "message" ? classifySessionMessage(parentEntry.message) : null;
  const callId = nonEmptyString(record.toolCallId);
  const parentCall = parentMessage?.toolCalls.find(
    (call) => call.id === callId && call.name === "subagent",
  );
  if (!parentCall) {
    return { status: "pending", detail: "parent entry does not contain the denied subagent call" };
  }
  const nativeTarget = nonEmptyString(parentCall.arguments?.agent);
  if (nativeTarget !== target) {
    return { status: "failed", detail: "blocked evidence targets a different native agent" };
  }
  const completed = parent.completedToolCalls.find(
    ({ call }) => call.id === callId && call.name === "subagent",
  );
  if (!completed) {
    return { status: "pending", detail: "active parent session has no completed denied dispatch" };
  }
  if (completed.result.isError !== true) {
    return { status: "failed", detail: "denied target returned a non-error native result" };
  }
  const parentDetails = nativeToolResultDetails(completed.result, "parent blocked dispatch result");
  if (!parentDetails) {
    return { status: "pending", detail: "active parent result has no native blocked details" };
  }
  const toolResult = isObject(record.toolResult) ? record.toolResult : null;
  const details = nativeToolResultDetails(toolResult, "blocked dispatch result evidence");
  if (!details) {
    return { status: "pending", detail: "blocked evidence has no native tool-result details" };
  }
  if (toolResult.isError !== true || details.results.length !== 0) {
    return {
      status: "failed",
      detail: "denied target did not return the native empty error result",
    };
  }
  if (
    nonEmptyString(parentDetails.runId || parentDetails.asyncId || parentDetails.id) ||
    nonEmptyString(details.runId || details.asyncId || details.id)
  ) {
    return { status: "failed", detail: "denied result contains a child run identity" };
  }
  if (parentDetails.mode !== details.mode) {
    return { status: "failed", detail: "blocked result mode disagrees with the parent result" };
  }
  if (parentDetails.results.length !== details.results.length) {
    return { status: "failed", detail: "blocked result children disagree with the parent result" };
  }
  const targetJobs = [...context.jobs.values()].filter(
    (job) =>
      job.roles?.has(target) ||
      nonEmptyString(job.record?.agent) === target ||
      job.result?.agent === target,
  );
  if (targetJobs.length > 0) {
    return { status: "failed", detail: "denied target has a correlated child job" };
  }
  return {
    status: "passed",
    detail: "active native denied call returned an empty error result with no child job",
  };
}

function scopeState(records, context, manifest) {
  const roles = manifest.dispatchPolicy?.allowedRoles || [];
  if (roles.length === 0)
    return { status: "pending", detail: "dispatch policy has no canonical roles" };
  const dispatches = records.filter(
    (record) =>
      record.kind === "dispatch" && !isAssistantClaim(record) && roles.includes(recordRole(record)),
  );
  const observedRoles = new Set(dispatches.map(recordRole));
  if (roles.some((role) => !observedRoles.has(role)))
    return { status: "pending", detail: "canonical role dispatch evidence is incomplete" };
  for (const record of dispatches) {
    if (!candidateIdentityMatches(record, manifest))
      return { status: "pending", detail: "scope evidence has no matching candidate identity" };
    const role = recordRole(record);
    const outcome = dispatchState(record, context, manifest, role);
    if (outcome.status !== "passed") return outcome;
    if (outcome.nativeInput?.agentScope !== "user") {
      return {
        status: "pending",
        detail: "native parent dispatch scope is not independently observed",
      };
    }
    if (record.resolvedScope && record.resolvedScope !== "user") {
      return { status: "failed", detail: "parent runtime resolved a non-user scope" };
    }
    if (record.childScope && record.childScope !== "user") {
      return { status: "failed", detail: "child runtime resolved a non-user scope" };
    }
    if (record.resolvedScope !== "user" || record.childScope !== "user") {
      return {
        status: "pending",
        detail: "correlated dispatch lacks complete parent/child scope observations",
      };
    }
  }
  return { status: "passed", detail: "correlated parent calls and child jobs are user-scoped" };
}

function freshContextState(records, context, manifest) {
  const roles = manifest.dispatchPolicy?.allowedRoles || [];
  const dispatches = records.filter(
    (record) =>
      record.kind === "dispatch" && !isAssistantClaim(record) && roles.includes(recordRole(record)),
  );
  const observedRoles = new Set(dispatches.map(recordRole));
  if (roles.some((role) => !observedRoles.has(role)))
    return { status: "pending", detail: "canonical dispatch evidence is incomplete" };
  for (const record of dispatches) {
    if (!candidateIdentityMatches(record, manifest))
      return {
        status: "pending",
        detail: "fresh-context evidence has no matching candidate identity",
      };
    const outcome = dispatchState(record, context, manifest, recordRole(record));
    if (outcome.status !== "passed") return outcome;
    const { callInput } = dispatchCall(record);
    if (callInput.context !== undefined && callInput.context !== "fresh") {
      return { status: "failed", detail: "dispatch explicitly inherited a context" };
    }
    if (outcome.nativeInput?.context !== "fresh") {
      return {
        status: "pending",
        detail: "native parent context input is not independently observed",
      };
    }
    const parentId = nonEmptyString(record.parentSessionId);
    const childId = nonEmptyString(record.childSessionId);
    if (!parentId || !childId) {
      return { status: "pending", detail: "parent/child session identities are incomplete" };
    }
    if (parentId === childId) {
      return { status: "failed", detail: "parent and child session identities are the same" };
    }
    const runId = recordRunId(record);
    const job = context.jobs.get(runId);
    if (!job || !job.childSessions?.length) {
      return { status: "pending", detail: "fresh child session identity is not observed" };
    }
    if (parentId && job.status.sessionId && parentId !== job.status.sessionId) {
      fail("job parent session identity does not match dispatch evidence");
    }
    if (
      parentId &&
      job.childSessions?.some(
        (session) => session.header.parentSession && session.header.parentSession !== parentId,
      )
    ) {
      return { status: "failed", detail: "child session parent identity disagrees with dispatch" };
    }
  }
  return {
    status: "passed",
    detail: "active child sessions are distinct and fresh-context inputs are observed",
  };
}

function lifecycleState(records, context, kind, manifest) {
  const relevant = records.filter(
    (record) =>
      !isAssistantClaim(record) &&
      candidateIdentityMatches(record, manifest) &&
      (record.kind === "lifecycle" || record.kind === "job" || record.kind === "runtime"),
  );
  const jobs = [...context.jobs.values()].filter(
    (job) => !isAssistantClaim(job.record) && candidateIdentityMatches(job.record, manifest),
  );
  const candidates = jobs.filter((job) => {
    if (job.eventTraceTruncated) return false;
    if (kind === "supervisor") {
      return (
        job.eventTypes?.includes("subagent.run.pausing") ||
        job.eventTypes?.includes("subagent.run.paused")
      );
    }
    return job.eventTypes?.includes("subagent.resume.requested");
  });
  if (candidates.length === 0) {
    const blocked = relevant.find(
      (record) => record.status === "blocked" || record.blocked === true,
    );
    return blocked
      ? { status: "blocked", detail: "native lifecycle prerequisite is unavailable" }
      : { status: "pending", detail: "native lifecycle transition evidence is missing" };
  }
  const job = candidates.find((candidate) => {
    const types = new Set(candidate.eventTypes);
    const hasResume = types.has("subagent.resume.requested");
    const continued =
      ["continued", "complete"].includes(candidate.status?.state) ||
      candidate.result?.state === "continued";
    const hasContinuation = Boolean(
      candidate.continuation?.continuationRunId || candidate.continuation?.phase === "continued",
    );
    return (
      hasResume &&
      continued &&
      (kind === "supervisor" ? types.has("subagent.run.paused") : true) &&
      (hasContinuation || candidate.resumed)
    );
  });
  if (!job)
    return { status: "pending", detail: "pause/resume is not a same-job terminal lifecycle" };
  if (kind === "supervisor") {
    const request = records.find(
      (record) =>
        candidateIdentityMatches(record, manifest) &&
        (record.request?.tool === "contact_supervisor" || record.tool === "contact_supervisor"),
    );
    if (!request)
      return { status: "pending", detail: "native contact_supervisor request evidence is missing" };
    if (request.runId && request.runId !== job.runId) {
      return { status: "failed", detail: "supervisor request targets a different logical job" };
    }
    if (
      request.childSessionId &&
      (!job.childSessionIds?.size || !job.childSessionIds.has(request.childSessionId))
    ) {
      return { status: "failed", detail: "supervisor request targets a different child session" };
    }
    if (request.sessionPath) {
      const session = parseSessionFile(context.workspace, request.sessionPath, {
        sessionId: request.childSessionId,
      });
      if (session.supervisorCalls.length === 0)
        return {
          status: "pending",
          detail: "active child session has no completed contact_supervisor call",
        };
    }
  }
  const sameId =
    relevant.some((record) => {
      const receipt = nonEmptyString(
        record.receiptId || record.jobId || record.asyncId || record.runId,
      );
      const resume = nonEmptyString(
        record.resumeId || record.resumeJobId || record.resumeAsyncId || record.resumeRunId,
      );
      return receipt && resume && receipt === resume && receipt === job.runId;
    }) ||
    (relevant.some((record) => record.runId === job.runId && record.receiptObserved === true) &&
      job.resumed &&
      Boolean(job.continuation));
  if (!sameId && relevant.some((record) => record.newDispatch === true)) {
    return { status: "failed", detail: "resume was replaced by a new dispatch" };
  }
  if (!sameId)
    return {
      status: "pending",
      detail: "same-job identity is not explicit in the lifecycle receipt",
    };
  return {
    status: "passed",
    detail: "native pause/status/resume events retain one logical job identity",
  };
}

function genericState(records, check) {
  const relevant = records.filter((record) => record.checkIds.includes(check.id));
  const failed = relevant.find(
    (record) => record.status === "failed" || record.failed === true || record.violation === true,
  );
  if (failed) return { status: "failed", detail: "a demonstrated runtime violation was observed" };
  const blocked = relevant.find((record) => record.status === "blocked" || record.blocked === true);
  if (blocked)
    return { status: "blocked", detail: "the prerequisite for this check is unavailable" };
  return { status: "pending", detail: "the prepared evidence does not prove this property" };
}

function evaluateCheck(check, context) {
  const records = recordsForCheck(context, check);
  if (context.globalFailed) return { status: "failed", detail: context.globalFailed };
  if (context.globalBlocked) return { status: "blocked", detail: context.globalBlocked };
  if (check.humanReviewRequired === true) return humanReviewState(records, context, check);
  if (check.id === "architect-plan-approval-gate") return approvalState(records, context);
  if (check.id === "architect-ticket-approval-gate") return ticketApprovalState(records, context);
  if (check.id === "architect-independent-function-behavior") {
    const tests = records
      .filter((record) => ["fixture-test", "test-result"].includes(record.kind))
      .map((record) => inspectFixtureTest(context.workspace, record, context.manifest));
    const changes = records
      .filter((record) => record.kind === "fixture-change")
      .map((record) => inspectFixtureChange(context.workspace, record, context.manifest));
    if (changes.some((change) => change.violated))
      return {
        status: "failed",
        detail: "fixture change evidence reports an out-of-scope or staged change",
      };
    if (tests.some((test) => test.passed) && changes.some((change) => change.passed))
      return {
        status: "passed",
        detail: "independent fixture test result and observed fixture change are correlated",
      };
    return {
      status: "pending",
      detail: "independent fixture test output is absent or not fully qualified",
    };
  }
  if (check.id === "architect-fixture-repo-contained") {
    const changes = records
      .filter((record) => record.kind === "fixture-change")
      .map((record) => inspectFixtureChange(context.workspace, record, context.manifest));
    if (changes.some((change) => change.violated))
      return {
        status: "failed",
        detail: "fixture change evidence reports a containment violation",
      };
    return changes.some((change) => change.passed)
      ? {
          status: "passed",
          detail: "observed change record stays inside the disposable fixture and is unstaged",
        }
      : {
          status: "pending",
          detail: "no independently captured fixture containment record is available",
        };
  }
  if (check.id === "architect-orchestration-boundary") {
    const observed = records.find(
      (record) =>
        ["orchestration", "actor-trace"].includes(record.kind) &&
        !isAssistantClaim(record) &&
        candidateIdentityMatches(record, context.manifest),
    );
    if (!observed)
      return { status: "pending", detail: "parent/child actor boundary evidence is missing" };
    if (observed.parentEdited === true || observed.violation === true)
      return { status: "failed", detail: "parent-side fixture editing was observed" };
    const dispatches = context.records.filter(
      (record) =>
        record.kind === "dispatch" &&
        !isAssistantClaim(record) &&
        candidateIdentityMatches(record, context.manifest),
    );
    let dispatchFailure;
    const correlated = dispatches.find((record) => {
      const outcome = dispatchState(record, context, context.manifest, recordRole(record));
      if (outcome.status === "failed" && !dispatchFailure) dispatchFailure = outcome;
      return outcome.status === "passed";
    });
    if (!correlated) {
      return (
        dispatchFailure || {
          status: "pending",
          detail: "parent/child actor boundary lacks correlated native call/result/job evidence",
        }
      );
    }
    const observedRunId = recordRunId(observed);
    const correlatedRunId = recordRunId(correlated);
    if (!observedRunId || !correlatedRunId) {
      return { status: "pending", detail: "actor trace has no correlated child run identity" };
    }
    if (observedRunId !== correlatedRunId) {
      return { status: "failed", detail: "actor trace points to a different child run" };
    }
    for (const field of [
      "parentSessionId",
      "parentSessionPath",
      "parentEntryId",
      "toolCallId",
      "childSessionId",
    ]) {
      if (!nonEmptyString(observed[field])) {
        return {
          status: "pending",
          detail: "actor trace has incomplete native parent/child identity",
        };
      }
    }
    if (observed.parentSessionId !== correlated.parentSessionId) {
      return { status: "failed", detail: "actor trace points to a different parent session" };
    }
    if (
      observed.parentSessionPath !== correlated.parentSessionPath ||
      observed.parentEntryId !== correlated.parentEntryId ||
      observed.toolCallId !== correlated.toolCallId
    ) {
      return { status: "failed", detail: "actor trace points to a different parent dispatch" };
    }
    if (observed.childSessionId !== correlated.childSessionId) {
      return { status: "failed", detail: "actor trace points to a different child session" };
    }
    const job = context.jobs.get(correlatedRunId);
    if (!job?.childSessionIds?.has(observed.childSessionId)) {
      return { status: "failed", detail: "actor trace points to a different child session" };
    }
    return observed.childEdited === true && observed.dispatchObserved === true
      ? {
          status: "passed",
          detail:
            "correlated native call/result/job evidence separates parent orchestration from child editing",
        }
      : { status: "pending", detail: "actor trace is not complete enough to prove the boundary" };
  }
  if (check.id.endsWith("-dispatch")) {
    const role = check.id.replace(/^subagent-acceptance-/, "").replace(/-dispatch$/, "");
    const normalizedRole = check.id.startsWith("architect-")
      ? role.replace("architect-", "")
      : role;
    const dispatchRecord = records.find((record) => record.kind === "dispatch");
    if (!dispatchRecord)
      return { status: "pending", detail: "canonical dispatch evidence is missing" };
    const outcome = dispatchState(dispatchRecord, context, context.manifest, normalizedRole);
    if (outcome.status !== "passed" || !check.id.startsWith("architect-")) return outcome;
    const order = architectWorkflowOrder(context.records, context);
    return order.status === "passed" ? outcome : order;
  }
  if (check.id.endsWith("-execution")) {
    const role = check.id.replace(/^subagent-acceptance-/, "").replace(/-execution$/, "");
    return roleExecutionState(records, context, role, context.manifest);
  }
  if (check.id === "subagent-acceptance-nonallowlisted-block")
    return noLaunchState(records, context, context.manifest);
  if (check.id === "subagent-acceptance-user-scope")
    return scopeState(context.records, context, context.manifest);
  if (check.id === "subagent-acceptance-fresh-context")
    return freshContextState(context.records, context, context.manifest);
  if (check.id === "subagent-acceptance-native-supervisor-pause-resume")
    return lifecycleState(records, context, "supervisor", context.manifest);
  if (check.id === "subagent-acceptance-async-status-resume")
    return lifecycleState(records, context, "async", context.manifest);
  return genericState(records, check);
}

function manifestFromFile(workspace, manifestReference, scenarioId) {
  const { target, value } = readJsonFile(workspace, manifestReference, "evidence manifest");
  if (value.schemaVersion !== 1) fail("unsupported evidence manifest version");
  if (value.suiteVersion !== ACCEPTANCE_SUITE_VERSION) fail("unsupported acceptance suite version");
  if (nonEmptyString(value.suiteId) !== ACCEPTANCE_SUITE_ID)
    fail("evidence manifest belongs to another suite");
  if (
    value.acceptanceModel !== undefined &&
    value.acceptanceModel !== null &&
    !isObject(value.acceptanceModel)
  )
    fail("evidence manifest acceptance model is malformed");
  if (isObject(value.acceptanceModel)) {
    for (const field of ["requested", "provider", "model", "thinkingLevel", "fallbackPolicy"]) {
      if (
        value.acceptanceModel[field] !== undefined &&
        typeof value.acceptanceModel[field] !== "string"
      ) {
        fail("evidence manifest acceptance model is malformed");
      }
    }
    if (
      value.acceptanceModel.requested !== undefined &&
      !acceptanceModelPattern.test(nonEmptyString(value.acceptanceModel.requested))
    ) {
      fail("evidence manifest acceptance model is malformed");
    }
  }
  for (const field of [
    "status",
    "mode",
    "commit",
    "candidateCommit",
    "ref",
    "candidateRef",
    "packageName",
    "packageVersion",
    "packageSha256",
    "observedRuntimeVersion",
    "validationKind",
  ]) {
    if (value.candidate?.[field] !== undefined && typeof value.candidate[field] !== "string") {
      fail("evidence manifest candidate identity is malformed");
    }
  }
  if (nonEmptyString(value.scenarioId) !== scenarioId)
    fail("evidence manifest scenario id does not match its directory");
  if (typeof value.status !== "string" || !allowedManifestStatuses.has(value.status))
    fail("evidence manifest has an invalid status");
  if (!Array.isArray(value.checks)) fail("evidence manifest checks must be an array");
  for (const field of ["candidate", "fixture", "dispatchPolicy", "prerequisites"]) {
    if (value[field] !== undefined && !isObject(value[field]))
      fail(`evidence manifest ${field} must be an object`);
  }
  const checks = value.checks.map((check) => {
    if (!isObject(check) || !nonEmptyString(check.id) || !nonEmptyString(check.label))
      fail("evidence manifest contains a malformed check");
    if (check.id !== check.id.trim()) fail("evidence manifest contains a malformed check id");
    if (check.capture !== undefined && !isObject(check.capture))
      fail(`check ${check.id} has malformed capture metadata`);
    if (check.humanReviewRequired !== undefined && typeof check.humanReviewRequired !== "boolean") {
      fail(`check ${check.id} has malformed review metadata`);
    }
    const locations = check.captureLocations || check.capture?.locations;
    if (
      !Array.isArray(locations) ||
      locations.length === 0 ||
      locations.some((location) => typeof location !== "string" || !location.trim())
    ) {
      fail(`check ${check.id} has malformed capture locations`);
    }
    return { ...check, captureLocations: locations };
  });
  const checkIds = new Set(checks.map((check) => check.id));
  if (checkIds.size !== checks.length) fail("evidence manifest contains duplicate check ids");
  if (
    value.dispatchPolicy?.allowedRoles !== undefined &&
    (!Array.isArray(value.dispatchPolicy.allowedRoles) ||
      value.dispatchPolicy.allowedRoles.some((role) => typeof role !== "string" || !role.trim()))
  ) {
    fail("evidence manifest dispatch policy has malformed allowed roles");
  }
  if (
    Array.isArray(value.dispatchPolicy?.allowedRoles) &&
    new Set(value.dispatchPolicy.allowedRoles).size !== value.dispatchPolicy.allowedRoles.length
  ) {
    fail("evidence manifest dispatch policy has duplicate roles");
  }
  if (
    value.dispatchPolicy?.requiredScope !== undefined &&
    typeof value.dispatchPolicy.requiredScope !== "string"
  ) {
    fail("evidence manifest dispatch policy has malformed scope");
  }
  if (
    value.prerequisites?.missing !== undefined &&
    (!Array.isArray(value.prerequisites.missing) ||
      value.prerequisites.missing.some((item) => typeof item !== "string"))
  ) {
    fail("evidence manifest prerequisites are malformed");
  }
  if (
    value.fixture?.ticketIds !== undefined &&
    (!Array.isArray(value.fixture.ticketIds) ||
      value.fixture.ticketIds.some((id) => typeof id !== "string" || !id.trim()))
  ) {
    fail("evidence manifest fixture ticket ids are malformed");
  }
  if (
    Array.isArray(value.fixture?.ticketIds) &&
    new Set(value.fixture.ticketIds).size !== value.fixture.ticketIds.length
  ) {
    fail("evidence manifest fixture ticket ids are duplicated");
  }
  const fixtureReference = nonEmptyString(value.fixture?.workspacePath);
  if (!fixtureReference) fail("evidence manifest has no fixture workspace");
  const fixtureTarget = resolveOwnedReference(workspace, fixtureReference, "fixture workspace", {
    allowMissing: false,
  });
  const fixtureStats = lstatSync(fixtureTarget);
  if (!fixtureStats.isDirectory() || fixtureStats.isSymbolicLink())
    fail("fixture workspace must be a regular directory");
  return {
    target,
    ...value,
    fixture: {
      ...value.fixture,
      workspacePath: workspaceRelative(workspace, fixtureTarget),
    },
    scenarioId,
    suiteId: value.suiteId,
    checks,
    checkIds,
  };
}

function findManifestReferences(workspace) {
  const references = [];
  const direct = join(workspace, "evidence-manifest.json");
  try {
    const directStats = lstatSync(direct);
    if (directStats.isSymbolicLink()) fail("evidence manifest cannot be a symlink");
    if (directStats.isFile()) references.push("evidence-manifest.json");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const artifacts = join(workspace, "artifacts");
  let artifactStats;
  try {
    artifactStats = lstatSync(artifacts);
  } catch (error) {
    if (error?.code === "ENOENT") return references;
    throw error;
  }
  if (!artifactStats.isDirectory() || artifactStats.isSymbolicLink())
    fail("artifacts must be a regular directory");
  for (const entry of readdirSync(artifacts)) {
    const scenarioDir = join(artifacts, entry);
    const stats = lstatSync(scenarioDir);
    if (stats.isSymbolicLink()) fail("scenario artifact directories cannot be symlinks");
    if (!stats.isDirectory()) continue;
    const manifest = join(scenarioDir, "evidence-manifest.json");
    try {
      const manifestStats = lstatSync(manifest);
      if (manifestStats.isSymbolicLink()) fail("evidence manifest cannot be a symlink");
      if (manifestStats.isFile())
        references.push(normalizePathValue(relative(workspace, manifest)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return references.sort();
}

function collectScenarioContext(workspace, manifestReference) {
  const scenarioId =
    manifestReference === "evidence-manifest.json"
      ? "root"
      : normalizePathValue(relative(workspace, dirname(resolve(workspace, manifestReference))))
          .split("/")
          .at(-1);
  const manifest = manifestFromFile(workspace, manifestReference, scenarioId);
  const captureIds = manifestCaptureReferences(manifest);
  const conventionalRecords = join(
    dirname(resolve(workspace, manifestReference)),
    "evidence",
    "evidence-records.jsonl",
  );
  try {
    const recordsStats = lstatSync(conventionalRecords);
    if (recordsStats.isSymbolicLink() || !recordsStats.isFile()) {
      fail("conventional evidence records must be a regular file");
    }
    const recordsReference = workspaceRelative(workspace, conventionalRecords);
    if (!captureIds.has(recordsReference)) captureIds.set(recordsReference, new Set());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const context = {
    workspace,
    manifest,
    records: [],
    captureCheckIds: new Map(),
    jobs: new Map(),
    sessionCache: new Map(),
    evidenceReferences: new Set([normalizePathValue(manifestReference)]),
    globalBlocked:
      Array.isArray(manifest.prerequisites?.missing) && manifest.prerequisites.missing.length > 0
        ? "manifest records a missing prerequisite"
        : manifest.status === "blocked"
          ? "prepared run is blocked"
          : manifest.candidate?.status !== "ready" ||
              manifest.candidate?.mode !== "packaged-commit" ||
              !nonEmptyString(manifest.candidate?.commit)
            ? "candidate identity/prerequisite is not a frozen packaged snapshot"
            : "",
    globalFailed: manifest.status === "failed" ? "manifest records a demonstrated failure" : "",
  };
  for (const [rawReference, checkSet] of captureIds.entries()) {
    const reference = captureReferenceForManifest(manifest, rawReference);
    const target = resolveOwnedReference(workspace, reference, "capture reference", {
      allowMissing: true,
    });
    if (!existsSync(target)) continue;
    const stats = lstatSync(target);
    if (!stats.isFile() || stats.isSymbolicLink())
      fail(`capture reference is not a regular file: ${reference}`);
    const relativeReference = workspaceRelative(workspace, target);
    context.evidenceReferences.add(relativeReference);
    context.captureCheckIds.set(relativeReference, checkSet);
    if (extname(target).toLowerCase() !== ".jsonl") continue;
    const parsed = readJsonlFile(workspace, reference, `capture evidence ${reference}`);
    for (const entry of parsed.records) {
      const record = normalizeEvidenceRecord(
        entry.value,
        relativeReference,
        entry.line,
        manifest,
        checkSet,
      );
      context.records.push(record);
      if (
        ["job", "runtime", "lifecycle", "dispatch", "execution", "role-result"].includes(
          record.kind,
        ) &&
        (record.statusPath ||
          record.asyncDir ||
          record.resultPath ||
          record.job ||
          record.kind !== "dispatch")
      ) {
        inspectJobRecord(workspace, record, context);
      }
      if (record.sessionPath && record.kind === "session") {
        const session = parseSessionFile(workspace, record.sessionPath, {
          sessionId: record.sessionId,
        });
        context.sessionCache.set(session.reference, session);
        context.evidenceReferences.add(session.reference);
      }
      if (record.kind === "fixture-test" || record.kind === "test-result") {
        const fixtureTest = inspectFixtureTest(workspace, record, manifest);
        if (fixtureTest.reference && fixtureTest.reference !== record.sourceReference) {
          context.evidenceReferences.add(fixtureTest.reference);
        }
      }
      if (record.kind === "fixture-change") inspectFixtureChange(workspace, record, manifest);
    }
  }
  // A manifest with no evidence files is a valid prepared/incomplete run, not a
  // passing result. Every check remains pending or blocked below.
  return context;
}

function statusLimitations(context) {
  return [
    "offline evaluator scores only allowlisted native evidence and explicit human attestations",
    "reports are local evidence summaries, not tamper-proof attestations or sandbox guarantees",
    "assistant prose, selected model text, static source checks, and prepared fixtures never pass checks",
    ...(context.globalBlocked ? ["missing prerequisites remain blocked"] : []),
  ];
}

function idempotencyKey(contexts) {
  const payload = contexts.map((context) => ({
    suiteId: context.manifest.suiteId,
    suiteVersion: context.manifest.suiteVersion,
    scenarioId: context.manifest.scenarioId,
    candidateCommit: context.manifest.candidate?.commit || "",
    references: [...context.evidenceReferences].sort(),
    records: context.records.map((record) => ({
      sourceReference: record.sourceReference,
      line: record.line,
      kind: record.kind,
      checkIds: record.checkIds,
      runId: recordRunId(record),
    })),
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function evaluateAcceptanceWorkspace(workspace) {
  const workspaceValue = nonEmptyString(workspace);
  if (!workspaceValue) fail("workspace is required");
  const workspacePath = resolve(workspaceValue);
  if (!existsSync(workspacePath)) fail(`workspace does not exist: ${workspace}`);
  const workspaceStats = lstatSync(workspacePath);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink())
    fail("workspace must be a regular directory");
  const manifestReferences = findManifestReferences(workspacePath);
  if (manifestReferences.length === 0) {
    return createAcceptanceEvidenceSuiteResult({
      selectedScenarios: [],
      scenarioResults: [],
      suiteId: ACCEPTANCE_SUITE_ID,
      suiteVersion: ACCEPTANCE_SUITE_VERSION,
      candidate: {},
      evidenceReferences: [],
      limitations: ["no prepared evidence manifest was found"],
    });
  }
  const contexts = manifestReferences.map((reference) =>
    collectScenarioContext(workspacePath, reference),
  );
  const scenarioIds = new Set(contexts.map((context) => context.manifest.scenarioId));
  if (scenarioIds.size !== contexts.length) fail("duplicate acceptance scenario identity");
  const candidateIdentities = new Set(
    contexts.map(
      (context) =>
        `${context.manifest.candidate?.mode || ""}:${context.manifest.candidate?.commit || ""}`,
    ),
  );
  if (candidateIdentities.size > 1) fail("acceptance scenarios use different candidate identities");
  const scenarioResults = contexts.map((context) => {
    const checks = context.manifest.checks.map((definition) => {
      const outcome = evaluateCheck(definition, context);
      const artifacts = [
        ...new Set([
          ...context.evidenceReferences,
          ...(definition.captureLocations || []).map((reference) =>
            captureReferenceForManifest(context.manifest, reference),
          ),
        ]),
      ].filter(
        (reference) =>
          reference && pathIsWithinRoot(resolve(workspacePath, reference), workspacePath),
      );
      return createEvidenceScoreCheck({
        id: definition.id,
        label: definition.label,
        status: outcome.status,
        details: outcome.detail,
        artifacts,
        category: definition.humanReviewRequired === true ? MANUAL_CHECK : MACHINE_CHECK,
      });
    });
    return createAcceptanceEvidenceScenarioResult({
      scenarioId: context.manifest.scenarioId,
      mode: "acceptance-evidence",
      summary: `${context.manifest.scenarioId} offline acceptance evidence`,
      detail: context.globalBlocked || "deterministic offline evidence evaluation",
      checks,
      artifacts: [...context.evidenceReferences].sort(),
      identity: {
        suiteId: context.manifest.suiteId,
        scenarioId: context.manifest.scenarioId,
        candidateCommit: context.manifest.candidate?.commit || "",
      },
    });
  });
  const firstManifest = contexts[0].manifest;
  const evidenceReferences = [
    ...new Set(contexts.flatMap((context) => [...context.evidenceReferences])),
  ].sort();
  const report = createAcceptanceEvidenceSuiteResult({
    selectedScenarios: contexts.map((context) => ({
      id: context.manifest.scenarioId,
      mode: "acceptance-evidence",
    })),
    scenarioResults,
    suiteId: firstManifest.suiteId,
    suiteVersion: firstManifest.suiteVersion || ACCEPTANCE_SUITE_VERSION,
    candidate: firstManifest.candidate || {},
    evidenceReferences,
    limitations: [...new Set(contexts.flatMap(statusLimitations))],
  });
  report.metadata.idempotencyKey = idempotencyKey(contexts);
  return report;
}

export const evaluateWorkspace = evaluateAcceptanceWorkspace;

export function writeAcceptanceEvidenceReport(workspace, report) {
  const workspacePath = resolve(String(workspace || ""));
  const output = resolveOwnedReference(
    workspacePath,
    ACCEPTANCE_EVIDENCE_REPORT_FILE,
    "acceptance report output",
    {
      allowMissing: true,
    },
  );
  assertNoSymlinkComponents(output, workspacePath, "acceptance report output", true);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return workspaceRelative(workspacePath, output);
}

export function evaluationExitCode(report) {
  if (report.status === "passed") return 0;
  if (["pending", "blocked", "prepared"].includes(report.status)) return 2;
  return 1;
}

function usage() {
  return `Usage: node tests/evals/tlh-acceptance-evidence.mjs --workspace DIR\n\nEvaluate explicit native evidence from an owned prepared run without launching providers or executing manifest/transcript commands.\nExit codes: 0 all checks passed; 1 demonstrated failure or invalid evidence; 2 pending/incomplete/blocked.\n`;
}

export function parseArgs(argv) {
  let workspace = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") return { help: true, workspace: "" };
    if (arg === "--workspace") {
      workspace = argv[++index] || "";
      if (!workspace || workspace.startsWith("-")) fail("--workspace requires DIR");
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      workspace = arg.slice("--workspace=".length);
      if (!workspace) fail("--workspace requires DIR");
      continue;
    }
    fail(`unknown option: ${arg}`);
  }
  if (!workspace) fail("--workspace DIR is required");
  return { help: false, workspace };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const report = evaluateAcceptanceWorkspace(args.workspace);
    const reportPath = writeAcceptanceEvidenceReport(args.workspace, report);
    console.log(`${report.status}: ${reportPath}`);
    return evaluationExitCode(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`acceptance evidence error: ${message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
