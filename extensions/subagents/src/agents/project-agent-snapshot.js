import { randomUUID } from "node:crypto";
export const PROJECT_AGENT_TERMINAL_RETENTION_MS = 10 * 60 * 1000;
export class ProjectAgentSnapshotCapabilityError extends Error {
    code = "INVALID_PROJECT_AGENT_SNAPSHOT_CAPABILITY";
    constructor() {
        super("Project agent snapshot capability is invalid or does not match the expected identity.");
        this.name = "ProjectAgentSnapshotCapabilityError";
    }
}
export class ProjectAgentSnapshotMergeError extends Error {
    code = "PROJECT_AGENT_SNAPSHOT_CONFLICT";
    constructor(name, source) {
        super(`Project agent snapshot cannot replace or remove '${name}' from non-embedded ${source} discovery.`);
        this.name = "ProjectAgentSnapshotMergeError";
    }
}
const GLOBAL_REGISTRY_KEY = Symbol.for("the-last-harness.project-agent-snapshot-registry");
const GLOBAL_STATE = globalThis;
const REGISTRY_STATE = GLOBAL_STATE[GLOBAL_REGISTRY_KEY] ??
    (GLOBAL_STATE[GLOBAL_REGISTRY_KEY] = {
        processInstanceId: randomUUID(),
        registry: new WeakMap(),
        registeredCapabilities: new Set(),
        runReferences: new Map(),
        referenceOwners: new Map(),
    });
const PROCESS_INSTANCE_ID = REGISTRY_STATE.processInstanceId;
const REFERENCE_OWNERS = REGISTRY_STATE.referenceOwners ??
    (REGISTRY_STATE.referenceOwners = new Map());
const REGISTRY = REGISTRY_STATE.registry;
const REGISTERED_CAPABILITIES = REGISTRY_STATE.registeredCapabilities;
const RUN_REFERENCES = REGISTRY_STATE.runReferences;
const OPERATIONS_GLOBAL_KEY = Symbol.for("the-last-harness.project-agent-snapshot-operations");
const OPERATIONS_GLOBAL = globalThis;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function invalidCapability() {
    return new ProjectAgentSnapshotCapabilityError();
}
function asCapability(value) {
    return value;
}
function cloneAndFreeze(value, ancestors = new Set()) {
    const raw = value;
    if (raw === null ||
        typeof raw === "string" ||
        typeof raw === "number" ||
        typeof raw === "boolean" ||
        raw === undefined) {
        return value;
    }
    if (typeof raw !== "object") {
        throw new TypeError("Project agent snapshot values must contain only JSON-compatible values.");
    }
    if (ancestors.has(raw)) {
        throw new TypeError("Project agent snapshot values cannot contain cycles.");
    }
    ancestors.add(raw);
    let clone;
    if (Array.isArray(raw)) {
        clone = raw.map((item) => cloneAndFreeze(item, ancestors));
    }
    else {
        const prototype = Object.getPrototypeOf(raw);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("Project agent snapshot values must be plain objects.");
        }
        const record = {};
        const source = raw;
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
    return Object.freeze(clone);
}
function isPlainObject(value) {
    if (!isRecord(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isJsonCompatible(value, ancestors = new Set()) {
    if (value === null ||
        value === undefined ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
        return true;
    if (typeof value !== "object")
        return false;
    if (ancestors.has(value))
        return false;
    ancestors.add(value);
    const valid = Array.isArray(value)
        ? value.every((item) => isJsonCompatible(item, ancestors))
        : isPlainObject(value) &&
            Object.values(value).every((item) => isJsonCompatible(item, ancestors));
    ancestors.delete(value);
    return valid;
}
function validCapturedAgentConfig(value) {
    if (!isPlainObject(value))
        return false;
    if (!isNonEmptyString(value.name) ||
        !isNonEmptyString(value.description) ||
        !isNonEmptyString(value.filePath) ||
        typeof value.systemPrompt !== "string" ||
        (value.systemPromptMode !== "append" && value.systemPromptMode !== "replace") ||
        typeof value.inheritProjectContext !== "boolean" ||
        typeof value.inheritSkills !== "boolean" ||
        value.source !== "project")
        return false;
    if (!isJsonCompatible(value))
        return false;
    const stringArrays = [
        value.tools,
        value.fallbackModels,
        value.skills,
        value.extensions,
        value.subagentOnlyExtensions,
        value.defaultReads,
    ];
    if (stringArrays.some((items) => items !== undefined && (!Array.isArray(items) || !items.every(isNonEmptyString))))
        return false;
    if (value.model !== undefined && typeof value.model !== "string")
        return false;
    if (value.thinking !== undefined &&
        value.thinking !== false &&
        typeof value.thinking !== "string")
        return false;
    if (value.acceptanceRole !== undefined &&
        value.acceptanceRole !== "read-only" &&
        value.acceptanceRole !== "writer")
        return false;
    for (const field of [
        "defaultProgress",
        "interactive",
        "completionGuard",
        "supervisorBridge",
        "disabled",
    ]) {
        if (value[field] !== undefined && typeof value[field] !== "boolean")
            return false;
    }
    for (const field of ["maxSubagentDepth", "maxExecutionTimeMs"]) {
        if (value[field] !== undefined &&
            (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]) || value[field] < 0))
            return false;
    }
    return true;
}
function validRunProvenance(value) {
    if (!isRecord(value))
        return false;
    return (value.source === "project" &&
        isNonEmptyString(value.projectRoot) &&
        isNonEmptyString(value.sessionId) &&
        isNonEmptyString(value.generationId) &&
        isNonEmptyString(value.processInstanceId) &&
        isNonEmptyString(value.agent) &&
        isNonEmptyString(value.digest));
}
export function normalizeProjectAgentRunProvenance(value) {
    if (!validRunProvenance(value))
        return undefined;
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
export function normalizeProjectAgentRunCapture(value) {
    if (!isRecord(value) ||
        !validRunProvenance(value.provenance) ||
        !validCapturedAgentConfig(value.config)) {
        return undefined;
    }
    if (value.config.name !== value.provenance.agent ||
        value.config.source !== value.provenance.source ||
        !isJsonCompatible(value)) {
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
function stableSerialize(value) {
    if (Array.isArray(value))
        return `[${value.map(stableSerialize).join(",")}]`;
    if (isPlainObject(value)) {
        return `{${Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
export function projectAgentRunCaptureEquals(left, right) {
    const normalizedLeft = normalizeProjectAgentRunCapture(left);
    const normalizedRight = normalizeProjectAgentRunCapture(right);
    return Boolean(normalizedLeft &&
        normalizedRight &&
        stableSerialize(normalizedLeft) === stableSerialize(normalizedRight));
}
function projectAgentRunCaptureForEntry(manifest, agent) {
    const entry = manifest.entries.find((candidate) => candidate.agent.name === agent.name);
    if (!entry || agent.source !== "project")
        throw invalidCapability();
    const capture = {
        provenance: {
            ...manifest.provenance,
            source: "project",
            agent: agent.name,
            digest: entry.digest,
        },
        config: cloneAndFreeze(agent),
    };
    return Object.freeze(capture);
}
export function createProjectAgentRunCapture(manifest, agent) {
    return projectAgentRunCaptureForEntry(manifest, agent);
}
function validateRunCaptureAgainstManifest(manifest, capture) {
    const entry = manifest.entries.find((candidate) => candidate.agent.name === capture.provenance.agent);
    if (!entry ||
        capture.provenance.source !== "project" ||
        capture.provenance.projectRoot !== manifest.provenance.projectRoot ||
        capture.provenance.sessionId !== manifest.provenance.sessionId ||
        capture.provenance.generationId !== manifest.provenance.generationId ||
        capture.provenance.processInstanceId !== manifest.provenance.processInstanceId ||
        capture.provenance.digest !== entry.digest ||
        capture.config.name !== entry.agent.name ||
        capture.config.source !== "project" ||
        capture.config.filePath !== entry.agent.filePath) {
        throw invalidCapability();
    }
}
function referenceIdForRun(runId) {
    return `run:${runId}`;
}
function findReferenceOwner(referenceId) {
    const indexedOwner = REFERENCE_OWNERS.get(referenceId);
    if (indexedOwner) {
        const indexedSnapshot = REGISTRY.get(indexedOwner);
        if (indexedSnapshot?.referenceIds.has(referenceId))
            return indexedOwner;
        REFERENCE_OWNERS.delete(referenceId);
    }
    for (const capability of REGISTERED_CAPABILITIES) {
        const registered = REGISTRY.get(capability);
        if (registered?.referenceIds.has(referenceId)) {
            REFERENCE_OWNERS.set(referenceId, capability);
            return capability;
        }
    }
    return undefined;
}
function retainGenerationReference(capability, referenceId) {
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
function releaseGenerationReference(capability, referenceId) {
    const registered = REGISTRY.get(capability);
    if (!registered)
        return false;
    const released = registered.referenceIds.delete(referenceId);
    if (released && REFERENCE_OWNERS.get(referenceId) === capability) {
        REFERENCE_OWNERS.delete(referenceId);
    }
    return released;
}
function cleanupUnreferencedProjectAgentSnapshot(capability) {
    const registered = REGISTRY.get(capability);
    if (!registered || registered.referenceIds.size > 0)
        return false;
    REGISTRY.delete(capability);
    REGISTERED_CAPABILITIES.delete(capability);
    for (const [referenceId, owner] of REFERENCE_OWNERS) {
        if (owner === capability)
            REFERENCE_OWNERS.delete(referenceId);
    }
    return true;
}
function cleanupUnreferencedProjectAgentSnapshots() {
    let removed = 0;
    for (const capability of REGISTERED_CAPABILITIES) {
        if (cleanupUnreferencedProjectAgentSnapshot(capability))
            removed++;
    }
    return removed;
}
function validateRegistrationInput(input) {
    if (!isRecord(input))
        throw new TypeError("Project agent snapshot input must be an object.");
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
    const entryNames = new Set();
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
            throw new TypeError("Project agent snapshot agent systemPromptMode must be 'append' or 'replace'.");
        }
        if (typeof entry.agent.inheritProjectContext !== "boolean") {
            throw new TypeError("Project agent snapshot agent inheritProjectContext must be a boolean.");
        }
        if (typeof entry.agent.inheritSkills !== "boolean") {
            throw new TypeError("Project agent snapshot agent inheritSkills must be a boolean.");
        }
        if (entry.agent.supervisorBridge !== undefined &&
            typeof entry.agent.supervisorBridge !== "boolean") {
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
        const frontmatterFields = new Set();
        for (const field of entry.frontmatterFields) {
            if (!isNonEmptyString(field)) {
                throw new TypeError("Project agent snapshot frontmatterFields must contain non-empty strings.");
            }
            if (frontmatterFields.has(field)) {
                throw new TypeError(`Project agent snapshot contains duplicate frontmatter field '${field}'.`);
            }
            frontmatterFields.add(field);
        }
        if (entryNames.has(entry.agent.name)) {
            throw new TypeError(`Project agent snapshot contains duplicate agent '${entry.agent.name}'.`);
        }
        entryNames.add(entry.agent.name);
    }
    const tombstoneNames = new Set();
    for (const tombstone of input.tombstones ?? []) {
        if (!isNonEmptyString(tombstone)) {
            throw new TypeError("Project agent snapshot tombstones must be non-empty strings.");
        }
        if (tombstoneNames.has(tombstone)) {
            throw new TypeError(`Project agent snapshot contains duplicate tombstone '${tombstone}'.`);
        }
        if (entryNames.has(tombstone)) {
            throw new TypeError(`Project agent snapshot cannot contain both an agent and tombstone for '${tombstone}'.`);
        }
        tombstoneNames.add(tombstone);
    }
}
function buildManifest(input) {
    validateRegistrationInput(input);
    const entries = input.entries.map((entry) => Object.freeze({
        agent: cloneAndFreeze(entry.agent),
        digest: entry.digest,
        frontmatterFields: Object.freeze([...entry.frontmatterFields]),
    }));
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
export function registerProjectAgentSnapshot(input) {
    const manifest = buildManifest(input);
    const capability = Object.freeze({});
    const registered = {
        manifest,
        referenceIds: new Set(),
    };
    REGISTRY.set(capability, registered);
    REGISTERED_CAPABILITIES.add(capability);
    return capability;
}
function registeredSnapshot(capability) {
    if (!isRecord(capability))
        throw invalidCapability();
    const registered = REGISTRY.get(capability);
    if (!registered)
        throw invalidCapability();
    return registered;
}
function validExpected(expected) {
    if (!isRecord(expected))
        return false;
    return (isNonEmptyString(expected.projectRoot) &&
        isNonEmptyString(expected.sessionId) &&
        isNonEmptyString(expected.generationId) &&
        isNonEmptyString(expected.processInstanceId));
}
export function resolveProjectAgentSnapshot(capability, expected) {
    const registered = registeredSnapshot(capability);
    if (!validExpected(expected))
        throw invalidCapability();
    const provenance = registered.manifest.provenance;
    if (provenance.projectRoot !== expected.projectRoot ||
        provenance.sessionId !== expected.sessionId ||
        provenance.generationId !== expected.generationId ||
        provenance.processInstanceId !== expected.processInstanceId ||
        provenance.processInstanceId !== PROCESS_INSTANCE_ID) {
        throw invalidCapability();
    }
    return registered.manifest;
}
export function getProjectAgentSnapshotProvenance(capability) {
    return registeredSnapshot(capability).manifest.provenance;
}
export function retainProjectAgentSnapshotReference(capability, referenceId) {
    if (!isRecord(capability))
        throw invalidCapability();
    retainGenerationReference(asCapability(capability), referenceId);
}
export function releaseProjectAgentSnapshotReference(referenceId) {
    const capability = findReferenceOwner(referenceId);
    if (!capability)
        return;
    if (releaseGenerationReference(capability, referenceId)) {
        cleanupUnreferencedProjectAgentSnapshot(capability);
    }
}
export function retainProjectAgentRunReference(capability, runId, captures) {
    if (!isRecord(capability))
        throw invalidCapability();
    const registeredCapability = asCapability(capability);
    if (!isNonEmptyString(runId))
        throw new TypeError("Project agent run id must be non-empty.");
    if (!Array.isArray(captures) || captures.length === 0) {
        throw new TypeError("Project agent run references must include at least one project-agent capture.");
    }
    if (RUN_REFERENCES.has(runId))
        throw new Error(`Project agent run '${runId}' is already retained.`);
    const manifest = resolveProjectAgentSnapshot(registeredCapability, getProjectAgentSnapshotProvenance(registeredCapability));
    const captureNames = new Set();
    const normalizedCaptures = captures.map((capture) => {
        const normalized = normalizeProjectAgentRunCapture(capture);
        if (!normalized)
            throw invalidCapability();
        if (captureNames.has(normalized.provenance.agent)) {
            throw invalidCapability();
        }
        captureNames.add(normalized.provenance.agent);
        validateRunCaptureAgainstManifest(manifest, normalized);
        return Object.freeze({
            provenance: Object.freeze({ ...normalized.provenance }),
            config: cloneAndFreeze(normalized.config),
        });
    });
    retainGenerationReference(registeredCapability, referenceIdForRun(runId));
    RUN_REFERENCES.set(runId, {
        capability: registeredCapability,
        captures: Object.freeze(normalizedCaptures),
    });
}
export function retainProjectAgentRunReferenceFrom(sourceRunId, continuationRunId) {
    if (!isNonEmptyString(sourceRunId) || !isNonEmptyString(continuationRunId)) {
        throw new TypeError("Project agent run ids must be non-empty.");
    }
    const source = RUN_REFERENCES.get(sourceRunId);
    if (!source)
        throw invalidCapability();
    if (RUN_REFERENCES.has(continuationRunId)) {
        throw new Error(`Project agent run '${continuationRunId}' is already retained.`);
    }
    retainGenerationReference(source.capability, referenceIdForRun(continuationRunId));
    RUN_REFERENCES.set(continuationRunId, source);
}
export function resolveProjectAgentRunReference(runId, expected) {
    const reference = RUN_REFERENCES.get(runId);
    if (!reference)
        throw invalidCapability();
    const normalizedExpected = normalizeProjectAgentRunProvenance(expected);
    if (!normalizedExpected)
        throw invalidCapability();
    const manifest = resolveProjectAgentSnapshot(reference.capability, normalizedExpected);
    const matchingCapture = reference.captures.find((capture) => capture.provenance.agent === normalizedExpected.agent &&
        capture.provenance.digest === normalizedExpected.digest &&
        capture.provenance.source === normalizedExpected.source);
    if (!matchingCapture)
        throw invalidCapability();
    return { capability: reference.capability, manifest, captures: reference.captures };
}
export function releaseProjectAgentRunReference(runId) {
    const reference = RUN_REFERENCES.get(runId);
    if (!reference)
        return false;
    RUN_REFERENCES.delete(runId);
    releaseGenerationReference(reference.capability, referenceIdForRun(runId));
    cleanupUnreferencedProjectAgentSnapshot(reference.capability);
    return true;
}
export function lookupProjectAgentRunReference(runId) {
    const requested = runId.trim();
    if (!requested)
        return { status: "missing" };
    const exact = RUN_REFERENCES.get(requested);
    if (exact) {
        return { status: "found", runId: requested, captures: exact.captures };
    }
    const matches = [...RUN_REFERENCES.entries()].filter(([candidate]) => candidate.startsWith(requested));
    if (matches.length === 0)
        return { status: "missing" };
    if (matches.length > 1) {
        return {
            status: "ambiguous",
            runIds: matches.map(([candidate]) => candidate).sort(),
            captures: matches.flatMap(([, reference]) => reference.captures.map((capture) => capture.provenance)),
        };
    }
    const [resolvedRunId, reference] = matches[0];
    return { status: "found", runId: resolvedRunId, captures: reference.captures };
}
export function getProjectAgentRunReferenceMetadata(runId) {
    const lookup = lookupProjectAgentRunReference(runId);
    return lookup.status === "found"
        ? lookup.captures.map((capture) => capture.provenance)
        : undefined;
}
export function releaseProjectAgentRunReferencesForSession(sessionId) {
    if (!isNonEmptyString(sessionId))
        return 0;
    const runIds = [...RUN_REFERENCES.entries()]
        .filter(([, reference]) => reference.captures.some((capture) => capture.provenance.sessionId === sessionId))
        .map(([runId]) => runId);
    for (const runId of runIds)
        releaseProjectAgentRunReference(runId);
    return runIds.length;
}
export function cleanupProjectAgentSnapshotRegistry() {
    return cleanupUnreferencedProjectAgentSnapshots();
}
export function projectAgentSnapshotRegistryStats() {
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
export function revokeProjectAgentSnapshot(capability) {
    if (!isRecord(capability))
        throw invalidCapability();
    const registeredCapability = asCapability(capability);
    const registered = REGISTRY.get(registeredCapability);
    if (!registered)
        throw invalidCapability();
    if (registered.referenceIds.size > 0)
        throw invalidCapability();
    cleanupUnreferencedProjectAgentSnapshot(registeredCapability);
}
function isEmbeddedProfileAgent(agent) {
    return agent.source === "user" && agent.packageName === "embedded";
}
function authorizeProfileCollision(agent, name) {
    if (!isEmbeddedProfileAgent(agent)) {
        throw new ProjectAgentSnapshotMergeError(name, agent.source);
    }
}
export function mergeProjectAgentSnapshot(profileAgents, manifest, options = {}) {
    const agents = new Map();
    for (const agent of profileAgents)
        agents.set(agent.name, agent);
    for (const tombstone of options.tombstones ?? manifest.tombstones) {
        const existing = agents.get(tombstone);
        if (!existing)
            continue;
        authorizeProfileCollision(existing, tombstone);
        agents.delete(tombstone);
    }
    for (const entry of options.entries ?? manifest.entries) {
        const existing = agents.get(entry.agent.name);
        if (existing)
            authorizeProfileCollision(existing, entry.agent.name);
        agents.set(entry.agent.name, entry.agent);
    }
    return [...agents.values()];
}
export function projectAgentSnapshotDiscoveryMetadata(manifest, disabledByUser = []) {
    const entries = manifest.entries.map(({ agent, digest }) => Object.freeze({ name: agent.name, digest }));
    return Object.freeze({
        provenance: manifest.provenance,
        entries: Object.freeze(entries),
        tombstones: Object.freeze([...manifest.tombstones]),
        disabledByUser: Object.freeze([...disabledByUser]),
    });
}
OPERATIONS_GLOBAL[OPERATIONS_GLOBAL_KEY] = Object.freeze({
    retainSnapshotReference: retainProjectAgentSnapshotReference,
    releaseSnapshotReference: releaseProjectAgentSnapshotReference,
    releaseRunReferencesForSession: releaseProjectAgentRunReferencesForSession,
    getRunReferenceMetadata: getProjectAgentRunReferenceMetadata,
    lookupRunReference: lookupProjectAgentRunReference,
});
