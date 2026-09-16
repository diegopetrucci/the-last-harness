import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionMirrorReplyChannel } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/local-bridge-reply-channel.ts",
);
const { frame, json } = await jiti.import(
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
  const directory = mkdtempSync("/private/tmp/tlh-r-");
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
          socket.write(
            frameBytes({
              kind: "result",
              code: "ready",
              bridgeRevision: 0,
              sourceEpoch,
              snapshotRequired: false,
            }),
          );
          if (sendRequest) {
            setTimeout(
              () =>
                socket.write(
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
                ),
              10,
            );
          }
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
