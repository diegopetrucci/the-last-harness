import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SESSION_MIRROR_OBSERVER_SINK_MAX_CONTROL_BYTES,
  SESSION_MIRROR_OBSERVER_SINK_MAX_FRAME_BYTES,
  createSessionMirrorObserverSocketSink,
} = await jiti.import("../extensions/the-last-harness/session-mirror/local-bridge-sink.ts");

const PROTOCOL = { family: "local-bridge", major: 0, minor: 0 };
const TOKEN = "b".repeat(32);
const SOCKET_NAME = `mirror-${"a".repeat(24)}.sock`;

function makeFixture(t, bridgeName = "companion") {
  const root = mkdtempSync(join(realpathSync("/tmp"), "tlh-b-"));
  const bridge = join(root, bridgeName);
  mkdirSync(bridge, { recursive: true });
  chmodSync(root, 0o700);
  chmodSync(bridge, 0o700);
  const rendezvousPath = join(bridge, "rendezvous.json");
  writeFileSync(
    rendezvousPath,
    JSON.stringify({
      protocol: PROTOCOL,
      installationId: "installation-under-test",
      socketName: SOCKET_NAME,
      launchToken: TOKEN,
    }),
  );
  chmodSync(rendezvousPath, 0o600);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, bridge, rendezvousPath, socketPath: join(bridge, SOCKET_NAME) };
}

function encode(body) {
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

async function startBridge(t, fixture, onBody) {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (pending.length < length + 4) break;
        const body = pending.subarray(4, length + 4);
        pending = pending.subarray(length + 4);
        onBody(socket, body);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(fixture.socketPath);
  });
  chmodSync(fixture.socketPath, 0o600);
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  );
  return server;
}

function result(code, extra = {}) {
  return encode(Buffer.from(JSON.stringify({ kind: "result", code, ...extra })));
}

function respondInChunks(socket, frame) {
  socket.write(frame.subarray(0, 2));
  setImmediate(() => socket.write(frame.subarray(2)));
}

function envelope(payload = "payload", sessionId = "session-under-test") {
  return { sessionId, payload };
}

function inertSocket() {
  const socket = new EventEmitter();
  socket.write = () => true;
  socket.destroy = () => {};
  socket.pause = () => {};
  socket.resume = () => {};
  return socket;
}

test("retains one healthy producer connection for serialized publications", async (t) => {
  const fixture = makeFixture(t);
  const bodies = [];
  const sockets = new Set();
  const sink = createSessionMirrorObserverSocketSink({ bridgeDirectory: fixture.bridge });
  t.after(() => sink.shutdown());
  await startBridge(t, fixture, (socket, body) => {
    sockets.add(socket);
    bodies.push(JSON.parse(body));
    const response =
      bodies.at(-1).kind === "hello"
        ? result("ready", { bridgeRevision: 1, sourceEpoch: 1, snapshotRequired: true })
        : result("accepted", { bridgeRevision: 2, sourceEpoch: 1 });
    respondInChunks(socket, response);
  });

  await sink(envelope());
  await sink(envelope("second"));

  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].kind, "hello");
  assert.match(bodies[0].sourceInstanceId, /^[a-f0-9]{32}$/);
  assert.equal(bodies[0].installationId, "installation-under-test");
  assert.equal(bodies[0].launchToken, TOKEN);
  assert.deepEqual(bodies[0].capabilities, ["snapshot-replace", "cursor-recovery"]);
  assert.notEqual(bodies[1].kind, "hello");
  assert.notEqual(bodies[2].kind, "hello");
  assert.equal(sockets.size, 1);
});

test("rejects concurrent publication immediately without retaining or later sending it", async (t) => {
  const fixture = makeFixture(t);
  const bodies = [];
  let releaseFirst;
  const firstResponse = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let resolveSnapshot;
  const snapshotSeen = new Promise((resolve) => {
    resolveSnapshot = resolve;
  });
  const sink = createSessionMirrorObserverSocketSink({ bridgeDirectory: fixture.bridge });
  t.after(() => sink.shutdown());
  await startBridge(t, fixture, (socket, body) => {
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    if (parsed.kind === "hello") {
      respondInChunks(
        socket,
        result("ready", { bridgeRevision: 1, sourceEpoch: 1, snapshotRequired: false }),
      );
      return;
    }
    resolveSnapshot();
    void firstResponse.then(() =>
      respondInChunks(socket, result("accepted", { bridgeRevision: 2, sourceEpoch: 1 })),
    );
  });

  const first = sink(envelope("first"));
  await snapshotSeen;
  await assert.rejects(sink(envelope("second")));
  assert.equal(bodies.filter((body) => body.kind !== "hello").length, 1);
  releaseFirst();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bodies.filter((body) => body.kind !== "hello").length, 1);
});

test("reconnects after a remote close with the same opaque source identity", async (t) => {
  const fixture = makeFixture(t);
  const bodies = [];
  const sockets = [];
  const clientSockets = [];
  const sink = createSessionMirrorObserverSocketSink({
    bridgeDirectory: fixture.bridge,
    controls: {
      createConnection: (options) => {
        const socket = createConnection(options);
        clientSockets.push(socket);
        return socket;
      },
    },
  });
  t.after(() => sink.shutdown());
  await startBridge(t, fixture, (socket, body) => {
    if (!sockets.includes(socket)) sockets.push(socket);
    const parsed = JSON.parse(body);
    respondInChunks(
      socket,
      parsed.kind === "hello"
        ? result("ready", { bridgeRevision: 1, sourceEpoch: 1, snapshotRequired: true })
        : result("accepted", { bridgeRevision: 2, sourceEpoch: 1 }),
    );
    bodies.push(parsed);
  });

  await sink(envelope());
  assert.equal(sockets.length, 1);
  const remoteClose = new Promise((resolve) => clientSockets[0].once("close", resolve));
  sockets[0].destroy();
  await remoteClose;
  await new Promise((resolve) => setImmediate(resolve));
  await sink(envelope("second"));

  const hellos = bodies.filter((body) => body.kind === "hello");
  assert.equal(sockets.length, 2);
  assert.equal(hellos.length, 2);
  assert.equal(hellos[0].sourceInstanceId, hellos[1].sourceInstanceId);
});

test("retires a retained socket on session mismatch and recovers with a fresh connection", async (t) => {
  const fixture = makeFixture(t);
  const bodies = [];
  const sockets = [];
  const sink = createSessionMirrorObserverSocketSink({ bridgeDirectory: fixture.bridge });
  t.after(() => sink.shutdown());
  await startBridge(t, fixture, (socket, body) => {
    if (!sockets.includes(socket)) sockets.push(socket);
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    respondInChunks(
      socket,
      parsed.kind === "hello"
        ? result("ready", { bridgeRevision: 1, sourceEpoch: 1, snapshotRequired: false })
        : result("accepted", { bridgeRevision: 2, sourceEpoch: 1 }),
    );
  });

  await sink(envelope("first", "first-session"));
  await assert.rejects(sink(envelope("mismatch", "second-session")));
  await sink(envelope("recovered", "second-session"));

  const hellos = bodies.filter((body) => body.kind === "hello");
  assert.equal(sockets.length, 2);
  assert.equal(hellos.length, 2);
  assert.equal(hellos[0].sessionId, "first-session");
  assert.equal(hellos[1].sessionId, "second-session");
  assert.equal(hellos[0].sourceInstanceId, hellos[1].sourceInstanceId);
  assert.equal(bodies.filter((body) => body.kind !== "hello").length, 2);
});

test("shutdown cancels the pending publication and destroys its socket once", async (t) => {
  const fixture = makeFixture(t);
  await startBridge(t, fixture, () => {});
  const socket = inertSocket();
  let destroys = 0;
  socket.destroy = () => {
    destroys += 1;
  };
  let primaryTimer;
  let clearCalls = 0;
  let connections = 0;
  const sink = createSessionMirrorObserverSocketSink({
    bridgeDirectory: fixture.bridge,
    deadlineMs: 100,
    controls: {
      createConnection: () => {
        connections += 1;
        return socket;
      },
      setTimeout: (callback) => {
        primaryTimer = { unref() {} };
        primaryTimer.callback = callback;
        return primaryTimer;
      },
      clearTimeout: () => {
        clearCalls += 1;
      },
    },
  });

  const publication = sink(envelope());
  assert.equal(connections, 1);
  sink.shutdown();
  assert.equal(destroys, 1);
  assert.equal(clearCalls, 1);
  primaryTimer.callback();
  await assert.rejects(publication);

  sink.shutdown();
  assert.equal(destroys, 1);
  await assert.rejects(sink(envelope("after-shutdown")));
  assert.equal(connections, 1);
  socket.emit("close");
});

test("rejects malformed, unknown, closed, and oversized bridge result frames", async (t) => {
  const cases = [
    [
      "duplicate result key",
      encode(
        Buffer.from(
          '{"kind":"result","code":"ready","code":"accepted","bridgeRevision":1,"sourceEpoch":1,"snapshotRequired":false}',
        ),
      ),
    ],
    ["unknown result code", encode(Buffer.from('{"kind":"result","code":"unknown"}'))],
    ["closed result", result("closed")],
    [
      "oversized control frame",
      encode(Buffer.alloc(SESSION_MIRROR_OBSERVER_SINK_MAX_CONTROL_BYTES + 1)),
    ],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async (nested) => {
      const fixture = makeFixture(nested);
      await startBridge(nested, fixture, (socket) => respondInChunks(socket, response));
      await assert.rejects(
        createSessionMirrorObserverSocketSink({ bridgeDirectory: fixture.bridge, deadlineMs: 100 })(
          envelope(),
        ),
      );
    });
  }
});

test("accepts an exact 256 KiB body and rejects an oversized body before connecting", async (t) => {
  const fixture = makeFixture(t);
  const bodies = [];
  const sink = createSessionMirrorObserverSocketSink({ bridgeDirectory: fixture.bridge });
  t.after(() => sink.shutdown());
  await startBridge(t, fixture, (socket, body) => {
    bodies.push(body);
    respondInChunks(
      socket,
      body[0] === 123 && JSON.parse(body).kind === "hello"
        ? result("ready", { bridgeRevision: 1, sourceEpoch: 1, snapshotRequired: false })
        : result("accepted", { bridgeRevision: 2, sourceEpoch: 1 }),
    );
  });
  const prefix = Buffer.byteLength(JSON.stringify(envelope("")), "utf8");
  const exact = envelope("x".repeat(SESSION_MIRROR_OBSERVER_SINK_MAX_FRAME_BYTES - prefix));
  assert.equal(
    Buffer.byteLength(JSON.stringify(exact), "utf8"),
    SESSION_MIRROR_OBSERVER_SINK_MAX_FRAME_BYTES,
  );
  await sink(exact);
  assert.equal(bodies[1].length, SESSION_MIRROR_OBSERVER_SINK_MAX_FRAME_BYTES);

  await assert.rejects(
    createSessionMirrorObserverSocketSink({ bridgeDirectory: fixture.bridge })(
      envelope("x".repeat(SESSION_MIRROR_OBSERVER_SINK_MAX_FRAME_BYTES - prefix + 1)),
    ),
  );
  assert.equal(bodies.length, 2, "oversized data must not reach the bridge");
});

test("fails open on absent, malformed, symlinked, private-mode, and overlong bridge boundaries", async (t) => {
  const missing = makeFixture(t);
  rmSync(missing.bridge, { recursive: true, force: true });
  await assert.rejects(
    createSessionMirrorObserverSocketSink({ bridgeDirectory: missing.bridge })(envelope()),
  );

  const malformed = makeFixture(t);
  writeFileSync(
    malformed.rendezvousPath,
    `{"protocol":${JSON.stringify(PROTOCOL)},"protocol":${JSON.stringify(PROTOCOL)},"installationId":"x","socketName":"${SOCKET_NAME}","launchToken":"${TOKEN}"}`,
  );
  chmodSync(malformed.rendezvousPath, 0o600);
  await assert.rejects(
    createSessionMirrorObserverSocketSink({ bridgeDirectory: malformed.bridge })(envelope()),
  );

  const symlinked = makeFixture(t);
  const target = join(symlinked.root, "real-rendezvous.json");
  writeFileSync(target, "{}", "utf8");
  chmodSync(target, 0o600);
  rmSync(symlinked.rendezvousPath);
  symlinkSync(target, symlinked.rendezvousPath);
  await assert.rejects(
    createSessionMirrorObserverSocketSink({ bridgeDirectory: symlinked.bridge })(envelope()),
  );

  const privateMode = makeFixture(t);
  chmodSync(privateMode.bridge, 0o755);
  await assert.rejects(
    createSessionMirrorObserverSocketSink({ bridgeDirectory: privateMode.bridge })(envelope()),
  );

  const overlong = makeFixture(t, `companion-${"x".repeat(55)}`);
  await assert.rejects(
    createSessionMirrorObserverSocketSink({ bridgeDirectory: overlong.bridge })(envelope()),
  );
});

test("bounds a stalled handshake and rejects hostile option/envelope accessors", async (t) => {
  const fixture = makeFixture(t);
  let frames = 0;
  await startBridge(t, fixture, () => {
    frames += 1;
  });
  await assert.rejects(
    createSessionMirrorObserverSocketSink({ bridgeDirectory: fixture.bridge, deadlineMs: 20 })(
      envelope(),
    ),
  );
  assert.equal(frames, 1, "the hello is sent before the stalled handshake deadline");

  const fallbackFixture = makeFixture(t);
  await startBridge(t, fallbackFixture, () => {});
  await assert.rejects(
    createSessionMirrorObserverSocketSink({
      bridgeDirectory: fallbackFixture.bridge,
      deadlineMs: 20,
      controls: { setTimeout: () => undefined },
    })(envelope()),
  );

  const hostileOptions = new Proxy(
    { bridgeDirectory: fixture.bridge },
    {
      getOwnPropertyDescriptor() {
        throw new Error("SENTINEL_OPTION_ACCESS");
      },
    },
  );
  await assert.rejects(createSessionMirrorObserverSocketSink(hostileOptions)(envelope()));
  await assert.rejects(
    createSessionMirrorObserverSocketSink({
      bridgeDirectory: fixture.bridge,
      sourceInstanceId: Symbol("invalid-source"),
    })(envelope()),
  );

  const hostileEnvelope = new Proxy(envelope(), {
    getOwnPropertyDescriptor() {
      throw new Error("SENTINEL_ENVELOPE_ACCESS");
    },
  });
  await assert.rejects(
    createSessionMirrorObserverSocketSink({ bridgeDirectory: fixture.bridge })(hostileEnvelope),
  );
});

test("retains late-error containment until an inert socket closes", async (t) => {
  const fixture = makeFixture(t);
  await startBridge(t, fixture, () => {});
  const socket = inertSocket();
  await assert.rejects(
    createSessionMirrorObserverSocketSink({
      bridgeDirectory: fixture.bridge,
      deadlineMs: 20,
      controls: { createConnection: () => socket },
    })(envelope()),
  );
  assert.equal(socket.listenerCount("error"), 1);
  assert.equal(socket.listenerCount("close"), 1);
  assert.doesNotThrow(() => socket.emit("error", new Error("late socket error")));
  socket.emit("close");
  assert.equal(socket.listenerCount("error"), 0);
  assert.equal(socket.listenerCount("close"), 0);
});

test("unrefs the primary timer returned by the selected scheduler", async (t) => {
  const fixture = makeFixture(t);
  await startBridge(t, fixture, () => {});
  const socket = inertSocket();
  let primaryTimer;
  const publication = createSessionMirrorObserverSocketSink({
    bridgeDirectory: fixture.bridge,
    deadlineMs: 20,
    controls: {
      createConnection: () => socket,
      setTimeout: (callback, delay) => {
        primaryTimer = setTimeout(callback, delay);
        return primaryTimer;
      },
    },
  })(envelope());
  assert.ok(primaryTimer);
  assert.equal(primaryTimer.hasRef(), false);
  await assert.rejects(publication);
  socket.emit("close");
});
