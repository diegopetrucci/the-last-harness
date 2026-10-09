export type SocketListener = (...args: readonly unknown[]) => void;
export type BridgeSocket = {
  once(event: string, listener: SocketListener): void;
  on(event: string, listener: SocketListener): void;
  removeListener(event: string, listener: SocketListener): void;
  write(data: Uint8Array, callback: SocketListener): boolean;
  destroy(): void;
  pause(): void;
  resume(): void;
  unref?: () => void;
};
export type Cancel = (cancel: () => void) => void;

export const FAILURE_EVENTS = ["error", "end", "close"] as const;

export function bestEffort(action: () => void): void {
  try {
    action();
  } catch {}
}

export function hasMethod(value: unknown, key: string): boolean {
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

export function isBridgeSocket(value: unknown): value is BridgeSocket {
  if (value === null || typeof value !== "object") return false;
  return ["once", "on", "removeListener", "write", "destroy", "pause", "resume"].every((key) =>
    hasMethod(value, key),
  );
}

export function remove(socket: BridgeSocket, event: string, listener: SocketListener): void {
  bestEffort(() => socket.removeListener(event, listener));
}

export function waitConnect(
  socket: BridgeSocket,
  register: Cancel,
  failure: string,
): Promise<void> {
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
      else reject(new Error(failure));
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

export function writeFrame(
  socket: BridgeSocket,
  bytes: Uint8Array,
  register: Cancel,
  failure: string,
): Promise<void> {
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
      else reject(new Error(failure));
    };
    register(() => finish(false));
    try {
      for (const event of FAILURE_EVENTS) if (!done) socket.once(event, failed);
      const written: SocketListener = (error?: unknown) => {
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
