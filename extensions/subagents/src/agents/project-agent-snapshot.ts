import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./agents.ts";

/** Project run references outlive the UI cleanup window for terminal resume. */
export const PROJECT_AGENT_TERMINAL_RETENTION_MS = 10 * 60 * 1000;

/**
 * A parsed project agent and the digest of the exact bytes that produced it.
 *
 * The provider owns the immutable copy stored in a generation. Callers must
 * not use this shape as a model-facing argument or serialize it as authority.
 */
export interface ProjectAgentSnapshotEntry {
  readonly agent: AgentConfig;
  readonly digest: string;
  readonly frontmatterFields: readonly string[];
}

export interface ProjectAgentSnapshotProvenance {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly processInstanceId: string;
}

/** Safe per-child provenance persisted with a project-agent run. */
export interface ProjectAgentRunProvenance extends ProjectAgentSnapshotProvenance {
  readonly source: "project";
  readonly agent: string;
  readonly digest: string;
}

/**
 * The exact effective agent configuration approved for one run child. This is
 * safe to persist because it is data only; the process-private capability is
 * deliberately not part of the capture.
 */
export interface ProjectAgentRunCapture {
  readonly provenance: ProjectAgentRunProvenance;
  readonly config: AgentConfig;
}

/** Input accepted by the process-private project snapshot provider. */
export interface ProjectAgentSnapshotInput {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly entries: readonly ProjectAgentSnapshotEntry[];
  readonly tombstones?: readonly string[];
}

/** An immutable generation retained by the process-private provider. */
export interface ProjectAgentSnapshotManifest {
  readonly entries: readonly ProjectAgentSnapshotEntry[];
  readonly tombstones: readonly string[];
  readonly provenance: ProjectAgentSnapshotProvenance;
}

/** The identity a trusted caller must present when resolving a capability. */
export type ProjectAgentSnapshotExpected = ProjectAgentSnapshotProvenance;

/**
 * Deliberately has no serializable authority-bearing fields. The registry uses
 * the object identity of the returned frozen object as the capability.
 */
declare const projectAgentSnapshotCapabilityBrand: unique symbol;
export type ProjectAgentSnapshotCapability = {
  readonly [projectAgentSnapshotCapabilityBrand]: "ProjectAgentSnapshotCapability";
};

export interface ProjectAgentSnapshotDigest {
  readonly name: string;
  readonly digest: string;
}

/** Safe metadata for carrying a resolved generation into later runtime gates. */
export interface ProjectAgentSnapshotDiscoveryMetadata {
  readonly provenance: ProjectAgentSnapshotProvenance;
  readonly entries: readonly ProjectAgentSnapshotDigest[];
  readonly tombstones: readonly string[];
  readonly disabledByUser: readonly string[];
}

export class ProjectAgentSnapshotCapabilityError extends Error {
  readonly code = "INVALID_PROJECT_AGENT_SNAPSHOT_CAPABILITY" as const;

  constructor() {
    super("Project agent snapshot capability is invalid or does not match the expected identity.");
    this.name = "ProjectAgentSnapshotCapabilityError";
  }
}

export class ProjectAgentSnapshotMergeError extends Error {
  readonly code = "PROJECT_AGENT_SNAPSHOT_CONFLICT" as const;

  constructor(name: string, source: string) {
    super(
      `Project agent snapshot cannot replace or remove '${name}' from non-embedded ${source} discovery.`,
    );
    this.name = "ProjectAgentSnapshotMergeError";
  }
}

interface RegisteredProjectAgentSnapshot {
  readonly manifest: ProjectAgentSnapshotManifest;
  readonly referenceIds: Set<string>;
}

interface ProjectAgentRunReference {
  readonly capability: ProjectAgentSnapshotCapability;
  readonly captures: readonly ProjectAgentRunCapture[];
}

export type ProjectAgentRunReferenceLookup =
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "ambiguous";
      readonly runIds: readonly string[];
      readonly captures: readonly ProjectAgentRunProvenance[];
    }
  | {
      readonly status: "found";
      readonly runId: string;
      readonly captures: readonly ProjectAgentRunCapture[];
    };

interface ProjectAgentSnapshotRegistryState {
  readonly processInstanceId: string;
  readonly registry: WeakMap<object, RegisteredProjectAgentSnapshot>;
  readonly registeredCapabilities: Set<ProjectAgentSnapshotCapability>;
  readonly runReferences: Map<string, ProjectAgentRunReference>;
  referenceOwners: Map<string, ProjectAgentSnapshotCapability>;
}

// Pi / Jiti can re-evaluate extension modules during /reload. Keep this state
// on the process global so an old capability and its run references survive
// module replacement while remaining inaccessible to other processes.
const GLOBAL_REGISTRY_KEY = Symbol.for("the-last-harness.project-agent-snapshot-registry");
const GLOBAL_STATE = globalThis as typeof globalThis & {
  [GLOBAL_REGISTRY_KEY]?: ProjectAgentSnapshotRegistryState;
};
const REGISTRY_STATE =
  GLOBAL_STATE[GLOBAL_REGISTRY_KEY] ??
  (GLOBAL_STATE[GLOBAL_REGISTRY_KEY] = {
    processInstanceId: randomUUID(),
    registry: new WeakMap<object, RegisteredProjectAgentSnapshot>(),
    registeredCapabilities: new Set<ProjectAgentSnapshotCapability>(),
    runReferences: new Map<string, ProjectAgentRunReference>(),
    referenceOwners: new Map<string, ProjectAgentSnapshotCapability>(),
  });
const PROCESS_INSTANCE_ID = REGISTRY_STATE.processInstanceId;
// Older module evaluations predate the owner index. Recreate it in place so a
// /reload can still release references created by the previous evaluation.
const REFERENCE_OWNERS =
  REGISTRY_STATE.referenceOwners ??
  (REGISTRY_STATE.referenceOwners = new Map<string, ProjectAgentSnapshotCapability>());
// The WeakMap validates object identity. The strong set retains generations
// while they are active or referenced by resumable runs; cleanup removes the
// set entry once no private reference remains.
const REGISTRY = REGISTRY_STATE.registry;
const REGISTERED_CAPABILITIES = REGISTRY_STATE.registeredCapabilities;
const RUN_REFERENCES = REGISTRY_STATE.runReferences;

interface ProjectAgentSnapshotOperations {
  retainSnapshotReference: (capability: unknown, referenceId: string) => void;
  releaseSnapshotReference: (referenceId: string) => void;
  releaseRunReferencesForSession: (sessionId: string) => number;
  getRunReferenceMetadata: (runId: string) => readonly ProjectAgentRunProvenance[] | undefined;
  lookupRunReference: (runId: string) => ProjectAgentRunReferenceLookup;
}

const OPERATIONS_GLOBAL_KEY = Symbol.for("the-last-harness.project-agent-snapshot-operations");
const OPERATIONS_GLOBAL = globalThis as typeof globalThis & {
  [OPERATIONS_GLOBAL_KEY]?: ProjectAgentSnapshotOperations;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidCapability(): ProjectAgentSnapshotCapabilityError {
  return new ProjectAgentSnapshotCapabilityError();
}

function asCapability(value: Record<string, unknown>): ProjectAgentSnapshotCapability {
  // SAFETY: Every caller immediately rechecks the WeakMap registry by object identity.
  return value as ProjectAgentSnapshotCapability;
}

function cloneAndFreeze<T>(value: T, ancestors = new Set<object>()): T {
  const raw = value as unknown;
  if (
    raw === null ||
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean" ||
    raw === undefined
  ) {
    return value;
  }
  if (typeof raw !== "object") {
    throw new TypeError("Project agent snapshot values must contain only JSON-compatible values.");
  }
  if (ancestors.has(raw)) {
    throw new TypeError("Project agent snapshot values cannot contain cycles.");
  }
  ancestors.add(raw);

  let clone: unknown;
  if (Array.isArray(raw)) {
    clone = raw.map((item) => cloneAndFreeze(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Project agent snapshot values must be plain objects.");
    }
    const record: Record<string, unknown> = {};
    const source = raw as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      Object.defineProperty(record, key, {
        configurable: true,
        enumerable: true,
        value: cloneAndFreeze(source[key], ancestors),
        writable: true,
      });
    }
    clone = record;
  }

  ancestors.delete(raw);
  return Object.freeze(clone) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonCompatible(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonCompatible(item, ancestors))
    : isPlainObject(value) &&
      Object.values(value).every((item) => isJsonCompatible(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function validCapturedAgentConfig(value: unknown): value is AgentConfig {
  if (!isPlainObject(value)) return false;
  if (
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.description) ||
    !isNonEmptyString(value.filePath) ||
    typeof value.systemPrompt !== "string" ||
    (value.systemPromptMode !== "append" && value.systemPromptMode !== "replace") ||
    typeof value.inheritProjectContext !== "boolean" ||
    typeof value.inheritSkills !== "boolean" ||
    value.source !== "project"
  )
    return false;
  if (!isJsonCompatible(value)) return false;
  const stringArrays = [
    value.tools,
    value.fallbackModels,
    value.skills,
    value.extensions,
    value.subagentOnlyExtensions,
    value.defaultReads,
  ];
  if (
    stringArrays.some(
      (items) => items !== undefined && (!Array.isArray(items) || !items.every(isNonEmptyString)),
    )
  )
    return false;
  if (value.model !== undefined && typeof value.model !== "string") return false;
  if (
    value.thinking !== undefined &&
    value.thinking !== false &&
    typeof value.thinking !== "string"
  )
    return false;
  if (
    value.acceptanceRole !== undefined &&
    value.acceptanceRole !== "read-only" &&
    value.acceptanceRole !== "writer"
  )
    return false;
  for (const field of [
    "defaultProgress",
    "interactive",
    "completionGuard",
    "supervisorBridge",
    "disabled",
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") return false;
  }
  for (const field of ["maxSubagentDepth", "maxExecutionTimeMs"] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]) || value[field] < 0)
    )
      return false;
  }
  return true;
}

function validRunProvenance(value: unknown): value is ProjectAgentRunProvenance {
  if (!isRecord(value)) return false;
  return (
    value.source === "project" &&
    isNonEmptyString(value.projectRoot) &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.generationId) &&
    isNonEmptyString(value.processInstanceId) &&
    isNonEmptyString(value.agent) &&
    isNonEmptyString(value.digest)
  );
}

export function normalizeProjectAgentRunProvenance(
  value: unknown,
): ProjectAgentRunProvenance | undefined {
  if (!validRunProvenance(value)) return undefined;
  return {
    projectRoot: value.projectRoot,
    sessionId: value.sessionId,
    generationId: value.generationId,
    processInstanceId: value.processInstanceId,
    source: "project",
    agent: value.agent,
    digest: value.digest,
  };
}

/** Parse safe persisted metadata without ever treating it as capability authority. */
export function normalizeProjectAgentRunCapture(
  value: unknown,
): ProjectAgentRunCapture | undefined {
  if (
    !isRecord(value) ||
    !validRunProvenance(value.provenance) ||
    !validCapturedAgentConfig(value.config)
  ) {
    return undefined;
  }
  if (
    value.config.name !== value.provenance.agent ||
    value.config.source !== value.provenance.source ||
    !isJsonCompatible(value)
  ) {
    return undefined;
  }
  return {
    provenance: {
      projectRoot: value.provenance.projectRoot,
      sessionId: value.provenance.sessionId,
      generationId: value.provenance.generationId,
      processInstanceId: value.provenance.processInstanceId,
      source: "project",
      agent: value.provenance.agent,
      digest: value.provenance.digest,
    },
    config: value.config,
  };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Compare persisted capture bytes with the private capture retained in memory. */
export function projectAgentRunCaptureEquals(
  left: unknown,
  right: unknown,
): left is ProjectAgentRunCapture {
  const normalizedLeft = normalizeProjectAgentRunCapture(left);
  const normalizedRight = normalizeProjectAgentRunCapture(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    stableSerialize(normalizedLeft) === stableSerialize(normalizedRight),
  );
}

function projectAgentRunCaptureForEntry(
  manifest: ProjectAgentSnapshotManifest,
  agent: AgentConfig,
): ProjectAgentRunCapture {
  const entry = manifest.entries.find((candidate) => candidate.agent.name === agent.name);
  if (!entry || agent.source !== "project") throw invalidCapability();
  const capture = {
    provenance: {
      ...manifest.provenance,
      source: "project" as const,
      agent: agent.name,
      digest: entry.digest,
    },
    config: cloneAndFreeze(agent),
  } satisfies ProjectAgentRunCapture;
  return Object.freeze(capture);
}

/** Capture the exact effective config selected from a trusted generation. */
export function createProjectAgentRunCapture(
  manifest: ProjectAgentSnapshotManifest,
  agent: AgentConfig,
): ProjectAgentRunCapture {
  return projectAgentRunCaptureForEntry(manifest, agent);
}

function validateRunCaptureAgainstManifest(
  manifest: ProjectAgentSnapshotManifest,
  capture: ProjectAgentRunCapture,
): void {
  const entry = manifest.entries.find(
    (candidate) => candidate.agent.name === capture.provenance.agent,
  );
  if (
    !entry ||
    capture.provenance.source !== "project" ||
    capture.provenance.projectRoot !== manifest.provenance.projectRoot ||
    capture.provenance.sessionId !== manifest.provenance.sessionId ||
    capture.provenance.generationId !== manifest.provenance.generationId ||
    capture.provenance.processInstanceId !== manifest.provenance.processInstanceId ||
    capture.provenance.digest !== entry.digest ||
    capture.config.name !== entry.agent.name ||
    capture.config.source !== "project" ||
    capture.config.filePath !== entry.agent.filePath
  ) {
    throw invalidCapability();
  }
}

function referenceIdForRun(runId: string): string {
  return `run:${runId}`;
}

function findReferenceOwner(referenceId: string): ProjectAgentSnapshotCapability | undefined {
  const indexedOwner = REFERENCE_OWNERS.get(referenceId);
  if (indexedOwner) {
    const indexedSnapshot = REGISTRY.get(indexedOwner);
    if (indexedSnapshot?.referenceIds.has(referenceId)) return indexedOwner;
    REFERENCE_OWNERS.delete(referenceId);
  }

  // A module reload can inherit references from an older registry state that
  // did not have the owner index. Re-index only the requested reference; do
  // not sweep or collect unrelated capabilities.
  for (const capability of REGISTERED_CAPABILITIES) {
    const registered = REGISTRY.get(capability);
    if (registered?.referenceIds.has(referenceId)) {
      REFERENCE_OWNERS.set(referenceId, capability);
      return capability;
    }
  }
  return undefined;
}

function retainGenerationReference(
  capability: ProjectAgentSnapshotCapability,
  referenceId: string,
): void {
  if (!isNonEmptyString(referenceId))
    throw new TypeError("Project agent snapshot reference id must be non-empty.");
  const registered = registeredSnapshot(capability);
  const existingOwner = findReferenceOwner(referenceId);
  if (existingOwner && existingOwner !== capability) {
    throw new Error(`Project agent snapshot reference '${referenceId}' is already retained.`);
  }
  registered.referenceIds.add(referenceId);
  REFERENCE_OWNERS.set(referenceId, capability);
}

function releaseGenerationReference(
  capability: ProjectAgentSnapshotCapability,
  referenceId: string,
): boolean {
  const registered = REGISTRY.get(capability);
  if (!registered) return false;
  const released = registered.referenceIds.delete(referenceId);
  if (released && REFERENCE_OWNERS.get(referenceId) === capability) {
    REFERENCE_OWNERS.delete(referenceId);
  }
  return released;
}

function cleanupUnreferencedProjectAgentSnapshot(
  capability: ProjectAgentSnapshotCapability,
): boolean {
  const registered = REGISTRY.get(capability);
  if (!registered || registered.referenceIds.size > 0) return false;
  REGISTRY.delete(capability);
  REGISTERED_CAPABILITIES.delete(capability);
  for (const [referenceId, owner] of REFERENCE_OWNERS) {
    if (owner === capability) REFERENCE_OWNERS.delete(referenceId);
  }
  return true;
}

function cleanupUnreferencedProjectAgentSnapshots(): number {
  let removed = 0;
  for (const capability of REGISTERED_CAPABILITIES) {
    if (cleanupUnreferencedProjectAgentSnapshot(capability)) removed++;
  }
  return removed;
}

function validateRegistrationInput(input: ProjectAgentSnapshotInput): void {
  if (!isRecord(input)) throw new TypeError("Project agent snapshot input must be an object.");
  if (!isNonEmptyString(input.projectRoot)) {
    throw new TypeError("Project agent snapshot projectRoot must be a non-empty string.");
  }
  if (!isNonEmptyString(input.sessionId)) {
    throw new TypeError("Project agent snapshot sessionId must be a non-empty string.");
  }
  if (!isNonEmptyString(input.generationId)) {
    throw new TypeError("Project agent snapshot generationId must be a non-empty string.");
  }
  if (!Array.isArray(input.entries)) {
    throw new TypeError("Project agent snapshot entries must be an array.");
  }
  if (input.tombstones !== undefined && !Array.isArray(input.tombstones)) {
    throw new TypeError("Project agent snapshot tombstones must be an array when provided.");
  }

  const entryNames = new Set<string>();
  for (const entry of input.entries) {
    if (!isRecord(entry) || !isRecord(entry.agent)) {
      throw new TypeError("Project agent snapshot entries must contain an agent object.");
    }
    if (!isNonEmptyString(entry.agent.name)) {
      throw new TypeError("Project agent snapshot agent names must be non-empty strings.");
    }
    if (!isNonEmptyString(entry.agent.description)) {
      throw new TypeError("Project agent snapshot agent descriptions must be non-empty strings.");
    }
    if (!isNonEmptyString(entry.agent.filePath)) {
      throw new TypeError("Project agent snapshot agent filePath must be a non-empty string.");
    }
    if (typeof entry.agent.systemPrompt !== "string") {
      throw new TypeError("Project agent snapshot agent systemPrompt must be a string.");
    }
    if (entry.agent.systemPromptMode !== "append" && entry.agent.systemPromptMode !== "replace") {
      throw new TypeError(
        "Project agent snapshot agent systemPromptMode must be 'append' or 'replace'.",
      );
    }
    if (typeof entry.agent.inheritProjectContext !== "boolean") {
      throw new TypeError("Project agent snapshot agent inheritProjectContext must be a boolean.");
    }
    if (typeof entry.agent.inheritSkills !== "boolean") {
      throw new TypeError("Project agent snapshot agent inheritSkills must be a boolean.");
    }
    if (
      entry.agent.supervisorBridge !== undefined &&
      typeof entry.agent.supervisorBridge !== "boolean"
    ) {
      throw new TypeError("Project agent snapshot agent supervisorBridge must be a boolean.");
    }
    if (entry.agent.source !== "project") {
      throw new TypeError("Project agent snapshot agents must preserve source 'project'.");
    }
    if (entry.agent.disabled !== undefined) {
      throw new TypeError("Project agent snapshot agents must not carry a disabled field.");
    }
    if (!isNonEmptyString(entry.digest)) {
      throw new TypeError("Project agent snapshot digests must be non-empty strings.");
    }
    if (!Array.isArray(entry.frontmatterFields)) {
      throw new TypeError("Project agent snapshot frontmatterFields must be an array.");
    }
    const frontmatterFields = new Set<string>();
    for (const field of entry.frontmatterFields) {
      if (!isNonEmptyString(field)) {
        throw new TypeError(
          "Project agent snapshot frontmatterFields must contain non-empty strings.",
        );
      }
      if (frontmatterFields.has(field)) {
        throw new TypeError(
          `Project agent snapshot contains duplicate frontmatter field '${field}'.`,
        );
      }
      frontmatterFields.add(field);
    }
    if (entryNames.has(entry.agent.name)) {
      throw new TypeError(`Project agent snapshot contains duplicate agent '${entry.agent.name}'.`);
    }
    entryNames.add(entry.agent.name);
  }

  const tombstoneNames = new Set<string>();
  for (const tombstone of input.tombstones ?? []) {
    if (!isNonEmptyString(tombstone)) {
      throw new TypeError("Project agent snapshot tombstones must be non-empty strings.");
    }
    if (tombstoneNames.has(tombstone)) {
      throw new TypeError(`Project agent snapshot contains duplicate tombstone '${tombstone}'.`);
    }
    if (entryNames.has(tombstone)) {
      throw new TypeError(
        `Project agent snapshot cannot contain both an agent and tombstone for '${tombstone}'.`,
      );
    }
    tombstoneNames.add(tombstone);
  }
}

function buildManifest(input: ProjectAgentSnapshotInput): ProjectAgentSnapshotManifest {
  validateRegistrationInput(input);
  const entries = input.entries.map((entry) =>
    Object.freeze({
      agent: cloneAndFreeze(entry.agent),
      digest: entry.digest,
      frontmatterFields: Object.freeze([...entry.frontmatterFields]),
    }),
  );
  const tombstones = [...(input.tombstones ?? [])];
  const provenance = Object.freeze({
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    generationId: input.generationId,
    processInstanceId: PROCESS_INSTANCE_ID,
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    tombstones: Object.freeze(tombstones),
    provenance,
  });
}

/**
 * Register one immutable generation and return an in-process-only capability.
 * The capability itself intentionally contains no metadata or token.
 */
export function registerProjectAgentSnapshot(
  input: ProjectAgentSnapshotInput,
): ProjectAgentSnapshotCapability {
  const manifest = buildManifest(input);
  const capability = Object.freeze({}) as ProjectAgentSnapshotCapability;
  const registered = {
    manifest,
    referenceIds: new Set<string>(),
  } satisfies RegisteredProjectAgentSnapshot;
  REGISTRY.set(capability, registered);
  REGISTERED_CAPABILITIES.add(capability);
  return capability;
}

function registeredSnapshot(capability: unknown): RegisteredProjectAgentSnapshot {
  if (!isRecord(capability)) throw invalidCapability();
  const registered = REGISTRY.get(capability);
  if (!registered) throw invalidCapability();
  return registered;
}

function validExpected(expected: unknown): expected is ProjectAgentSnapshotExpected {
  if (!isRecord(expected)) return false;
  return (
    isNonEmptyString(expected.projectRoot) &&
    isNonEmptyString(expected.sessionId) &&
    isNonEmptyString(expected.generationId) &&
    isNonEmptyString(expected.processInstanceId)
  );
}

/**
 * Resolve a capability only when both its object identity and all provenance
 * fields exactly match. Persisted provenance without this object is not
 * authority and cannot be used to reconstruct a capability.
 */
export function resolveProjectAgentSnapshot(
  capability: unknown,
  expected: unknown,
): ProjectAgentSnapshotManifest {
  const registered = registeredSnapshot(capability);
  if (!validExpected(expected)) throw invalidCapability();
  const provenance = registered.manifest.provenance;
  if (
    provenance.projectRoot !== expected.projectRoot ||
    provenance.sessionId !== expected.sessionId ||
    provenance.generationId !== expected.generationId ||
    provenance.processInstanceId !== expected.processInstanceId ||
    provenance.processInstanceId !== PROCESS_INSTANCE_ID
  ) {
    throw invalidCapability();
  }
  return registered.manifest;
}

/** Return immutable provenance for persistence; it is not execution authority. */
export function getProjectAgentSnapshotProvenance(
  capability: unknown,
): ProjectAgentSnapshotProvenance {
  return registeredSnapshot(capability).manifest.provenance;
}

/**
 * Keep a generation alive for a runtime owner. Runtime owners must release the
 * reference when their active generation is replaced or their session shuts
 * down; run references remain independent of this owner reference.
 */
export function retainProjectAgentSnapshotReference(
  capability: unknown,
  referenceId: string,
): void {
  if (!isRecord(capability)) throw invalidCapability();
  retainGenerationReference(asCapability(capability), referenceId);
}

export function releaseProjectAgentSnapshotReference(referenceId: string): void {
  const capability = findReferenceOwner(referenceId);
  if (!capability) return;
  if (releaseGenerationReference(capability, referenceId)) {
    cleanupUnreferencedProjectAgentSnapshot(capability);
  }
}

/** Retain a generation for a run that may later be resumed or steered. */
export function retainProjectAgentRunReference(
  capability: unknown,
  runId: string,
  captures: readonly ProjectAgentRunCapture[],
): void {
  if (!isRecord(capability)) throw invalidCapability();
  const registeredCapability = asCapability(capability);
  if (!isNonEmptyString(runId)) throw new TypeError("Project agent run id must be non-empty.");
  if (!Array.isArray(captures) || captures.length === 0) {
    throw new TypeError(
      "Project agent run references must include at least one project-agent capture.",
    );
  }
  if (RUN_REFERENCES.has(runId))
    throw new Error(`Project agent run '${runId}' is already retained.`);
  const manifest = resolveProjectAgentSnapshot(
    registeredCapability,
    getProjectAgentSnapshotProvenance(registeredCapability),
  );
  const captureNames = new Set<string>();
  const normalizedCaptures = captures.map((capture) => {
    const normalized = normalizeProjectAgentRunCapture(capture);
    if (!normalized) throw invalidCapability();
    if (captureNames.has(normalized.provenance.agent)) {
      throw invalidCapability();
    }
    captureNames.add(normalized.provenance.agent);
    validateRunCaptureAgainstManifest(manifest, normalized);
    return Object.freeze({
      provenance: Object.freeze({ ...normalized.provenance }),
      config: cloneAndFreeze(normalized.config),
    }) as ProjectAgentRunCapture;
  });
  retainGenerationReference(registeredCapability, referenceIdForRun(runId));
  RUN_REFERENCES.set(runId, {
    capability: registeredCapability,
    captures: Object.freeze(normalizedCaptures),
  });
}

/** A continuation acquires its own reference before the source is released. */
export function retainProjectAgentRunReferenceFrom(
  sourceRunId: string,
  continuationRunId: string,
): void {
  if (!isNonEmptyString(sourceRunId) || !isNonEmptyString(continuationRunId)) {
    throw new TypeError("Project agent run ids must be non-empty.");
  }
  const source = RUN_REFERENCES.get(sourceRunId);
  if (!source) throw invalidCapability();
  if (RUN_REFERENCES.has(continuationRunId)) {
    throw new Error(`Project agent run '${continuationRunId}' is already retained.`);
  }
  retainGenerationReference(source.capability, referenceIdForRun(continuationRunId));
  RUN_REFERENCES.set(continuationRunId, source);
}

export interface ResolvedProjectAgentRunReference {
  readonly capability: ProjectAgentSnapshotCapability;
  readonly manifest: ProjectAgentSnapshotManifest;
  readonly captures: readonly ProjectAgentRunCapture[];
}

/** Resolve only a run reference retained by this process; metadata alone is insufficient. */
export function resolveProjectAgentRunReference(
  runId: string,
  expected: unknown,
): ResolvedProjectAgentRunReference {
  const reference = RUN_REFERENCES.get(runId);
  if (!reference) throw invalidCapability();
  const normalizedExpected = normalizeProjectAgentRunProvenance(expected);
  if (!normalizedExpected) throw invalidCapability();
  const manifest = resolveProjectAgentSnapshot(reference.capability, normalizedExpected);
  const matchingCapture = reference.captures.find(
    (capture) =>
      capture.provenance.agent === normalizedExpected.agent &&
      capture.provenance.digest === normalizedExpected.digest &&
      capture.provenance.source === normalizedExpected.source,
  );
  if (!matchingCapture) throw invalidCapability();
  return { capability: reference.capability, manifest, captures: reference.captures };
}

/** Release a terminal run reference and collect generations no longer in use. */
export function releaseProjectAgentRunReference(runId: string): boolean {
  const reference = RUN_REFERENCES.get(runId);
  if (!reference) return false;
  RUN_REFERENCES.delete(runId);
  releaseGenerationReference(reference.capability, referenceIdForRun(runId));
  cleanupUnreferencedProjectAgentSnapshot(reference.capability);
  return true;
}

/** Resolve a run id or unique prefix against this process-private registry. */
export function lookupProjectAgentRunReference(runId: string): ProjectAgentRunReferenceLookup {
  const requested = runId.trim();
  if (!requested) return { status: "missing" };
  const exact = RUN_REFERENCES.get(requested);
  if (exact) {
    return { status: "found", runId: requested, captures: exact.captures };
  }
  const matches = [...RUN_REFERENCES.entries()].filter(([candidate]) =>
    candidate.startsWith(requested),
  );
  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      runIds: matches.map(([candidate]) => candidate).sort(),
      captures: matches.flatMap(([, reference]) =>
        reference.captures.map((capture) => capture.provenance),
      ),
    };
  }
  const [resolvedRunId, reference] = matches[0]!;
  return { status: "found", runId: resolvedRunId, captures: reference.captures };
}

/** Return safe provenance only for a run retained by this process. */
export function getProjectAgentRunReferenceMetadata(
  runId: string,
): readonly ProjectAgentRunProvenance[] | undefined {
  const lookup = lookupProjectAgentRunReference(runId);
  return lookup.status === "found"
    ? lookup.captures.map((capture) => capture.provenance)
    : undefined;
}

/** Release all references belonging to a prior session transition. */
export function releaseProjectAgentRunReferencesForSession(sessionId: string): number {
  if (!isNonEmptyString(sessionId)) return 0;
  const runIds = [...RUN_REFERENCES.entries()]
    .filter(([, reference]) =>
      reference.captures.some((capture) => capture.provenance.sessionId === sessionId),
    )
    .map(([runId]) => runId);
  for (const runId of runIds) releaseProjectAgentRunReference(runId);
  return runIds.length;
}

/** Explicitly retire unreferenced generations; active/resumable runs are protected. */
export function cleanupProjectAgentSnapshotRegistry(): number {
  return cleanupUnreferencedProjectAgentSnapshots();
}

/** Small diagnostic seam used by focused lifecycle tests. */
export function projectAgentSnapshotRegistryStats(): {
  generations: number;
  retainedRuns: number;
  references: number;
} {
  let references = 0;
  for (const capability of REGISTERED_CAPABILITIES) {
    references += REGISTRY.get(capability)?.referenceIds.size ?? 0;
  }
  return {
    generations: REGISTERED_CAPABILITIES.size,
    retainedRuns: RUN_REFERENCES.size,
    references,
  };
}

/** Explicitly retire a retained generation. Newer registrations do not revoke older ones. */
export function revokeProjectAgentSnapshot(capability: unknown): void {
  if (!isRecord(capability)) throw invalidCapability();
  const registeredCapability = asCapability(capability);
  const registered = REGISTRY.get(registeredCapability);
  if (!registered) throw invalidCapability();
  if (registered.referenceIds.size > 0) throw invalidCapability();
  cleanupUnreferencedProjectAgentSnapshot(registeredCapability);
}

export interface ProjectAgentSnapshotMergeOptions {
  readonly entries?: readonly ProjectAgentSnapshotEntry[];
  readonly tombstones?: readonly string[];
}

function isEmbeddedProfileAgent(agent: AgentConfig): boolean {
  return agent.source === "user" && agent.packageName === "embedded";
}

function authorizeProfileCollision(agent: AgentConfig, name: string): void {
  if (!isEmbeddedProfileAgent(agent)) {
    throw new ProjectAgentSnapshotMergeError(name, agent.source);
  }
}

/** Merge trusted project entries after profile agents, applying tombstones first. */
export function mergeProjectAgentSnapshot(
  profileAgents: readonly AgentConfig[],
  manifest: ProjectAgentSnapshotManifest,
  options: ProjectAgentSnapshotMergeOptions = {},
): AgentConfig[] {
  const agents = new Map<string, AgentConfig>();
  for (const agent of profileAgents) agents.set(agent.name, agent);

  for (const tombstone of options.tombstones ?? manifest.tombstones) {
    const existing = agents.get(tombstone);
    if (!existing) continue;
    authorizeProfileCollision(existing, tombstone);
    agents.delete(tombstone);
  }

  for (const entry of options.entries ?? manifest.entries) {
    const existing = agents.get(entry.agent.name);
    if (existing) authorizeProfileCollision(existing, entry.agent.name);
    agents.set(entry.agent.name, entry.agent);
  }
  return [...agents.values()];
}

export function projectAgentSnapshotDiscoveryMetadata(
  manifest: ProjectAgentSnapshotManifest,
  disabledByUser: readonly string[] = [],
): ProjectAgentSnapshotDiscoveryMetadata {
  const entries = manifest.entries.map(({ agent, digest }) =>
    Object.freeze({ name: agent.name, digest }),
  );
  return Object.freeze({
    provenance: manifest.provenance,
    entries: Object.freeze(entries),
    tombstones: Object.freeze([...manifest.tombstones]),
    disabledByUser: Object.freeze([...disabledByUser]),
  });
}

// The native bridge consumes callbacks installed on the process global rather
// than importing this module dynamically. Re-evaluated Jiti/native copies
// still point at the same registry state above, while the native lazy graph
// remains free of eager subagent modules.
OPERATIONS_GLOBAL[OPERATIONS_GLOBAL_KEY] = Object.freeze({
  retainSnapshotReference: retainProjectAgentSnapshotReference,
  releaseSnapshotReference: releaseProjectAgentSnapshotReference,
  releaseRunReferencesForSession: releaseProjectAgentRunReferencesForSession,
  getRunReferenceMetadata: getProjectAgentRunReferenceMetadata,
  lookupRunReference: lookupProjectAgentRunReference,
});
