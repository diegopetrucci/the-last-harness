import { createConnection } from "node:net";
import { frame, json, MAX_CONTROL_BYTES, MAX_FRAME_BYTES, MAX_PATH_BYTES, option, parseReadyResult, parseResult, readRendezvous, socketIsSafe, socketPath, sourceInstanceId, validIdentity, validPath, } from "./local-bridge-boundary.js";
export const SESSION_MIRROR_OBSERVER_SINK_DEADLINE_MS = 5_000;
export const SESSION_MIRROR_OBSERVER_SINK_MAX_FRAME_BYTES = MAX_FRAME_BYTES;
export const SESSION_MIRROR_OBSERVER_SINK_MAX_CONTROL_BYTES = MAX_CONTROL_BYTES;
export const SESSION_MIRROR_OBSERVER_SINK_MAX_PATH_BYTES = MAX_PATH_BYTES;
const CAPABILITIES = ["snapshot-replace", "cursor-recovery"];
const FAILURE_EVENTS = ["error", "end", "close"];
const FAILURE = "local bridge publication failed";
function publishedSnapshotTarget(envelope) {
    try {
        const revision = envelope.message.revision;
        const leafId = validIdentity(envelope.message.snapshot.tree.activeLeafId);
        if (leafId === undefined ||
            !Number.isSafeInteger(revision) ||
            Object.is(revision, -0) ||
            revision <= 0 ||
            revision > Number.MAX_SAFE_INTEGER - 1) {
            return undefined;
        }
        const parents = new Map();
        for (const entry of envelope.message.snapshot.tree.entries) {
            const id = validIdentity(entry.id);
            const parent = entry.parentId;
            if (id === undefined || !(parent === null || validIdentity(parent) !== undefined)) {
                return undefined;
            }
            if (parents.has(id))
                return undefined;
            parents.set(id, parent);
        }
        let branchId = leafId;
        const seen = new Set();
        while (true) {
            if (seen.has(branchId) || seen.size > parents.size)
                return undefined;
            seen.add(branchId);
            const parent = parents.get(branchId);
            if (parent === undefined)
                return undefined;
            if (parent === null) {
                return Object.freeze({ branchId, leafId, sourceRevision: revision });
            }
            branchId = parent;
        }
    }
    catch {
        return undefined;
    }
}
function controls(value) {
    const result = option(value, "controls");
    return result !== null && typeof result === "object" ? result : {};
}
function isConnection(value) {
    return typeof value === "function";
}
function isSchedule(value) {
    return typeof value === "function";
}
function isClearTimer(value) {
    return typeof value === "function";
}
function connectionFactory(value) {
    const result = option(value, "createConnection");
    return isConnection(result) ? result : (input) => createConnection(input);
}
function schedule(value) {
    const result = option(value, "setTimeout");
    return isSchedule(result) ? result : setTimeout;
}
function clearTimer(value) {
    const result = option(value, "clearTimeout");
    return isClearTimer(result) ? result : clearTimeout;
}
function bestEffort(action) {
    try {
        action();
    }
    catch { }
}
function hasMethod(value, key) {
    if (value === null || typeof value !== "object")
        return false;
    try {
        let current = value;
        for (let depth = 0; current !== null && depth < 8; depth += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor)
                return Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function";
            current = Object.getPrototypeOf(current);
        }
    }
    catch {
        return false;
    }
    return false;
}
function isBridgeSocket(value) {
    if (value === null || typeof value !== "object")
        return false;
    return ["once", "on", "removeListener", "write", "destroy", "pause", "resume"].every((key) => hasMethod(value, key));
}
function remove(socket, event, listener) {
    bestEffort(() => socket.removeListener(event, listener));
}
function waitConnect(socket, register) {
    return new Promise((resolve, reject) => {
        let done = false;
        const connected = () => finish(true);
        const failed = () => finish(false);
        const finish = (ok) => {
            if (done)
                return;
            done = true;
            remove(socket, "connect", connected);
            for (const event of FAILURE_EVENTS)
                remove(socket, event, failed);
            if (ok)
                resolve();
            else
                reject(new Error(FAILURE));
        };
        register(() => finish(false));
        try {
            socket.once("connect", connected);
            for (const event of FAILURE_EVENTS)
                if (!done)
                    socket.once(event, failed);
        }
        catch {
            finish(false);
        }
    });
}
function writeFrame(socket, bytes, register) {
    return new Promise((resolve, reject) => {
        let callbackDone = false;
        let drainDone = true;
        let returned = false;
        let done = false;
        const failed = () => finish(false);
        const drained = () => {
            drainDone = true;
            finish(true);
        };
        const finish = (ok) => {
            if (done || (ok && (!returned || !callbackDone || !drainDone)))
                return;
            done = true;
            for (const event of FAILURE_EVENTS)
                remove(socket, event, failed);
            remove(socket, "drain", drained);
            if (ok)
                resolve();
            else
                reject(new Error(FAILURE));
        };
        register(() => finish(false));
        try {
            for (const event of FAILURE_EVENTS)
                if (!done)
                    socket.once(event, failed);
            const written = (error) => {
                if (error !== undefined && error !== null)
                    return finish(false);
                callbackDone = true;
                finish(true);
            };
            if (done)
                return;
            drainDone = socket.write(Buffer.from(bytes), written);
            returned = true;
            if (!drainDone)
                socket.once("drain", drained);
            finish(true);
        }
        catch {
            finish(false);
        }
    });
}
function readFrame(socket, maximum, register) {
    return new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        let expected = -1;
        let done = false;
        const failed = () => finish();
        const finish = (value) => {
            if (done)
                return;
            done = true;
            bestEffort(() => socket.pause());
            remove(socket, "data", received);
            for (const event of FAILURE_EVENTS)
                remove(socket, event, failed);
            if (value === undefined)
                reject(new Error(FAILURE));
            else
                resolve(value);
        };
        const received = (chunk) => {
            try {
                if (!(chunk instanceof Uint8Array) || chunk.byteLength > maximum + 4)
                    return finish();
                if (bytes.length + chunk.byteLength > maximum + 4)
                    return finish();
                bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
                if (expected < 0 && bytes.length >= 4) {
                    expected = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
                    if (expected > maximum)
                        return finish();
                }
                if (expected >= 0 && bytes.length >= expected + 4) {
                    if (bytes.length !== expected + 4)
                        return finish();
                    finish(bytes.subarray(4));
                }
            }
            catch {
                finish();
            }
        };
        register(() => finish());
        try {
            for (const event of FAILURE_EVENTS)
                if (!done)
                    socket.once(event, failed);
            if (!done)
                socket.on("data", received);
            if (!done)
                socket.resume();
        }
        catch {
            finish();
        }
    });
}
export function createSessionMirrorObserverSocketSink(options = {}) {
    const injected = controls(options);
    const clear = clearTimer(injected);
    const connect = connectionFactory(injected);
    const configuredSourceId = sourceInstanceId(option(options, "sourceInstanceId"));
    const readyCallback = option(options, "onReady");
    const onReady = typeof readyCallback === "function"
        ? readyCallback
        : undefined;
    let retained;
    let activePublication;
    let publicationRunning = false;
    let closed = false;
    const destroyRecord = (record) => {
        if (record.destroyed || record.closed)
            return;
        record.destroyed = true;
        bestEffort(() => record.socket.destroy());
    };
    const retireRecord = (record) => {
        record.healthy = false;
        if (retained === record)
            retained = undefined;
        destroyRecord(record);
    };
    const healthyRecord = (record) => record !== undefined && retained === record && record.ready && record.healthy && !record.closed;
    function publishOne(envelope) {
        if (closed)
            return Promise.reject(new Error(FAILURE));
        return new Promise((resolve, reject) => {
            let record;
            let timer;
            let fallbackTimer;
            let pendingCancel;
            let invalidOnFailure = false;
            let settled = false;
            let operation;
            const register = (cancel) => (pendingCancel = cancel);
            const finish = (ok) => {
                if (settled)
                    return;
                settled = true;
                bestEffort(() => pendingCancel?.());
                pendingCancel = undefined;
                bestEffort(() => timer === undefined || clear(timer));
                bestEffort(() => fallbackTimer === undefined || clearTimeout(fallbackTimer));
                const successful = ok && !closed && healthyRecord(record);
                if (!successful && record !== undefined && (invalidOnFailure || closed)) {
                    retireRecord(record);
                }
                if (activePublication === operation)
                    activePublication = undefined;
                if (successful)
                    resolve();
                else
                    reject(new Error(FAILURE));
            };
            operation = { cancel: () => finish(false) };
            activePublication = operation;
            const attach = (socket, sessionId) => {
                let record;
                const onError = () => {
                    if (record !== undefined)
                        retireRecord(record);
                };
                const onEnd = () => {
                    if (record !== undefined)
                        retireRecord(record);
                };
                const onClose = () => {
                    if (record === undefined)
                        return;
                    record.healthy = false;
                    record.closed = true;
                    if (retained === record)
                        retained = undefined;
                    remove(record.socket, "error", record.onError);
                    remove(record.socket, "end", record.onEnd);
                };
                record = {
                    socket,
                    sessionId,
                    onError,
                    onEnd,
                    onClose,
                    sourceEpoch: 0,
                    ready: false,
                    healthy: true,
                    closed: false,
                    destroyed: false,
                };
                retained = record;
                try {
                    if (settled || closed)
                        throw new Error(FAILURE);
                    socket.on("error", onError);
                    if (settled || closed)
                        throw new Error(FAILURE);
                    socket.once("end", onEnd);
                    socket.once("close", onClose);
                    if (hasMethod(socket, "unref"))
                        bestEffort(() => socket.unref?.());
                    if (settled || closed)
                        throw new Error(FAILURE);
                }
                catch {
                    retireRecord(record);
                    throw new Error(FAILURE);
                }
                return record;
            };
            const connectAndHandshake = async (sessionId) => {
                if (settled || closed)
                    throw new Error(FAILURE);
                const directory = validPath(option(options, "bridgeDirectory"));
                const rendezvous = directory && readRendezvous(directory, injected);
                const path = rendezvous && socketPath(directory, rendezvous.socketName);
                if (settled || closed || !rendezvous || !path)
                    throw new Error(FAILURE);
                if (settled || closed || !socketIsSafe(path, injected))
                    throw new Error(FAILURE);
                if (settled || closed)
                    throw new Error(FAILURE);
                const hello = json({
                    kind: "hello",
                    protocol: { family: "local-bridge", major: 0, minor: 0 },
                    installationId: rendezvous.installationId,
                    sessionId,
                    sourceInstanceId: configuredSourceId,
                    launchToken: rendezvous.launchToken,
                    capabilities: CAPABILITIES,
                });
                const helloFrame = hello && frame(hello);
                if (!helloFrame || helloFrame.byteLength - 4 > MAX_CONTROL_BYTES)
                    throw new Error(FAILURE);
                const candidate = connect({ path });
                if (!isBridgeSocket(candidate))
                    throw new Error(FAILURE);
                if (settled || closed) {
                    bestEffort(() => candidate.destroy());
                    throw new Error(FAILURE);
                }
                record = attach(candidate, sessionId);
                const current = record;
                await waitConnect(current.socket, register);
                if (settled || closed || !current.healthy || current.closed)
                    throw new Error(FAILURE);
                await writeFrame(current.socket, helloFrame, register);
                if (settled || closed || !current.healthy || current.closed)
                    throw new Error(FAILURE);
                const ready = parseReadyResult(await readFrame(current.socket, MAX_CONTROL_BYTES, register));
                if (settled || closed || !current.healthy || current.closed || ready === undefined)
                    throw new Error(FAILURE);
                current.sourceEpoch = ready.sourceEpoch;
                current.ready = true;
                return current;
            };
            void (async () => {
                try {
                    const timeoutValue = option(options, "deadlineMs");
                    const timeout = typeof timeoutValue === "number" && Number.isFinite(timeoutValue) && timeoutValue >= 0
                        ? Math.min(timeoutValue, SESSION_MIRROR_OBSERVER_SINK_DEADLINE_MS)
                        : SESSION_MIRROR_OBSERVER_SINK_DEADLINE_MS;
                    timer = schedule(injected)(() => finish(false), timeout);
                    if (hasMethod(timer, "unref"))
                        bestEffort(() => timer?.unref?.());
                    if (settled)
                        return;
                    fallbackTimer = setTimeout(() => finish(false), timeout);
                    bestEffort(() => fallbackTimer?.unref?.());
                    const sessionId = validIdentity(option(envelope, "sessionId"));
                    if (!sessionId || !configuredSourceId)
                        return finish(false);
                    const data = json(envelope);
                    const dataFrame = data && frame(data);
                    if (settled || closed || !dataFrame)
                        return finish(false);
                    record = retained;
                    if (record !== undefined && !healthyRecord(record)) {
                        retireRecord(record);
                        record = undefined;
                    }
                    if (record !== undefined && record.sessionId !== sessionId) {
                        retireRecord(record);
                        return finish(false);
                    }
                    invalidOnFailure = true;
                    if (settled || closed)
                        return finish(false);
                    if (record === undefined) {
                        record = await connectAndHandshake(sessionId);
                    }
                    if (settled || closed || !healthyRecord(record))
                        return finish(false);
                    await writeFrame(record.socket, dataFrame, register);
                    if (settled || closed || !healthyRecord(record))
                        return finish(false);
                    const readyRecord = record;
                    if (readyRecord === undefined || !healthyRecord(readyRecord))
                        throw new Error(FAILURE);
                    const result = parseResult(await readFrame(readyRecord.socket, MAX_CONTROL_BYTES, register));
                    if (result !== "accepted" && result !== "duplicate" && result !== "deduplicated")
                        throw new Error(FAILURE);
                    const target = publishedSnapshotTarget(envelope);
                    if (target !== undefined && onReady !== undefined && configuredSourceId !== undefined) {
                        bestEffort(() => onReady({
                            sessionId,
                            sourceInstanceId: configuredSourceId,
                            sourceEpoch: readyRecord.sourceEpoch,
                            ...target,
                        }));
                    }
                    finish(true);
                }
                catch {
                    finish(false);
                }
            })();
        });
    }
    const publish = (envelope) => {
        if (closed || publicationRunning)
            return Promise.reject(new Error(FAILURE));
        publicationRunning = true;
        let publication;
        try {
            publication = publishOne(envelope);
        }
        catch {
            publication = Promise.reject(new Error(FAILURE));
        }
        return publication.then(() => {
            publicationRunning = false;
        }, (error) => {
            publicationRunning = false;
            throw error;
        });
    };
    const shutdown = () => {
        if (closed)
            return;
        closed = true;
        activePublication?.cancel();
        const current = retained;
        if (current !== undefined)
            retireRecord(current);
    };
    const sink = Object.assign(publish, { shutdown });
    return Object.freeze(sink);
}
