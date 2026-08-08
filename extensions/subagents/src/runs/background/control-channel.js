import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { POLL_INTERVAL_MS } from "../../shared/types.js";
export const INTERRUPT_SIGNAL = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
const STEER_REQUESTS_DIR = "steer-requests";
const STEER_TARGETS_DIR = "steer-targets";
const CHILD_MESSAGE_ACKS_DIR = "message-acks";
export function controlInboxDir(asyncDir) {
    return path.join(asyncDir, "control");
}
export function interruptRequestPath(asyncDir) {
    return path.join(controlInboxDir(asyncDir), "interrupt.json");
}
export function timeoutRequestPath(asyncDir) {
    return path.join(controlInboxDir(asyncDir), "timeout.json");
}
export function steerRequestsDir(asyncDir) {
    return path.join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}
export function childMessageAcksDir(asyncDir) {
    return path.join(controlInboxDir(asyncDir), CHILD_MESSAGE_ACKS_DIR);
}
export function childMessageAckPath(asyncDir, requestId) {
    return path.join(childMessageAcksDir(asyncDir), `${Buffer.from(requestId).toString("base64url")}.json`);
}
export function stepSteerInboxDir(asyncDir, index) {
    return path.join(controlInboxDir(asyncDir), STEER_TARGETS_DIR, String(index));
}
function childMessageRequestFileName(request) {
    return `${String(request.ts).padStart(13, "0")}-${Buffer.from(request.id).toString("base64url")}.json`;
}
export function writeChildMessageRequestToDir(dir, request) {
    const requestPath = path.join(dir, childMessageRequestFileName(request));
    writeAtomicJson(requestPath, request);
    return requestPath;
}
export function writeSteerRequestToDir(dir, request) {
    return writeChildMessageRequestToDir(dir, request);
}
export function requestAsyncInterrupt(asyncDir, payload = {}, deps = {}) {
    const requestPath = interruptRequestPath(asyncDir);
    const request = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "interrupt" };
    writeAtomicJson(requestPath, request);
    return requestPath;
}
export function requestAsyncTimeout(asyncDir, payload = {}, deps = {}) {
    const requestPath = timeoutRequestPath(asyncDir);
    const request = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "timeout" };
    writeAtomicJson(requestPath, request);
    return requestPath;
}
function requestAsyncChildMessage(asyncDir, type, payload, deps = {}) {
    const message = payload.message.trim();
    if (!message)
        throw new Error(`${type} message must not be empty.`);
    if (payload.targetIndex !== undefined && (!Number.isInteger(payload.targetIndex) || payload.targetIndex < 0)) {
        throw new Error(`${type} targetIndex must be a non-negative integer.`);
    }
    if (payload.deliveryDeadlineAt !== undefined &&
        (!Number.isFinite(payload.deliveryDeadlineAt) || payload.deliveryDeadlineAt <= 0)) {
        throw new Error(`${type} deliveryDeadlineAt must be a positive finite timestamp.`);
    }
    const request = {
        type,
        id: payload.id ?? deps.randomId?.() ?? randomUUID(),
        ts: payload.ts ?? deps.now?.() ?? Date.now(),
        message,
        ...(payload.targetIndex !== undefined ? { targetIndex: payload.targetIndex } : {}),
        ...(payload.deliveryDeadlineAt !== undefined ? { deliveryDeadlineAt: payload.deliveryDeadlineAt } : {}),
        ...(payload.source ? { source: payload.source } : {}),
    };
    return writeChildMessageRequestToDir(steerRequestsDir(asyncDir), request);
}
export function requestAsyncSteer(asyncDir, payload, deps = {}) {
    return requestAsyncChildMessage(asyncDir, "steer", payload, deps);
}
export function requestAsyncResume(asyncDir, payload, deps = {}) {
    return requestAsyncChildMessage(asyncDir, "resume", payload, deps);
}
export function enqueueStepChildMessage(asyncDir, index, request) {
    if (!Number.isInteger(index) || index < 0)
        throw new Error("child message index must be a non-negative integer.");
    return writeChildMessageRequestToDir(stepSteerInboxDir(asyncDir, index), { ...request, targetIndex: index });
}
export function enqueueStepSteer(asyncDir, index, request) {
    return enqueueStepChildMessage(asyncDir, index, { ...request, type: "steer" });
}
export function acceptChildMessageRequest(input) {
    const runningIndexes = input.steps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => step.status === "running")
        .map(({ index }) => index);
    const targets = input.request.targetIndex !== undefined ? [input.request.targetIndex] : runningIndexes;
    const acceptedIndexes = [];
    const rejected = [];
    if (input.request.deliveryDeadlineAt !== undefined &&
        (input.now?.() ?? Date.now()) >= input.request.deliveryDeadlineAt) {
        return { acceptedIndexes, rejected: targets.map((index) => ({ index, reason: "delivery deadline expired" })) };
    }
    for (const index of targets) {
        const step = input.steps[index];
        if (!step) {
            rejected.push({ index, reason: "child index out of range" });
            continue;
        }
        if (step.status !== "running") {
            rejected.push({ index, reason: `child is ${step.status}` });
            continue;
        }
        try {
            input.enqueue(index, input.request);
        }
        catch (error) {
            rejected.push({
                index,
                reason: `leaf inbox enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
        }
        acceptedIndexes.push(index);
    }
    return { acceptedIndexes, rejected };
}
export function writeChildMessageAcceptance(asyncDir, acceptance) {
    const acceptancePath = childMessageAckPath(asyncDir, acceptance.requestId);
    writeAtomicJson(acceptancePath, acceptance);
    return acceptancePath;
}
export function childMessageRequestRequiresAcceptance(request) {
    return request.type === "resume";
}
export function writeChildMessageAcceptanceForRequest(asyncDir, request, acceptance) {
    if (!childMessageRequestRequiresAcceptance(request))
        return undefined;
    return writeChildMessageAcceptance(asyncDir, { ...acceptance, requestId: request.id, type: request.type });
}
function parseChildMessageAcceptance(raw, requestId) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const input = raw;
    if (input.requestId !== requestId || (input.type !== "steer" && input.type !== "resume"))
        return undefined;
    if (input.status !== "accepted" && input.status !== "rejected")
        return undefined;
    if (typeof input.ts !== "number" ||
        !Number.isFinite(input.ts) ||
        !Array.isArray(input.acceptedIndexes) ||
        !input.acceptedIndexes.every(Number.isInteger))
        return undefined;
    return input;
}
export function consumeChildMessageAcceptance(asyncDir, requestId) {
    const acceptancePath = childMessageAckPath(asyncDir, requestId);
    try {
        const parsed = parseChildMessageAcceptance(JSON.parse(fs.readFileSync(acceptancePath, "utf-8")), requestId);
        fs.rmSync(acceptancePath, { force: true });
        return parsed;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        try {
            fs.rmSync(acceptancePath, { force: true });
        }
        catch {
        }
        return undefined;
    }
}
export async function waitForChildMessageAcceptance(input) {
    const now = input.now ?? Date.now;
    const startedAt = now();
    const timeoutMs = input.timeoutMs ?? 2_000;
    const delay = input.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    while (now() - startedAt < timeoutMs) {
        const acceptance = consumeChildMessageAcceptance(input.asyncDir, input.requestId);
        if (acceptance)
            return { outcome: "acknowledged", acceptance };
        if (input.isRunnerAlive && !input.isRunnerAlive())
            return { outcome: "runner_gone" };
        await delay(input.pollIntervalMs ?? 25);
    }
    const acceptance = consumeChildMessageAcceptance(input.asyncDir, input.requestId);
    return acceptance ? { outcome: "acknowledged", acceptance } : { outcome: "timeout" };
}
function parseChildMessageRequest(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const input = raw;
    if (input.type !== "steer" && input.type !== "resume")
        return undefined;
    if (typeof input.id !== "string" || !input.id.trim())
        return undefined;
    if (typeof input.ts !== "number" || !Number.isFinite(input.ts))
        return undefined;
    if (typeof input.message !== "string" || !input.message.trim())
        return undefined;
    if (input.targetIndex !== undefined && (!Number.isInteger(input.targetIndex) || input.targetIndex < 0))
        return undefined;
    if (input.deliveryDeadlineAt !== undefined &&
        (typeof input.deliveryDeadlineAt !== "number" ||
            !Number.isFinite(input.deliveryDeadlineAt) ||
            input.deliveryDeadlineAt <= 0))
        return undefined;
    return {
        type: input.type,
        id: input.id.trim(),
        ts: input.ts,
        message: input.message.trim(),
        ...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}),
        ...(input.deliveryDeadlineAt !== undefined ? { deliveryDeadlineAt: input.deliveryDeadlineAt } : {}),
        ...(typeof input.source === "string" && input.source.trim() ? { source: input.source } : {}),
    };
}
function consumeMatchingChildMessageRequestsFromDir(dir, matches, fsImpl = fs) {
    if (!fsImpl.existsSync(dir))
        return [];
    const requests = [];
    for (const entry of fsImpl
        .readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort()) {
        const requestPath = path.join(dir, entry);
        let parsed;
        try {
            parsed = parseChildMessageRequest(JSON.parse(fsImpl.readFileSync(requestPath, "utf-8")));
        }
        catch {
            parsed = undefined;
        }
        if (parsed && !matches(parsed))
            continue;
        try {
            fsImpl.rmSync(requestPath, { recursive: true });
        }
        catch {
            continue;
        }
        if (parsed)
            requests.push(parsed);
    }
    return requests.sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
}
export function consumeChildMessageRequestsFromDir(dir, fsImpl = fs) {
    return consumeMatchingChildMessageRequestsFromDir(dir, (request) => request.type === "steer" || request.type === "resume", fsImpl);
}
export function consumeSteerRequestsFromDir(dir, fsImpl = fs) {
    return consumeMatchingChildMessageRequestsFromDir(dir, (request) => request.type === "steer", fsImpl);
}
export function consumeSteerRequests(asyncDir, fsImpl = fs) {
    return consumeSteerRequestsFromDir(steerRequestsDir(asyncDir), fsImpl);
}
export function consumeChildMessageRequests(asyncDir, fsImpl = fs) {
    return consumeChildMessageRequestsFromDir(steerRequestsDir(asyncDir), fsImpl);
}
export function readInterruptRequest(asyncDir, fsImpl = fs) {
    const requestPath = interruptRequestPath(asyncDir);
    try {
        return JSON.parse(fsImpl.readFileSync(requestPath, "utf-8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
export function consumeInterruptRequest(asyncDir, fsImpl = fs) {
    const requestPath = interruptRequestPath(asyncDir);
    if (!fsImpl.existsSync(requestPath))
        return false;
    try {
        fsImpl.rmSync(requestPath, { force: true, recursive: true });
    }
    catch {
    }
    return true;
}
export function consumeTimeoutRequest(asyncDir, fsImpl = fs) {
    const requestPath = timeoutRequestPath(asyncDir);
    if (!fsImpl.existsSync(requestPath))
        return false;
    try {
        fsImpl.rmSync(requestPath, { force: true, recursive: true });
    }
    catch {
    }
    return true;
}
export function deliverInterruptRequest(input) {
    const requestPath = requestAsyncInterrupt(input.asyncDir, input.source ? { source: input.source } : {}, {
        now: input.now,
    });
    if (typeof input.pid === "number" && input.pid > 0) {
        try {
            (input.kill ?? process.kill)(input.pid, input.signal ?? INTERRUPT_SIGNAL);
        }
        catch (error) {
            if (error?.code === "ENOSYS") {
                return;
            }
            try {
                fs.rmSync(requestPath, { force: true });
            }
            catch {
            }
            throw error;
        }
    }
}
export function deliverTimeoutRequest(input) {
    requestAsyncTimeout(input.asyncDir, input.source ? { source: input.source } : {}, { now: input.now });
}
export function watchAsyncControlInbox(asyncDir, opts) {
    const fsImpl = opts.fs ?? fs;
    const timers = opts.timers ?? { setInterval, clearInterval };
    const dir = controlInboxDir(asyncDir);
    try {
        fsImpl.mkdirSync(dir, { recursive: true });
    }
    catch {
    }
    let disposed = false;
    const check = () => {
        if (disposed)
            return;
        try {
            if (consumeTimeoutRequest(asyncDir, fsImpl))
                opts.onTimeout?.();
            if (consumeInterruptRequest(asyncDir, fsImpl))
                opts.onInterrupt();
            for (const request of consumeChildMessageRequests(asyncDir, fsImpl)) {
                if (request.type === "resume")
                    opts.onResume?.(request);
                else
                    opts.onSteer?.(request);
            }
        }
        catch {
        }
    };
    check();
    let watcher;
    try {
        watcher = fsImpl.watch(dir, () => check());
        watcher.on?.("error", () => {
        });
    }
    catch {
        watcher = undefined;
    }
    const interval = timers.setInterval(check, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
    interval.unref?.();
    return () => {
        if (disposed)
            return;
        disposed = true;
        try {
            watcher?.close();
        }
        catch {
        }
        timers.clearInterval(interval);
    };
}
