import { createConnection } from "node:net";
import { frame, json, MAX_CONTROL_BYTES, option, parseReadyResult, parseReplyRequest, readRendezvous, replyCloseFrame, replyReceiptFrame, REPLY_TEXT_CAPABILITY, socketIsSafe, socketPath, sourceInstanceId, validIdentity, validPath, } from "./local-bridge-boundary.js";
export const SESSION_MIRROR_REPLY_CHANNEL_DEADLINE_MS = 5_000;
export const SESSION_MIRROR_REPLY_CHANNEL_MAX_CONTROL_BYTES = MAX_CONTROL_BYTES;
const FAILURE = "local bridge reply channel failed";
const FAILURE_EVENTS = ["error", "end", "close"];
const DEFAULT_CLOSE_REASON = "producer-disconnect";
const MAX_REPLY_GENERATION = 2_000_000_000;
function controls(value) {
    const result = option(value, "controls");
    return result !== null && typeof result === "object" ? result : {};
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
function isSocket(value) {
    if (value === null || typeof value !== "object")
        return false;
    return ["once", "on", "removeListener", "write", "destroy", "pause", "resume"].every((key) => hasMethod(value, key));
}
function connectionFactory(value) {
    const candidate = option(value, "createConnection");
    if (typeof candidate === "function")
        return candidate;
    return (input) => createConnection(input);
}
function schedule(value) {
    const candidate = option(value, "setTimeout");
    if (typeof candidate === "function")
        return candidate;
    return (callback, delay) => setTimeout(callback, delay);
}
function clearTimer(value) {
    const candidate = option(value, "clearTimeout");
    if (typeof candidate === "function")
        return candidate;
    return (timer) => clearTimeout(timer);
}
function bestEffort(action) {
    try {
        action();
    }
    catch { }
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
function boundedDeadline(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.min(value, SESSION_MIRROR_REPLY_CHANNEL_DEADLINE_MS)
        : SESSION_MIRROR_REPLY_CHANNEL_DEADLINE_MS;
}
function boundedSourceEpoch(value) {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= Number.MAX_SAFE_INTEGER - 1
        ? value
        : undefined;
}
function boundedGeneration(value) {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= MAX_REPLY_GENERATION
        ? value
        : undefined;
}
function readyHandshake(rendezvous, info) {
    const body = json({
        kind: "reply-hello",
        protocol: { family: "local-bridge", major: 0, minor: 1 },
        installationId: rendezvous.installationId,
        sessionId: info.sessionId,
        sourceInstanceId: info.sourceInstanceId,
        sourceEpoch: info.sourceEpoch,
        generation: info.generation,
        launchToken: rendezvous.launchToken,
        capabilities: [REPLY_TEXT_CAPABILITY],
    });
    return body === undefined || body.byteLength > MAX_CONTROL_BYTES ? undefined : frame(body);
}
function validReadyInfo(options) {
    const sessionId = validIdentity(options.sessionId);
    const sourceId = sourceInstanceId(options.sourceInstanceId);
    const sourceEpoch = boundedSourceEpoch(options.sourceEpoch);
    const generation = boundedGeneration(options.generation);
    return sessionId !== undefined &&
        sourceId !== undefined &&
        sourceEpoch !== undefined &&
        generation !== undefined
        ? Object.freeze({ sessionId, sourceInstanceId: sourceId, sourceEpoch, generation })
        : undefined;
}
export function createSessionMirrorReplyChannel(options) {
    const injected = controls(options);
    const connect = connectionFactory(injected);
    const scheduleTimer = schedule(injected);
    const clear = clearTimer(injected);
    const info = validReadyInfo(options);
    let state = "connecting";
    let socket;
    let handshakeComplete = false;
    let closeRequested = false;
    let closeNotified = false;
    let cancelPending;
    let openPromise;
    const notifyClosed = () => {
        if (closeNotified)
            return;
        closeNotified = true;
        bestEffort(() => options.onClosed?.());
    };
    const destroy = () => {
        const current = socket;
        if (current === undefined)
            return;
        bestEffort(() => current.destroy());
        socket = undefined;
    };
    const fail = () => {
        if (state === "closed")
            return;
        state = "closed";
        closeRequested = true;
        bestEffort(() => cancelPending?.());
        cancelPending = undefined;
        destroy();
        notifyClosed();
    };
    const open = () => {
        if (openPromise !== undefined)
            return openPromise;
        openPromise = new Promise((resolve) => {
            if (info === undefined || typeof options.onRequest !== "function") {
                state = "closed";
                closeRequested = true;
                resolve(false);
                notifyClosed();
                return;
            }
            let timer;
            let fallbackTimer;
            let settled = false;
            const register = (cancel) => {
                cancelPending = cancel;
            };
            const finish = (ok) => {
                if (settled)
                    return;
                settled = true;
                bestEffort(() => cancelPending?.());
                cancelPending = undefined;
                bestEffort(() => timer === undefined || clear(timer));
                bestEffort(() => fallbackTimer === undefined || clearTimeout(fallbackTimer));
                if (!ok) {
                    state = "closed";
                    closeRequested = true;
                    destroy();
                    notifyClosed();
                    resolve(false);
                    return;
                }
                state = "open";
                resolve(true);
            };
            const attach = (candidate) => {
                socket = candidate;
                const onError = () => fail();
                const onEnd = () => fail();
                const onClose = () => fail();
                try {
                    candidate.on("error", onError);
                    candidate.once("end", onEnd);
                    candidate.once("close", onClose);
                    if (hasMethod(candidate, "unref"))
                        bestEffort(() => candidate.unref?.());
                }
                catch {
                    fail();
                }
            };
            if (closeRequested) {
                finish(false);
                return;
            }
            const timeout = boundedDeadline(options.deadlineMs);
            try {
                timer = scheduleTimer(() => finish(false), timeout);
                if (settled) {
                    bestEffort(() => timer === undefined || clear(timer));
                    timer = undefined;
                }
                else if (hasMethod(timer, "unref")) {
                    bestEffort(() => timer.unref?.());
                }
            }
            catch { }
            if (!settled) {
                try {
                    fallbackTimer = setTimeout(() => finish(false), timeout);
                    if (settled) {
                        bestEffort(() => fallbackTimer === undefined || clearTimeout(fallbackTimer));
                        fallbackTimer = undefined;
                    }
                    else {
                        bestEffort(() => fallbackTimer?.unref?.());
                    }
                }
                catch {
                    finish(false);
                }
            }
            if (settled)
                return;
            void (async () => {
                try {
                    if (settled || closeRequested)
                        return;
                    const directory = validPath(options.bridgeDirectory);
                    const rendezvous = directory && readRendezvous(directory, injected);
                    const path = rendezvous && socketPath(directory, rendezvous.socketName);
                    if (closeRequested ||
                        !rendezvous ||
                        !path ||
                        !socketIsSafe(path, injected) ||
                        info === undefined) {
                        finish(false);
                        return;
                    }
                    const hello = readyHandshake(rendezvous, info);
                    if (hello === undefined) {
                        finish(false);
                        return;
                    }
                    const candidate = connect({ path });
                    if (!isSocket(candidate)) {
                        finish(false);
                        return;
                    }
                    if (closeRequested) {
                        bestEffort(() => candidate.destroy());
                        finish(false);
                        return;
                    }
                    attach(candidate);
                    if (closeRequested) {
                        finish(false);
                        return;
                    }
                    await waitConnect(candidate, register);
                    if (closeRequested) {
                        finish(false);
                        return;
                    }
                    await writeFrame(candidate, hello, register);
                    if (closeRequested) {
                        finish(false);
                        return;
                    }
                    const ready = parseReadyResult(await readFrame(candidate, MAX_CONTROL_BYTES, register));
                    if (closeRequested || ready === undefined || ready.sourceEpoch !== info.sourceEpoch) {
                        finish(false);
                        return;
                    }
                    handshakeComplete = true;
                    finish(true);
                    while (!closeRequested && state === "open") {
                        let body;
                        try {
                            body = await readFrame(candidate, MAX_CONTROL_BYTES, (cancel) => {
                                cancelPending = cancel;
                            });
                        }
                        catch {
                            fail();
                            return;
                        }
                        if (closeRequested || state !== "open")
                            return;
                        const request = parseReplyRequest(body);
                        let code = "invalid";
                        if (request !== undefined) {
                            try {
                                const result = await options.onRequest(request);
                                code =
                                    typeof result === "string" &&
                                        [
                                            "accepted",
                                            "unconfirmed",
                                            "invalid",
                                            "unauthorized",
                                            "stale",
                                            "busy",
                                            "duplicate",
                                            "expired",
                                            "disconnected",
                                        ].includes(result)
                                        ? result
                                        : "unconfirmed";
                            }
                            catch {
                                code = "unconfirmed";
                            }
                        }
                        if (closeRequested || state !== "open")
                            return;
                        const receipt = replyReceiptFrame(code);
                        if (receipt === undefined) {
                            fail();
                            return;
                        }
                        try {
                            await writeFrame(candidate, receipt, (cancel) => {
                                cancelPending = cancel;
                            });
                        }
                        catch {
                            fail();
                            return;
                        }
                    }
                }
                catch {
                    finish(false);
                }
            })();
        });
        return openPromise;
    };
    const close = (reason = DEFAULT_CLOSE_REASON) => {
        if (state === "closed" && closeRequested)
            return;
        closeRequested = true;
        state = "closed";
        bestEffort(() => cancelPending?.());
        cancelPending = undefined;
        const current = socket;
        const closeFrame = handshakeComplete ? replyCloseFrame(reason) : undefined;
        if (current !== undefined && closeFrame !== undefined) {
            void writeFrame(current, closeFrame, () => undefined).finally(() => {
                destroy();
                notifyClosed();
            });
        }
        else {
            destroy();
            notifyClosed();
        }
    };
    return Object.freeze({
        open,
        close,
        getState: () => state,
    });
}
export default createSessionMirrorReplyChannel;
