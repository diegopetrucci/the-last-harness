import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionMirrorReplyChannel } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/local-bridge-reply-channel.ts",
);
const { frame, json, MAX_CONTROL_BYTES } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/local-bridge-boundary.ts",
);

const INSTALLATION_ID = "synthetic-installation";
const SESSION_ID = "synthetic-session";
const SOURCE_INSTANCE_ID = "b".repeat(32);
const LAUNCH_TOKEN = "c".repeat(32);
const SOCKET_NAME = `mirror-${"d".repeat(24)}.sock`;

function frameBytes(value) {
  const body = json(value);
  const result = body && frame(body);
  assert.ok(result);
  return result;
}

function createServer(t, { sourceEpoch = 4, sendRequest = true } = {}) {
  const directory = mkdtempSync(join(realpathSync("/tmp"), "tlh-r-"));
  const socketPath = join(directory, SOCKET_NAME);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(
    join(directory, "rendezvous.json"),
    `${JSON.stringify({
      protocol: { family: "local-bridge", major: 0, minor: 0 },
      installationId: INSTALLATION_ID,
      socketName: SOCKET_NAME,
      launchToken: LAUNCH_TOKEN,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const frames = [];
  let resolveCloseFrame;
  const closeFramePromise = new Promise((resolve) => {
    resolveCloseFrame = resolve;
  });
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0);
        if (buffered.length < length + 4) return;
        const body = buffered.subarray(4, length + 4);
        buffered = buffered.subarray(length + 4);
        const value = JSON.parse(body.toString("utf8"));
        frames.push(value);
        if (value.kind === "reply-close") resolveCloseFrame(value);
        if (value.kind === "reply-hello") {
          const ready = frameBytes({
            kind: "result",
            code: "ready",
            bridgeRevision: 0,
            sourceEpoch,
            snapshotRequired: false,
          });
          const framesToSend = [ready];
          if (sendRequest) {
            framesToSend.push(
              frameBytes({
                kind: "reply",
                requestId: "request-1",
                generation: 1,
                branchId: "branch-1",
                leafId: "leaf-1",
                sourceRevision: 7,
                ttlSeconds: 30,
                text: "hello from bridge",
              }),
            );
          }
          socket.write(Buffer.concat(framesToSend.map((bytes) => Buffer.from(bytes))));
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve({ directory, frames, closeFramePromise });
    });
  });
}

function createBridgeDirectory(t) {
  const directory = mkdtempSync(join(realpathSync("/tmp"), "tlh-r-"));
  const socketName = SOCKET_NAME;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(
    join(directory, "rendezvous.json"),
    `${JSON.stringify({
      protocol: { family: "local-bridge", major: 0, minor: 0 },
      installationId: INSTALLATION_ID,
      socketName,
      launchToken: LAUNCH_TOKEN,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

class SyntheticSocket extends EventEmitter {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
    this.paused = true;
    this.destroyed = false;
    this.pending = [];
    this.writes = [];
    queueMicrotask(() => {
      if (!this.destroyed) this.emit("connect");
    });
  }

  write(data, callback) {
    if (this.destroyed) {
      callback?.(new Error("destroyed"));
      return false;
    }
    const bytes = Buffer.from(data);
    this.writes.push(bytes);
    callback?.();
    this.onWrite?.(bytes, this);
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pending.length = 0;
    this.emit("close");
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.flush();
  }

  push(chunk) {
    if (this.destroyed) return;
    this.pending.push(chunk);
    this.flush();
  }

  flush() {
    while (!this.paused && !this.destroyed && this.pending.length > 0) {
      this.emit("data", this.pending.shift());
    }
  }
}

function createSyntheticChannel(t, chunks, { onRequest = () => "accepted", onClosed } = {}) {
  const directory = createBridgeDirectory(t);
  let helloSent = false;
  let socket;
  socket = new SyntheticSocket((bytes, current) => {
    if (helloSent || bytes.length < 4) return;
    helloSent = true;
    for (const chunk of chunks) current.push(chunk);
  });
  const channel = createSessionMirrorReplyChannel({
    bridgeDirectory: directory,
    sessionId: SESSION_ID,
    sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceEpoch: 4,
    generation: 3,
    deadlineMs: 1_000,
    controls: {
      createConnection: () => socket,
      fileSystem: {
        lstat: (path) =>
          path.endsWith(`/${SOCKET_NAME}`)
            ? { mode: 0o140600, uid: process.getuid() }
            : lstatSync(path),
      },
    },
    onRequest,
    onClosed,
  });
  return { channel, socket };
}

function replyFrameBytes(text = "hello from bridge", requestId = "request-1") {
  return frameBytes({
    kind: "reply",
    requestId,
    generation: 1,
    branchId: "branch-1",
    leafId: "leaf-1",
    sourceRevision: 7,
    ttlSeconds: 30,
    text,
  });
}

function readyFrameBytes() {
  return frameBytes({
    kind: "result",
    code: "ready",
    bridgeRevision: 0,
    sourceEpoch: 4,
    snapshotRequired: false,
  });
}

test("reply channel negotiates minor 1, forwards bounded requests, and tears down with a fixed close frame", async (t) => {
  const { directory, frames, closeFramePromise } = await createServer(t);
  let closed = 0;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let resolveReceived;
  const receivedPromise = new Promise((resolve) => {
    resolveReceived = resolve;
  });
  let received;
  const channel = createSessionMirrorReplyChannel({
    bridgeDirectory: directory,
    sessionId: SESSION_ID,
    sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceEpoch: 4,
    generation: 3,
    onRequest: (request) => {
      received = request;
      resolveReceived();
      return "accepted";
    },
    onClosed: () => {
      closed += 1;
      resolveClosed();
    },
  });

  assert.equal(await channel.open(), true);
  assert.equal(channel.getState(), "open");
  await receivedPromise;
  assert.equal(received?.text, "hello from bridge");
  channel.close("listener-stop");
  await closedPromise;
  await closeFramePromise;
  assert.equal(closed, 1);
  assert.equal(channel.getState(), "closed");
  assert.equal(frames[0]?.kind, "reply-hello");
  assert.equal(frames[0]?.sourceEpoch, 4);
  assert.equal(frames[0]?.generation, 3);
  assert.deepEqual(frames.at(-1), { kind: "reply-close", reason: "listener-stop" });
});

test("reply channel consumes fragmented and coalesced frames without timing gaps", async (t) => {
  const ready = readyFrameBytes();
  const reply = replyFrameBytes();
  const bodySplit = 4 + Math.floor((ready.length - 4) / 2);
  const chunks = [
    ready.subarray(0, 1),
    ready.subarray(1, bodySplit),
    Buffer.concat([Buffer.from(ready.subarray(bodySplit)), Buffer.from(reply.subarray(0, 2))]),
    reply.subarray(2),
  ];
  let resolveReceived;
  const receivedPromise = new Promise((resolve) => {
    resolveReceived = resolve;
  });
  let received;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const { channel } = createSyntheticChannel(t, chunks, {
    onRequest: (request) => {
      received = request;
      resolveReceived();
      return "accepted";
    },
    onClosed: resolveClosed,
  });

  assert.equal(await channel.open(), true);
  await receivedPromise;
  assert.equal(received?.text, "hello from bridge");
  channel.close("listener-stop");
  await closedPromise;
  assert.equal(channel.getState(), "closed");
});

test("reply channel fails closed for malformed, per-frame oversize, and non-byte input", async (t) => {
  const malformed = Buffer.from([0, 0, 0, 1, 0]);
  const oversize = Buffer.alloc(4);
  oversize.writeUInt32BE(MAX_CONTROL_BYTES + 1, 0);
  for (const chunk of [malformed, oversize, "not bytes"]) {
    const { channel } = createSyntheticChannel(t, [chunk]);
    assert.equal(await channel.open(), false);
    assert.equal(channel.getState(), "closed");
  }
});

test("reply channel accepts the exact aggregate receive cap and rejects one byte over it", async (t) => {
  const aggregateLimit = (MAX_CONTROL_BYTES + 4) * 2;
  const ready = Buffer.from(readyFrameBytes());
  const reply = Buffer.from(replyFrameBytes());
  const fillerLength = aggregateLimit - ready.length - reply.length;
  assert.ok(fillerLength >= 4);
  const makeChunk = (extraBytes) => {
    const filler = Buffer.alloc(fillerLength + extraBytes);
    filler.writeUInt32BE(MAX_CONTROL_BYTES + 1, 0);
    return Buffer.concat([ready, reply, filler]);
  };

  let exactRequests = 0;
  let resolveExactRequest;
  const exactRequest = new Promise((resolve) => {
    resolveExactRequest = resolve;
  });
  let resolveExactClosed;
  const exactClosed = new Promise((resolve) => {
    resolveExactClosed = resolve;
  });
  const exact = createSyntheticChannel(t, [makeChunk(0)], {
    onRequest: () => {
      exactRequests += 1;
      resolveExactRequest();
      return "accepted";
    },
    onClosed: resolveExactClosed,
  });
  assert.equal(makeChunk(0).length, aggregateLimit);
  assert.equal(await exact.channel.open(), true);
  await exactRequest;
  await exactClosed;
  assert.equal(exactRequests, 1);

  let overLimitRequests = 0;
  let resolveOverLimitClosed;
  const overLimitClosed = new Promise((resolve) => {
    resolveOverLimitClosed = resolve;
  });
  const overLimit = createSyntheticChannel(t, [makeChunk(1)], {
    onRequest: () => {
      overLimitRequests += 1;
      return "accepted";
    },
    onClosed: resolveOverLimitClosed,
  });
  assert.equal(makeChunk(1).length, aggregateLimit + 1);
  assert.equal(await overLimit.channel.open(), false);
  await overLimitClosed;
  assert.equal(overLimitRequests, 0);
});

test("reply channel clears buffered successors when a request is cancelled by close", async (t) => {
  const ready = Buffer.from(readyFrameBytes());
  const firstReply = Buffer.from(replyFrameBytes("first", "request-1"));
  const secondReply = Buffer.from(replyFrameBytes("second", "request-2"));
  let releaseRequest;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let requestCount = 0;
  const { channel, socket } = createSyntheticChannel(
    t,
    [Buffer.concat([ready, firstReply, secondReply])],
    {
      onRequest: (request) => {
        requestCount += 1;
        resolveStarted(request);
        return new Promise((resolve) => {
          releaseRequest = () => resolve("accepted");
        });
      },
      onClosed: resolveClosed,
    },
  );

  assert.equal(await channel.open(), true);
  const firstRequest = await started;
  assert.equal(firstRequest.text, "first");
  channel.close("listener-stop");
  releaseRequest();
  await closed;
  assert.equal(requestCount, 1);
  const writtenKinds = socket.writes.map((bytes) => {
    const length = bytes.readUInt32BE(0);
    return JSON.parse(bytes.subarray(4, length + 4).toString("utf8")).kind;
  });
  assert.deepEqual(writtenKinds, ["reply-hello", "reply-close"]);
});

test("reply channel cancels a pending fragmented successor without delivering it", async (t) => {
  const ready = Buffer.from(readyFrameBytes());
  const reply = Buffer.from(replyFrameBytes());
  let requestCount = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const { channel, socket } = createSyntheticChannel(
    t,
    [Buffer.concat([ready, reply.subarray(0, 2)])],
    {
      onRequest: () => {
        requestCount += 1;
        return "accepted";
      },
      onClosed: resolveClosed,
    },
  );

  assert.equal(await channel.open(), true);
  channel.close("listener-stop");
  socket.push(reply.subarray(2));
  await closed;
  assert.equal(requestCount, 0);
  assert.equal(channel.getState(), "closed");
});

test("reply channel does not start after an inline handshake deadline", async (t) => {
  const { directory } = await createServer(t, { sendRequest: false });
  let connections = 0;
  const channel = createSessionMirrorReplyChannel({
    bridgeDirectory: directory,
    sessionId: SESSION_ID,
    sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceEpoch: 4,
    generation: 3,
    controls: {
      setTimeout: (task) => {
        task();
        return 1;
      },
      clearTimeout: () => {},
      createConnection: () => {
        connections += 1;
        throw new Error("connection should not start after timeout");
      },
    },
    onRequest: () => "accepted",
  });

  assert.equal(await channel.open(), false);
  assert.equal(connections, 0);
  assert.equal(channel.getState(), "closed");
});

test("reply channel rejects a mismatched ready source epoch without affecting the rendezvous", async (t) => {
  const { directory } = await createServer(t, { sourceEpoch: 5, sendRequest: false });
  let closed = 0;
  const channel = createSessionMirrorReplyChannel({
    bridgeDirectory: directory,
    sessionId: SESSION_ID,
    sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceEpoch: 4,
    generation: 3,
    onRequest: () => "accepted",
    onClosed: () => {
      closed += 1;
    },
  });

  assert.equal(await channel.open(), false);
  assert.equal(channel.getState(), "closed");
  assert.equal(closed, 1);
});
