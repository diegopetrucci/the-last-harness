import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR, } from "../../shared/types.js";
import { isSafeNestedPathId, parseNestedPathEnv, sanitizeNestedPath } from "./nested-path.js";
import { SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV, SUBAGENT_PARENT_CHILD_INDEX_ENV, SUBAGENT_PARENT_CONTROL_INBOX_ENV, SUBAGENT_PARENT_DEPTH_ENV, SUBAGENT_PARENT_EVENT_SINK_ENV, SUBAGENT_PARENT_PATH_ENV, SUBAGENT_PARENT_ROOT_RUN_ID_ENV, SUBAGENT_PARENT_RUN_ID_ENV, } from "./pi-args.js";
import { writeAtomicJson } from "../../shared/atomic-json.js";
export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
const ROUTE_FILE = "route.json";
const REGISTRY_FILE = "registry.json";
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STEPS = 12;
const MAX_CHILDREN = 16;
const MAX_DEPTH = 3;
export const NESTED_RUNNER_ACCEPTANCE_TIMEOUT_MS = 500;
export const NESTED_CONTROL_DELIVERY_TIMEOUT_MS = 700;
export const NESTED_CONTROL_RESULT_TIMEOUT_MS = 1_000;
export function isSafeNestedId(value) {
    return isSafeNestedPathId(value);
}
export function assertSafeNestedId(label, value) {
    if (!isSafeNestedId(value))
        throw new Error(`${label} must be a non-empty safe id token.`);
}
function assertSafeId(label, value) {
    assertSafeNestedId(label, value);
}
function containedPath(base, candidate) {
    const resolvedBase = path.resolve(base);
    const resolvedCandidate = path.resolve(candidate);
    return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}
function commonRouteRoot(route) {
    return path.dirname(path.resolve(route.eventSink));
}
function validateRouteShape(route) {
    assertSafeId("rootRunId", route.rootRunId);
    assertSafeId("capabilityToken", route.capabilityToken);
    if (!containedPath(NESTED_EVENTS_DIR, route.eventSink))
        throw new Error("Nested event sink is outside the subagent nested event root.");
    if (!containedPath(NESTED_EVENTS_DIR, route.controlInbox))
        throw new Error("Nested control inbox is outside the subagent nested event root.");
    if (commonRouteRoot(route) !== path.dirname(path.resolve(route.controlInbox)))
        throw new Error("Nested event sink and control inbox must share one route root.");
}
export function createNestedRoute(rootRunId) {
    assertSafeId("rootRunId", rootRunId);
    const capabilityToken = randomUUID();
    const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-${capabilityToken}`);
    const eventSink = path.join(routeRoot, "events");
    const controlInbox = path.join(routeRoot, "controls");
    fs.mkdirSync(eventSink, { recursive: true, mode: 0o700 });
    fs.mkdirSync(controlInbox, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(routeRoot, ROUTE_FILE), `${JSON.stringify({ rootRunId, capabilityToken, createdAt: Date.now() })}\n`, { mode: 0o600 });
    return { rootRunId, eventSink, controlInbox, capabilityToken };
}
export function resolveNestedRouteFromEnv(env = process.env) {
    const rootRunId = env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
    const eventSink = env[SUBAGENT_PARENT_EVENT_SINK_ENV];
    const controlInbox = env[SUBAGENT_PARENT_CONTROL_INBOX_ENV];
    const capabilityToken = env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV];
    if (!rootRunId || !eventSink || !controlInbox || !capabilityToken)
        return undefined;
    const route = { rootRunId, eventSink, controlInbox, capabilityToken };
    validateRouteShape(route);
    const routeFile = path.join(commonRouteRoot(route), ROUTE_FILE);
    const metadata = JSON.parse(fs.readFileSync(routeFile, "utf-8"));
    if (metadata.rootRunId !== rootRunId || metadata.capabilityToken !== capabilityToken) {
        throw new Error("Nested event route metadata does not match the provided root id and capability token.");
    }
    return route;
}
export function resolveInheritedNestedRouteFromEnv(env = process.env) {
    try {
        return resolveNestedRouteFromEnv(env);
    }
    catch (error) {
        console.error("Ignoring invalid nested subagent event route:", error);
        return undefined;
    }
}
export function resolveNestedParentAddressFromEnv(env = process.env) {
    const parentRunId = env[SUBAGENT_PARENT_RUN_ID_ENV];
    if (!isSafeNestedId(parentRunId))
        return undefined;
    const rawIndex = env[SUBAGENT_PARENT_CHILD_INDEX_ENV];
    const parentStepIndex = rawIndex && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
    const depth = Math.min(Math.max(1, clampNumber(Number(env[SUBAGENT_PARENT_DEPTH_ENV])) ?? 1), MAX_DEPTH);
    const parsedPath = parseNestedPathEnv(env[SUBAGENT_PARENT_PATH_ENV]);
    const nestedPath = parsedPath.length
        ? parsedPath
        : [{ runId: parentRunId, ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}) }];
    return { parentRunId, ...(parentStepIndex !== undefined ? { parentStepIndex } : {}), depth, path: nestedPath };
}
export function resolveNestedAsyncDir(rootRunId, run) {
    if (!run.asyncDir)
        return undefined;
    const resolved = path.resolve(run.asyncDir);
    const nestedRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, run.id);
    const relative = path.relative(nestedRoot, resolved);
    return resolved === nestedRoot || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved : undefined;
}
function clampNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function stringValue(value, max = 512) {
    return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}
function sanitizeTokenUsage(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    const input = clampNumber(raw.input);
    const output = clampNumber(raw.output);
    const total = clampNumber(raw.total);
    return input !== undefined && output !== undefined && total !== undefined ? { input, output, total } : undefined;
}
function sanitizeCost(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    const inputTokens = clampNumber(raw.inputTokens);
    const outputTokens = clampNumber(raw.outputTokens);
    const costUsd = clampNumber(raw.costUsd);
    return inputTokens !== undefined && outputTokens !== undefined && costUsd !== undefined
        ? { inputTokens, outputTokens, costUsd }
        : undefined;
}
function sanitizeTurnBudget(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    const maxTurns = clampNumber(raw.maxTurns);
    const graceTurns = clampNumber(raw.graceTurns);
    const turnCount = clampNumber(raw.turnCount);
    const outcome = raw.outcome === "within-budget" || raw.outcome === "wrap-up-requested" || raw.outcome === "exceeded"
        ? raw.outcome
        : undefined;
    if (maxTurns === undefined || graceTurns === undefined || turnCount === undefined || !outcome)
        return undefined;
    return {
        maxTurns,
        graceTurns,
        turnCount,
        outcome,
        ...(clampNumber(raw.wrapUpRequestedAtTurn) !== undefined
            ? { wrapUpRequestedAtTurn: clampNumber(raw.wrapUpRequestedAtTurn) }
            : {}),
        ...(clampNumber(raw.exceededAtTurn) !== undefined ? { exceededAtTurn: clampNumber(raw.exceededAtTurn) } : {}),
    };
}
function sanitizeState(value, fallback) {
    return value === "queued" || value === "running" || value === "complete" || value === "failed" || value === "paused"
        ? value
        : fallback;
}
function sanitizeStep(input, depth) {
    if (!input || typeof input !== "object")
        return undefined;
    const raw = input;
    const agent = stringValue(raw.agent, 128);
    if (!agent)
        return undefined;
    const status = raw.status === "pending" ||
        raw.status === "running" ||
        raw.status === "complete" ||
        raw.status === "completed" ||
        raw.status === "failed" ||
        raw.status === "paused"
        ? raw.status
        : "pending";
    return {
        agent,
        status,
        ...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
        ...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention"
            ? { activityState: raw.activityState }
            : {}),
        ...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
        ...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
        ...(clampNumber(raw.currentToolStartedAt) !== undefined
            ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) }
            : {}),
        ...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
        ...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
        ...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
        ...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
        ...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
        ...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
        ...(raw.timedOut === true ? { timedOut: true } : {}),
        ...(sanitizeTurnBudget(raw.turnBudget) ? { turnBudget: sanitizeTurnBudget(raw.turnBudget) } : {}),
        ...(raw.turnBudgetExceeded === true ? { turnBudgetExceeded: true } : {}),
        ...(raw.wrapUpRequested === true ? { wrapUpRequested: true } : {}),
        ...(depth < MAX_DEPTH && Array.isArray(raw.children)
            ? {
                children: raw.children
                    .map((child) => sanitizeSummary(child, depth + 1))
                    .filter((child) => Boolean(child))
                    .slice(0, MAX_CHILDREN),
            }
            : {}),
    };
}
export function sanitizeSummary(input, depth = 0) {
    if (!input || typeof input !== "object")
        return undefined;
    const raw = input;
    if (!isSafeNestedId(raw.id) || !isSafeNestedId(raw.parentRunId))
        return undefined;
    const pathParts = sanitizeNestedPath(raw.path);
    const steps = Array.isArray(raw.steps)
        ? raw.steps
            .map((step) => sanitizeStep(step, depth + 1))
            .filter((step) => Boolean(step))
            .slice(0, MAX_STEPS)
        : undefined;
    const totalTokens = sanitizeTokenUsage(raw.totalTokens);
    const totalCost = sanitizeCost(raw.totalCost);
    return {
        id: raw.id,
        parentRunId: raw.parentRunId,
        ...(clampNumber(raw.parentStepIndex) !== undefined ? { parentStepIndex: clampNumber(raw.parentStepIndex) } : {}),
        ...(stringValue(raw.parentAgent, 128) ? { parentAgent: stringValue(raw.parentAgent, 128) } : {}),
        depth: Math.min(Math.max(0, clampNumber(raw.depth) ?? 0), MAX_DEPTH),
        path: pathParts,
        state: sanitizeState(raw.state, "running"),
        ...(stringValue(raw.asyncDir, 2048) ? { asyncDir: stringValue(raw.asyncDir, 2048) } : {}),
        ...(clampNumber(raw.pid) !== undefined && clampNumber(raw.pid) > 0 && Number.isInteger(clampNumber(raw.pid))
            ? { pid: clampNumber(raw.pid) }
            : {}),
        ...(stringValue(raw.sessionId, 256) ? { sessionId: stringValue(raw.sessionId, 256) } : {}),
        ...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
        ...(stringValue(raw.intercomTarget, 256) ? { intercomTarget: stringValue(raw.intercomTarget, 256) } : {}),
        ...(stringValue(raw.ownerIntercomTarget, 256)
            ? { ownerIntercomTarget: stringValue(raw.ownerIntercomTarget, 256) }
            : {}),
        ...(stringValue(raw.leafIntercomTarget, 256)
            ? { leafIntercomTarget: stringValue(raw.leafIntercomTarget, 256) }
            : {}),
        ...(raw.ownerState === "live" || raw.ownerState === "gone" || raw.ownerState === "unknown"
            ? { ownerState: raw.ownerState }
            : {}),
        ...(stringValue(raw.controlInbox, 2048) ? { controlInbox: stringValue(raw.controlInbox, 2048) } : {}),
        ...(stringValue(raw.capabilityToken, 128) ? { capabilityToken: stringValue(raw.capabilityToken, 128) } : {}),
        ...(raw.mode === "single" || raw.mode === "parallel" || raw.mode === "chain" ? { mode: raw.mode } : {}),
        ...(stringValue(raw.agent, 128) ? { agent: stringValue(raw.agent, 128) } : {}),
        ...(Array.isArray(raw.agents)
            ? {
                agents: raw.agents
                    .map((agent) => stringValue(agent, 128))
                    .filter((agent) => Boolean(agent))
                    .slice(0, MAX_STEPS),
            }
            : {}),
        ...(clampNumber(raw.currentStep) !== undefined ? { currentStep: clampNumber(raw.currentStep) } : {}),
        ...(clampNumber(raw.chainStepCount) !== undefined ? { chainStepCount: clampNumber(raw.chainStepCount) } : {}),
        ...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention"
            ? { activityState: raw.activityState }
            : {}),
        ...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
        ...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
        ...(clampNumber(raw.currentToolStartedAt) !== undefined
            ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) }
            : {}),
        ...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
        ...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
        ...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
        ...(totalTokens ? { totalTokens } : {}),
        ...(totalCost ? { totalCost } : {}),
        ...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
        ...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
        ...(clampNumber(raw.lastUpdate) !== undefined ? { lastUpdate: clampNumber(raw.lastUpdate) } : {}),
        ...(clampNumber(raw.timeoutMs) !== undefined ? { timeoutMs: clampNumber(raw.timeoutMs) } : {}),
        ...(clampNumber(raw.deadlineAt) !== undefined ? { deadlineAt: clampNumber(raw.deadlineAt) } : {}),
        ...(raw.timedOut === true ? { timedOut: true } : {}),
        ...(sanitizeTurnBudget(raw.turnBudget) ? { turnBudget: sanitizeTurnBudget(raw.turnBudget) } : {}),
        ...(raw.turnBudgetExceeded === true ? { turnBudgetExceeded: true } : {}),
        ...(raw.wrapUpRequested === true ? { wrapUpRequested: true } : {}),
        ...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
        ...(steps && steps.length > 0 ? { steps } : {}),
        ...(depth < MAX_DEPTH && Array.isArray(raw.children)
            ? {
                children: raw.children
                    .map((child) => sanitizeSummary(child, depth + 1))
                    .filter((child) => Boolean(child))
                    .slice(0, MAX_CHILDREN),
            }
            : {}),
    };
}
function parseRecord(content, route) {
    if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object")
        return undefined;
    const raw = parsed;
    if (raw.type !== "subagent.nested.started" &&
        raw.type !== "subagent.nested.updated" &&
        raw.type !== "subagent.nested.completed")
        return undefined;
    if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken)
        return undefined;
    if (!isSafeNestedId(raw.parentRunId))
        return undefined;
    const ts = clampNumber(raw.ts);
    if (ts === undefined)
        return undefined;
    const child = sanitizeSummary(raw.child);
    if (!child || child.id === route.rootRunId)
        return undefined;
    const routedChild = {
        ...child,
        controlInbox: route.controlInbox,
        capabilityToken: route.capabilityToken,
        ownerState: child.ownerState ?? "unknown",
    };
    return {
        type: raw.type,
        ts,
        rootRunId: route.rootRunId,
        parentRunId: raw.parentRunId,
        ...(clampNumber(raw.parentStepIndex) !== undefined ? { parentStepIndex: clampNumber(raw.parentStepIndex) } : {}),
        capabilityToken: route.capabilityToken,
        child: routedChild,
    };
}
export function parseNestedEventRecords(content, route) {
    if (!content.includes("\n")) {
        const record = parseRecord(content.trim(), route);
        return record ? [record] : [];
    }
    return content
        .split("\n")
        .slice(0, content.endsWith("\n") ? undefined : -1)
        .map((line) => (line.trim() ? parseRecord(line, route) : undefined))
        .filter((event) => Boolean(event));
}
function terminal(state) {
    return state === "complete" || state === "failed" || state === "paused";
}
function nestedStateFromAsyncState(state) {
    switch (state) {
        case "queued":
            return "queued";
        case "running":
        case "pausing":
            return "running";
        case "complete":
        case "continued":
            return "complete";
        case "failed":
        case "cancelled":
            return "failed";
        case "paused":
            return "paused";
    }
}
function nestedStepStatusFromAsyncStepStatus(status) {
    switch (status) {
        case "pending":
            return "pending";
        case "running":
        case "pausing":
            return "running";
        case "complete":
        case "continued":
            return "complete";
        case "completed":
            return "completed";
        case "failed":
        case "cancelled":
            return "failed";
        case "paused":
            return "paused";
    }
}
function mergeSummary(existing, event) {
    const incomingState = event.type === "subagent.nested.completed" && event.child.state === "running" ? "complete" : event.child.state;
    const incoming = { ...event.child, state: incomingState, lastUpdate: event.child.lastUpdate ?? event.ts };
    if (!existing)
        return incoming;
    const existingUpdate = existing.lastUpdate ?? 0;
    const incomingUpdate = incoming.lastUpdate ?? event.ts;
    if (incomingUpdate < existingUpdate)
        return existing;
    if (terminal(existing.state) && !terminal(incoming.state))
        return existing;
    if (terminal(existing.state) && terminal(incoming.state) && incomingUpdate === existingUpdate)
        return existing;
    return { ...existing, ...incoming, state: incoming.state, lastUpdate: Math.max(existingUpdate, incomingUpdate) };
}
function attachChild(children, event) {
    let updated = false;
    const walk = (items) => items.map((item) => {
        if (item.id === event.parentRunId) {
            const existingChildren = item.children ?? [];
            const childIndex = existingChildren.findIndex((child) => child.id === event.child.id);
            const nextChild = mergeSummary(childIndex >= 0 ? existingChildren[childIndex] : undefined, event);
            const nextChildren = childIndex >= 0
                ? existingChildren.map((child, index) => (index === childIndex ? nextChild : child))
                : [...existingChildren, nextChild];
            updated = true;
            return {
                ...item,
                children: nextChildren.slice(0, MAX_CHILDREN),
                lastUpdate: Math.max(item.lastUpdate ?? 0, event.ts),
            };
        }
        if (!item.children?.length)
            return item;
        const nextChildren = walk(item.children);
        return nextChildren === item.children ? item : { ...item, children: nextChildren };
    });
    const next = walk(children);
    if (updated)
        return next;
    const childIndex = next.findIndex((child) => child.id === event.child.id);
    const nextChild = mergeSummary(childIndex >= 0 ? next[childIndex] : undefined, event);
    return childIndex >= 0
        ? next.map((child, index) => (index === childIndex ? nextChild : child))
        : [...next, nextChild].slice(0, MAX_CHILDREN);
}
export function applyNestedEvent(registry, event) {
    return {
        ...registry,
        updatedAt: Math.max(registry.updatedAt, event.ts),
        children: attachChild(registry.children, event),
    };
}
function registryPath(route) {
    return path.join(commonRouteRoot(route), REGISTRY_FILE);
}
export function findNestedRouteForRootId(rootRunId) {
    assertSafeId("rootRunId", rootRunId);
    let entries;
    try {
        entries = fs.readdirSync(NESTED_EVENTS_DIR);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.startsWith(`${rootRunId}-`))
            continue;
        const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
        try {
            const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8"));
            if (metadata.rootRunId !== rootRunId || typeof metadata.capabilityToken !== "string")
                continue;
            const route = {
                rootRunId,
                eventSink: path.join(routeRoot, "events"),
                controlInbox: path.join(routeRoot, "controls"),
                capabilityToken: metadata.capabilityToken,
            };
            validateRouteShape(route);
            return route;
        }
        catch {
            continue;
        }
    }
    return undefined;
}
export function buildNestedRouteIndex() {
    let entries;
    try {
        entries = fs.readdirSync(NESTED_EVENTS_DIR);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return new Map();
        throw error;
    }
    const index = new Map();
    for (const entry of entries) {
        const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
        try {
            const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8"));
            if (typeof metadata.rootRunId !== "string" || typeof metadata.capabilityToken !== "string")
                continue;
            if (index.has(metadata.rootRunId))
                continue;
            const route = {
                rootRunId: metadata.rootRunId,
                eventSink: path.join(routeRoot, "events"),
                controlInbox: path.join(routeRoot, "controls"),
                capabilityToken: metadata.capabilityToken,
            };
            validateRouteShape(route);
            index.set(metadata.rootRunId, route);
        }
        catch {
            continue;
        }
    }
    return index;
}
export function projectNestedRegistryForRoot(rootRunId) {
    const route = findNestedRouteForRootId(rootRunId);
    return route ? projectNestedEvents(route) : undefined;
}
export function findNestedRun(children, id) {
    if (!children?.length)
        return undefined;
    for (const child of children) {
        if (child.id === id)
            return child;
        const nested = findNestedRun(child.children, id) ??
            findNestedRun(child.steps?.flatMap((step) => step.children ?? []), id);
        if (nested)
            return nested;
    }
    return undefined;
}
function collectNestedRuns(children, output = []) {
    for (const child of children ?? []) {
        output.push(child);
        collectNestedRuns(child.children, output);
        collectNestedRuns(child.steps?.flatMap((step) => step.children ?? []), output);
    }
    return output;
}
function collectScopedNestedRuns(children, scope, output = []) {
    if (!scope)
        return collectNestedRuns(children, output);
    for (const child of children ?? []) {
        if (child.parentRunId === scope.parentRunId &&
            (scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)) {
            collectNestedRuns([child], output);
            continue;
        }
        collectScopedNestedRuns(child.children, scope, output);
        collectScopedNestedRuns(child.steps?.flatMap((step) => step.children ?? []), scope, output);
    }
    return output;
}
function listNestedRoutes() {
    let entries;
    try {
        entries = fs.readdirSync(NESTED_EVENTS_DIR);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    const routes = [];
    for (const entry of entries) {
        const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
        try {
            const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8"));
            if (typeof metadata.rootRunId !== "string" || typeof metadata.capabilityToken !== "string")
                continue;
            const route = {
                rootRunId: metadata.rootRunId,
                eventSink: path.join(routeRoot, "events"),
                controlInbox: path.join(routeRoot, "controls"),
                capabilityToken: metadata.capabilityToken,
            };
            validateRouteShape(route);
            routes.push(route);
        }
        catch {
            continue;
        }
    }
    return routes;
}
export function findNestedRunMatchesById(id, options = {}) {
    assertSafeId("id", id);
    const matches = [];
    for (const route of options.scope?.routes ?? listNestedRoutes()) {
        try {
            const registry = projectNestedEvents(route);
            for (const run of collectScopedNestedRuns(registry.children, options.scope?.descendantOf)) {
                if (options.prefix ? run.id.startsWith(id) : run.id === id)
                    matches.push({ rootRunId: route.rootRunId, route, run });
            }
        }
        catch {
            continue;
        }
    }
    return matches;
}
export function findNestedRunById(id) {
    const match = findNestedRunMatchesById(id)[0];
    return match ? { rootRunId: match.rootRunId, run: match.run } : undefined;
}
export function readNestedRegistry(route) {
    validateRouteShape(route);
    try {
        const parsed = JSON.parse(fs.readFileSync(registryPath(route), "utf-8"));
        return {
            rootRunId: route.rootRunId,
            updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
            children: Array.isArray(parsed.children)
                ? parsed.children
                    .map((child) => sanitizeSummary(child))
                    .filter((child) => Boolean(child))
                : [],
            processedEvents: Array.isArray(parsed.processedEvents)
                ? parsed.processedEvents.filter((item) => typeof item === "string")
                : [],
        };
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        return { rootRunId: route.rootRunId, updatedAt: 0, children: [], processedEvents: [] };
    }
}
export function projectNestedEvents(route) {
    validateRouteShape(route);
    let registry = readNestedRegistry(route);
    const seen = new Set(registry.processedEvents);
    let changed = false;
    let entries = [];
    try {
        entries = fs
            .readdirSync(route.eventSink)
            .filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"))
            .sort();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    for (const entry of entries) {
        if (seen.has(entry))
            continue;
        const eventPath = path.join(route.eventSink, entry);
        if (!containedPath(route.eventSink, eventPath))
            continue;
        let content;
        try {
            const stat = fs.statSync(eventPath);
            if (!stat.isFile() || stat.size > MAX_EVENT_BYTES)
                continue;
            content = fs.readFileSync(eventPath, "utf-8");
        }
        catch {
            continue;
        }
        for (const event of parseNestedEventRecords(content, route)) {
            registry = applyNestedEvent(registry, event);
        }
        seen.add(entry);
        changed = true;
    }
    if (changed) {
        registry = { ...registry, processedEvents: [...seen].slice(-1000) };
        writeAtomicJson(registryPath(route), registry);
    }
    return registry;
}
function writeRouteRecord(dir, ts, payload) {
    const content = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES)
        throw new Error("Nested route record exceeds the maximum size.");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${String(ts).padStart(13, "0")}-${randomUUID()}.json`;
    const tmp = path.join(dir, `.${name}.tmp`);
    const finalPath = path.join(dir, name);
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, finalPath);
    return finalPath;
}
export function writeNestedEvent(route, event) {
    validateRouteShape(route);
    const record = {
        ...event,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
    };
    const sanitized = parseRecord(JSON.stringify(record), route);
    if (!sanitized)
        throw new Error("Nested event record failed validation.");
    writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}
function parseControlRequest(content, route) {
    if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object")
        return undefined;
    const raw = parsed;
    if (raw.type !== "subagent.nested.control-request")
        return undefined;
    if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken)
        return undefined;
    if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId) || !isSafeNestedId(raw.ownerParentRunId))
        return undefined;
    if (raw.action !== "interrupt" && raw.action !== "resume")
        return undefined;
    const ownerParentStepIndex = clampNumber(raw.ownerParentStepIndex);
    if (raw.ownerParentStepIndex !== undefined) {
        if (ownerParentStepIndex === undefined || !Number.isInteger(ownerParentStepIndex) || ownerParentStepIndex < 0)
            return undefined;
    }
    const deliveryDeadlineAt = clampNumber(raw.deliveryDeadlineAt);
    if (deliveryDeadlineAt === undefined || deliveryDeadlineAt <= 0)
        return undefined;
    const targetIndex = clampNumber(raw.targetIndex);
    if (raw.targetIndex !== undefined) {
        if (targetIndex === undefined || !Number.isInteger(targetIndex) || targetIndex < 0)
            return undefined;
    }
    const ts = clampNumber(raw.ts);
    if (ts === undefined)
        return undefined;
    return {
        type: "subagent.nested.control-request",
        ts,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
        requestId: raw.requestId,
        targetRunId: raw.targetRunId,
        ownerParentRunId: raw.ownerParentRunId,
        ...(ownerParentStepIndex !== undefined ? { ownerParentStepIndex } : {}),
        deliveryDeadlineAt,
        action: raw.action,
        ...(targetIndex !== undefined ? { targetIndex } : {}),
        ...(stringValue(raw.message, 16_000) ? { message: stringValue(raw.message, 16_000) } : {}),
    };
}
function parseControlResult(content, route) {
    if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object")
        return undefined;
    const raw = parsed;
    if (raw.type !== "subagent.nested.control-result")
        return undefined;
    if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken)
        return undefined;
    if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId))
        return undefined;
    const ts = clampNumber(raw.ts);
    if (ts === undefined || typeof raw.ok !== "boolean")
        return undefined;
    return {
        type: "subagent.nested.control-result",
        ts,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
        requestId: raw.requestId,
        targetRunId: raw.targetRunId,
        ok: raw.ok,
        message: stringValue(raw.message, 16_000) ?? (raw.ok ? "Control request completed." : "Control request failed."),
    };
}
export function writeNestedControlRequest(route, request) {
    validateRouteShape(route);
    assertSafeId("requestId", request.requestId);
    assertSafeId("targetRunId", request.targetRunId);
    const record = {
        type: "subagent.nested.control-request",
        ...request,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
    };
    const sanitized = parseControlRequest(JSON.stringify(record), route);
    if (!sanitized)
        throw new Error("Nested control request failed validation.");
    return writeRouteRecord(route.controlInbox, sanitized.ts, sanitized);
}
export function readNestedControlRequests(route) {
    validateRouteShape(route);
    let entries = [];
    try {
        entries = fs
            .readdirSync(route.controlInbox)
            .filter((entry) => entry.endsWith(".json"))
            .sort();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const requests = [];
    for (const entry of entries) {
        const filePath = path.join(route.controlInbox, entry);
        if (!containedPath(route.controlInbox, filePath))
            continue;
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || stat.size > MAX_EVENT_BYTES)
                continue;
            const request = parseControlRequest(fs.readFileSync(filePath, "utf-8"), route);
            if (request)
                requests.push({ ...request, filePath });
        }
        catch {
            continue;
        }
    }
    return requests;
}
export function nestedControlRequestOwnedBy(request, owner) {
    return request.ownerParentRunId === owner.parentRunId && request.ownerParentStepIndex === owner.parentStepIndex;
}
export function claimNestedControlRequest(route, request, claimantId) {
    validateRouteShape(route);
    assertSafeId("claimantId", claimantId);
    if (!containedPath(route.controlInbox, request.filePath))
        return undefined;
    const claimDir = path.join(route.controlInbox, ".claims", claimantId);
    fs.mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    const claimPath = path.join(claimDir, path.basename(request.filePath));
    try {
        fs.renameSync(request.filePath, claimPath);
        return claimPath;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
export function writeNestedControlResult(route, result) {
    validateRouteShape(route);
    assertSafeId("requestId", result.requestId);
    assertSafeId("targetRunId", result.targetRunId);
    const record = {
        type: "subagent.nested.control-result",
        ...result,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
    };
    const sanitized = parseControlResult(JSON.stringify(record), route);
    if (!sanitized)
        throw new Error("Nested control result failed validation.");
    writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}
export function readNestedControlResults(route) {
    validateRouteShape(route);
    let entries = [];
    try {
        entries = fs
            .readdirSync(route.eventSink)
            .filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"))
            .sort();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const results = [];
    for (const entry of entries) {
        const eventPath = path.join(route.eventSink, entry);
        if (!containedPath(route.eventSink, eventPath))
            continue;
        try {
            const stat = fs.statSync(eventPath);
            if (!stat.isFile() || stat.size > MAX_EVENT_BYTES)
                continue;
            const content = fs.readFileSync(eventPath, "utf-8");
            const lines = content.includes("\n") ? content.split("\n").filter((line) => line.trim()) : [content];
            for (const line of lines) {
                const result = parseControlResult(line, route);
                if (result)
                    results.push(result);
            }
        }
        catch {
            continue;
        }
    }
    return results;
}
export function nestedRouteEnv(route) {
    return {
        [SUBAGENT_PARENT_EVENT_SINK_ENV]: route.eventSink,
        [SUBAGENT_PARENT_CONTROL_INBOX_ENV]: route.controlInbox,
        [SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: route.rootRunId,
        [SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: route.capabilityToken,
    };
}
export function attachRootChildrenToSteps(rootRunId, steps, children) {
    if (!steps?.length)
        return;
    for (const step of steps) {
        step.children = undefined;
    }
    if (!children?.length)
        return;
    for (const child of children) {
        if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined)
            continue;
        const step = steps.find((candidate, index) => (candidate.index ?? index) === child.parentStepIndex);
        if (!step)
            continue;
        step.children ??= [];
        step.children = [...step.children.filter((existing) => existing.id !== child.id), child].slice(0, MAX_CHILDREN);
    }
}
export function updateAsyncJobNestedProjection(job) {
    if (!job.nestedRoute)
        return;
    const registry = projectNestedEvents(job.nestedRoute);
    job.nestedChildren = registry.children;
    attachRootChildrenToSteps(job.asyncId, job.steps, registry.children);
}
export function updateForegroundNestedProjection(control) {
    if (!control.nestedRoute)
        return;
    const registry = projectNestedEvents(control.nestedRoute);
    control.nestedChildren = registry.children;
}
export function hasLiveNestedDescendants(children) {
    if (!children?.length)
        return false;
    for (const child of children) {
        if (!terminal(child.state))
            return true;
        if (hasLiveNestedDescendants(child.children))
            return true;
        if (hasLiveNestedDescendants(child.steps?.flatMap((step) => step.children ?? [])))
            return true;
    }
    return false;
}
export function nestedSummaryFromAsyncStatus(status, asyncDir, fallback) {
    return {
        id: status.runId || fallback.id,
        parentRunId: fallback.parentRunId,
        ...(fallback.parentStepIndex !== undefined ? { parentStepIndex: fallback.parentStepIndex } : {}),
        depth: fallback.depth,
        path: fallback.path ?? [
            {
                runId: fallback.parentRunId,
                ...(fallback.parentStepIndex !== undefined ? { stepIndex: fallback.parentStepIndex } : {}),
            },
        ],
        asyncDir,
        ...(status.pid ? { pid: status.pid } : {}),
        ...(status.sessionId ? { sessionId: status.sessionId } : {}),
        mode: status.mode ?? fallback.mode,
        state: nestedStateFromAsyncState(status.state),
        ...(status.currentStep !== undefined ? { currentStep: status.currentStep } : {}),
        ...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
        ...(status.activityState ? { activityState: status.activityState } : {}),
        ...(status.lastActivityAt !== undefined ? { lastActivityAt: status.lastActivityAt } : {}),
        ...(status.currentTool ? { currentTool: status.currentTool } : {}),
        ...(status.currentToolStartedAt !== undefined ? { currentToolStartedAt: status.currentToolStartedAt } : {}),
        ...(status.currentPath ? { currentPath: status.currentPath } : {}),
        ...(status.turnCount !== undefined ? { turnCount: status.turnCount } : {}),
        ...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
        ...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
        ...(status.timeoutMs !== undefined ? { timeoutMs: status.timeoutMs } : {}),
        ...(status.deadlineAt !== undefined ? { deadlineAt: status.deadlineAt } : {}),
        ...(status.timedOut !== undefined ? { timedOut: status.timedOut } : {}),
        ...(status.turnBudget ? { turnBudget: status.turnBudget } : {}),
        ...(status.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: status.turnBudgetExceeded } : {}),
        ...(status.wrapUpRequested !== undefined ? { wrapUpRequested: status.wrapUpRequested } : {}),
        ...(status.error ? { error: status.error } : {}),
        ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : { startedAt: fallback.ts }),
        ...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
        lastUpdate: status.lastUpdate ?? fallback.ts,
        ...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
        ...(status.steps?.length
            ? {
                steps: status.steps
                    .map((step) => ({
                    agent: step.agent,
                    status: nestedStepStatusFromAsyncStepStatus(step.status),
                    ...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
                    ...(step.activityState ? { activityState: step.activityState } : {}),
                    ...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
                    ...(step.currentTool ? { currentTool: step.currentTool } : {}),
                    ...(step.currentToolStartedAt !== undefined ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
                    ...(step.currentPath ? { currentPath: step.currentPath } : {}),
                    ...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
                    ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
                    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
                    ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
                    ...(step.error ? { error: step.error } : {}),
                    ...(step.timedOut !== undefined ? { timedOut: step.timedOut } : {}),
                    ...(step.turnBudget ? { turnBudget: step.turnBudget } : {}),
                    ...(step.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: step.turnBudgetExceeded } : {}),
                    ...(step.wrapUpRequested !== undefined ? { wrapUpRequested: step.wrapUpRequested } : {}),
                }))
                    .slice(0, MAX_STEPS),
            }
            : {}),
    };
}
export function nestedArtifactEnv(rootRunId, parentRunId) {
    return {
        PI_SUBAGENT_NESTED_ROOT_RUN_ID: rootRunId,
        PI_SUBAGENT_NESTED_PARENT_RUN_ID: parentRunId,
    };
}
export function isTopLevelAsyncDir(asyncDir) {
    const resolved = path.resolve(asyncDir);
    return (containedPath(ASYNC_DIR, resolved) && !containedPath(path.join(TEMP_ROOT_DIR, "nested-subagent-runs"), resolved));
}
export function nestedResultsPath(rootRunId, id) {
    assertSafeId("rootRunId", rootRunId);
    assertSafeId("id", id);
    return path.join(RESULTS_DIR, "nested", rootRunId, `${id}.json`);
}
