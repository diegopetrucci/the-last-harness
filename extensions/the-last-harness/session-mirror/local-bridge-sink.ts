import { createConnection } from "node:net";

import {
  frame,
  json,
  MAX_CONTROL_BYTES,
  MAX_FRAME_BYTES,
  MAX_PATH_BYTES,
  option,
  parseResult,
  readRendezvous,
  socketIsSafe,
  socketPath,
  sourceInstanceId,
  validIdentity,
  validPath,
} from "./local-bridge-boundary.js";
import type { SessionMirrorObserverSink } from "./observer.js";
import type { SessionMirrorSnapshotProjectionEnvelope } from "./session-adapter.js";

export const SESSION_MIRROR_OBSERVER_SINK_DEADLINE_MS = 5_000;
export const SESSION_MIRROR_OBSERVER_SINK_MAX_FRAME_BYTES = MAX_FRAME_BYTES;
export const SESSION_MIRROR_OBSERVER_SINK_MAX_CONTROL_BYTES = MAX_CONTROL_BYTES;
export const SESSION_MIRROR_OBSERVER_SINK_MAX_PATH_BYTES = MAX_PATH_BYTES;

const CAPABILITIES = ["snapshot-replace", "cursor-recovery"] as const;
const FAILURE_EVENTS = ["error", "end", "close"] as const;
const FAILURE = "local bridge publication failed";
type SocketListener = (...args: readonly unknown[]) => void;
type BridgeSocket = {
  once(event: string, listener: SocketListener): void;
  on(event: string, listener: SocketListener): void;
  removeListener(event: string, listener: SocketListener): void;
  write(data: Uint8Array, callback: SocketListener): boolean;
  destroy(): void;
  pause(): void;
  resume(): void;
  unref?: () => void;
};
type ConnectionFactory = (options: { readonly path: string }) => object;
type TimerHandle = ReturnType<typeof setTimeout>;
type Schedule = typeof setTimeout;
type ClearTimer = typeof clearTimeout;
type Cancel = (cancel: () => void) => void;
type SocketRecord = {
  readonly socket: BridgeSocket;
  readonly sessionId: string;
  readonly onError: SocketListener;
  readonly onEnd: SocketListener;
  readonly onClose: SocketListener;
  ready: boolean;
  healthy: boolean;
  closed: boolean;
  destroyed: boolean;
};
type ActivePublication = {
  readonly cancel: () => void;
};
type SessionMirrorObserverSocketSink = SessionMirrorObserverSink & {
  shutdown: () => void;
};

export interface SessionMirrorObserverSocketSinkOptions {
  readonly bridgeDirectory?: unknown;
  readonly deadlineMs?: unknown;
  readonly sourceInstanceId?: unknown;
  readonly controls?: unknown;
}

function controls(value: unknown): object {
  const result = option(value, "controls");
  return result !== null && typeof result === "object" ? result : {};
}
function isConnection(value: unknown): value is ConnectionFactory {
  return typeof value === "function";
}
function isSchedule(value: unknown): value is Schedule {
  return typeof value === "function";
}
function isClearTimer(value: unknown): value is ClearTimer {
  return typeof value === "function";
}
function connectionFactory(value: unknown): ConnectionFactory {
  const result = option(value, "createConnection");
  return isConnection(result) ? result : (input) => createConnection(input);
}
function schedule(value: unknown): Schedule {
  const result = option(value, "setTimeout");
  return isSchedule(result) ? result : setTimeout;
}
function clearTimer(value: unknown): ClearTimer {
  const result = option(value, "clearTimeout");
  return isClearTimer(result) ? result : clearTimeout;
}
function bestEffort(action: () => void): void {
  try {
    action();
  } catch {}
}
function hasMethod(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object") return false;
  try {
    let current: object | null = value;
    for (let depth = 0; current !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor)
        return Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function";
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return false;
  }
  return false;
}
function isBridgeSocket(value: unknown): value is BridgeSocket {
  if (value === null || typeof value !== "object") return false;
  return ["once", "on", "removeListener", "write", "destroy", "pause", "resume"].every((key) =>
    hasMethod(value, key),
  );
}
function remove(socket: BridgeSocket, event: string, listener: SocketListener): void {
  bestEffort(() => socket.removeListener(event, listener));
}
function waitConnect(socket: BridgeSocket, register: Cancel): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const connected = () => finish(true);
    const failed = () => finish(false);
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      remove(socket, "connect", connected);
      for (const event of FAILURE_EVENTS) remove(socket, event, failed);
      if (ok) resolve();
      else reject(new Error(FAILURE));
    };
    register(() => finish(false));
    try {
      socket.once("connect", connected);
      for (const event of FAILURE_EVENTS) if (!done) socket.once(event, failed);
    } catch {
      finish(false);
    }
  });
}
function writeFrame(socket: BridgeSocket, bytes: Uint8Array, register: Cancel): Promise<void> {
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
    const finish = (ok: boolean) => {
      if (done || (ok && (!returned || !callbackDone || !drainDone))) return;
      done = true;
      for (const event of FAILURE_EVENTS) remove(socket, event, failed);
      remove(socket, "drain", drained);
      if (ok) resolve();
      else reject(new Error(FAILURE));
    };
    register(() => finish(false));
    try {
      for (const event of FAILURE_EVENTS) if (!done) socket.once(event, failed);
      const written = (error?: unknown) => {
        if (error !== undefined && error !== null) return finish(false);
        callbackDone = true;
        finish(true);
      };
      if (done) return;
      drainDone = socket.write(Buffer.from(bytes), written);
      returned = true;
      if (!drainDone) socket.once("drain", drained);
      finish(true);
    } catch {
      finish(false);
    }
  });
}
function readFrame(socket: BridgeSocket, maximum: number, register: Cancel): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let expected = -1;
    let done = false;
    const failed = () => finish();
    const finish = (value?: Uint8Array) => {
      if (done) return;
      done = true;
      bestEffort(() => socket.pause());
      remove(socket, "data", received);
      for (const event of FAILURE_EVENTS) remove(socket, event, failed);
      if (value === undefined) reject(new Error(FAILURE));
      else resolve(value);
    };
    const received = (chunk: unknown) => {
      try {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > maximum + 4) return finish();
        if (bytes.length + chunk.byteLength > maximum + 4) return finish();
        bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
        if (expected < 0 && bytes.length >= 4) {
          expected = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
          if (expected > maximum) return finish();
        }
        if (expected >= 0 && bytes.length >= expected + 4) {
          if (bytes.length !== expected + 4) return finish();
          finish(bytes.subarray(4));
        }
      } catch {
        finish();
      }
    };
    register(() => finish());
    try {
      for (const event of FAILURE_EVENTS) if (!done) socket.once(event, failed);
      if (!done) socket.on("data", received);
      if (!done) socket.resume();
    } catch {
      finish();
    }
  });
}
export function createSessionMirrorObserverSocketSink(
  options: SessionMirrorObserverSocketSinkOptions = {},
): SessionMirrorObserverSink {
  const injected = controls(options);
  const clear = clearTimer(injected);
  const connect = connectionFactory(injected);
  const configuredSourceId = sourceInstanceId(option(options, "sourceInstanceId"));
  let retained: SocketRecord | undefined;
  let activePublication: ActivePublication | undefined;
  let publicationRunning = false;
  let closed = false;

  const destroyRecord = (record: SocketRecord): void => {
    if (record.destroyed || record.closed) return;
    record.destroyed = true;
    bestEffort(() => record.socket.destroy());
  };

  const retireRecord = (record: SocketRecord): void => {
    record.healthy = false;
    if (retained === record) retained = undefined;
    destroyRecord(record);
  };

  const healthyRecord = (record: SocketRecord | undefined): record is SocketRecord =>
    record !== undefined && retained === record && record.ready && record.healthy && !record.closed;

  function publishOne(envelope: SessionMirrorSnapshotProjectionEnvelope): Promise<void> {
    if (closed) return Promise.reject(new Error(FAILURE));

    return new Promise((resolve, reject) => {
      let record: SocketRecord | undefined;
      let timer: TimerHandle | undefined;
      let fallbackTimer: TimerHandle | undefined;
      let pendingCancel: (() => void) | undefined;
      let invalidOnFailure = false;
      let settled = false;
      let operation: ActivePublication;
      const register: Cancel = (cancel) => (pendingCancel = cancel);
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        bestEffort(() => pendingCancel?.());
        pendingCancel = undefined;
        bestEffort(() => timer === undefined || clear(timer));
        bestEffort(() => fallbackTimer === undefined || clearTimeout(fallbackTimer));
        const successful = ok && !closed && healthyRecord(record);
        if (!successful && record !== undefined && (invalidOnFailure || closed)) {
          retireRecord(record);
        }
        if (activePublication === operation) activePublication = undefined;
        if (successful) resolve();
        else reject(new Error(FAILURE));
      };
      operation = { cancel: () => finish(false) };
      activePublication = operation;

      const attach = (socket: BridgeSocket, sessionId: string): SocketRecord => {
        let record: SocketRecord | undefined;
        const onError: SocketListener = () => {
          if (record !== undefined) retireRecord(record);
        };
        const onEnd: SocketListener = () => {
          if (record !== undefined) retireRecord(record);
        };
        const onClose: SocketListener = () => {
          if (record === undefined) return;
          record.healthy = false;
          record.closed = true;
          if (retained === record) retained = undefined;
          remove(record.socket, "error", record.onError);
          remove(record.socket, "end", record.onEnd);
        };
        record = {
          socket,
          sessionId,
          onError,
          onEnd,
          onClose,
          ready: false,
          healthy: true,
          closed: false,
          destroyed: false,
        };
        retained = record;
        try {
          if (settled || closed) throw new Error(FAILURE);
          socket.on("error", onError);
          if (settled || closed) throw new Error(FAILURE);
          socket.once("end", onEnd);
          socket.once("close", onClose);
          if (hasMethod(socket, "unref")) bestEffort(() => socket.unref?.());
          if (settled || closed) throw new Error(FAILURE);
        } catch {
          retireRecord(record);
          throw new Error(FAILURE);
        }
        return record;
      };

      const connectAndHandshake = async (sessionId: string): Promise<SocketRecord> => {
        if (settled || closed) throw new Error(FAILURE);
        const directory = validPath(option(options, "bridgeDirectory"));
        const rendezvous = directory && readRendezvous(directory, injected);
        const path = rendezvous && socketPath(directory, rendezvous.socketName);
        if (settled || closed || !rendezvous || !path) throw new Error(FAILURE);
        if (settled || closed || !socketIsSafe(path, injected)) throw new Error(FAILURE);
        if (settled || closed) throw new Error(FAILURE);

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
        if (!helloFrame || helloFrame.byteLength - 4 > MAX_CONTROL_BYTES) throw new Error(FAILURE);

        const candidate: unknown = connect({ path });
        if (!isBridgeSocket(candidate)) throw new Error(FAILURE);
        if (settled || closed) {
          bestEffort(() => candidate.destroy());
          throw new Error(FAILURE);
        }
        record = attach(candidate, sessionId);
        const current = record;
        await waitConnect(current.socket, register);
        if (settled || closed || !current.healthy || current.closed) throw new Error(FAILURE);
        await writeFrame(current.socket, helloFrame, register);
        if (settled || closed || !current.healthy || current.closed) throw new Error(FAILURE);
        const ready = parseResult(await readFrame(current.socket, MAX_CONTROL_BYTES, register));
        if (settled || closed || !current.healthy || current.closed || ready !== "ready")
          throw new Error(FAILURE);
        current.ready = true;
        return current;
      };

      void (async () => {
        try {
          const timeoutValue = option(options, "deadlineMs");
          const timeout =
            typeof timeoutValue === "number" && Number.isFinite(timeoutValue) && timeoutValue >= 0
              ? Math.min(timeoutValue, SESSION_MIRROR_OBSERVER_SINK_DEADLINE_MS)
              : SESSION_MIRROR_OBSERVER_SINK_DEADLINE_MS;
          timer = schedule(injected)(() => finish(false), timeout);
          if (hasMethod(timer, "unref")) bestEffort(() => timer?.unref?.());
          if (settled) return;
          fallbackTimer = setTimeout(() => finish(false), timeout);
          bestEffort(() => fallbackTimer?.unref?.());

          const sessionId = validIdentity(option(envelope, "sessionId"));
          if (!sessionId || !configuredSourceId) return finish(false);
          const data = json(envelope);
          const dataFrame = data && frame(data);
          if (settled || closed || !dataFrame) return finish(false);

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
          if (settled || closed) return finish(false);
          if (record === undefined) {
            record = await connectAndHandshake(sessionId);
          }
          if (settled || closed || !healthyRecord(record)) return finish(false);
          await writeFrame(record.socket, dataFrame, register);
          if (settled || closed || !healthyRecord(record)) return finish(false);
          const result = parseResult(await readFrame(record.socket, MAX_CONTROL_BYTES, register));
          if (result !== "accepted" && result !== "duplicate" && result !== "deduplicated")
            throw new Error(FAILURE);
          finish(true);
        } catch {
          finish(false);
        }
      })();
    });
  }

  const publish = (envelope: SessionMirrorSnapshotProjectionEnvelope): Promise<void> => {
    if (closed || publicationRunning) return Promise.reject(new Error(FAILURE));
    publicationRunning = true;
    let publication: Promise<void>;
    try {
      publication = publishOne(envelope);
    } catch {
      publication = Promise.reject(new Error(FAILURE));
    }
    return publication.then(
      () => {
        publicationRunning = false;
      },
      (error: unknown) => {
        publicationRunning = false;
        throw error;
      },
    );
  };

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    activePublication?.cancel();
    const current = retained;
    if (current !== undefined) retireRecord(current);
  };

  const sink = Object.assign(publish, { shutdown }) as SessionMirrorObserverSocketSink;
  return Object.freeze(sink);
}
