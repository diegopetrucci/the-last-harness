import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createJsonlWriter,
  type DrainableSource,
  type JsonlWriteStream,
} from "../../src/shared/jsonl-writer.ts";

class MockSource implements DrainableSource {
  paused = 0;
  resumed = 0;
  pause(): void {
    this.paused++;
  }
  resume(): void {
    this.resumed++;
  }
}

class MockStream implements JsonlWriteStream {
  writes: string[] = [];
  ended = false;
  private drainHandler?: () => void;
  private readonly writeResults: boolean[];
  constructor(writeResults: boolean[] = []) {
    this.writeResults = writeResults;
  }
  write(chunk: string): boolean {
    this.writes.push(chunk);
    if (this.writeResults.length === 0) return true;
    return this.writeResults.shift() ?? true;
  }
  once(event: "drain", listener: () => void): JsonlWriteStream {
    if (event === "drain") this.drainHandler = listener;
    return this;
  }
  end(callback?: () => void): void {
    this.ended = true;
    callback?.();
  }
  emitDrain(): void {
    this.drainHandler?.();
  }
}

describe("createJsonlWriter", () => {
  it("writes lines with trailing newline", () => {
    const source = new MockSource();
    const stream = new MockStream();
    const writer = createJsonlWriter("/tmp/out.jsonl", source, {
      createWriteStream: () => stream,
    });
    writer.writeLine('{"type":"a"}');
    writer.writeLine('{"type":"b"}');
    assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
  });

  it("pauses on backpressure and resumes on drain", () => {
    const source = new MockSource();
    const stream = new MockStream([false, true]);
    const writer = createJsonlWriter("/tmp/out.jsonl", source, {
      createWriteStream: () => stream,
    });
    writer.writeLine('{"type":"a"}');
    assert.equal(source.paused, 1);
    assert.equal(source.resumed, 0);
    stream.emitDrain();
    assert.equal(source.resumed, 1);
    writer.writeLine('{"type":"b"}');
    assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
  });

  it("closes stream once", async () => {
    const source = new MockSource();
    const stream = new MockStream();
    const writer = createJsonlWriter("/tmp/out.jsonl", source, {
      createWriteStream: () => stream,
    });
    await writer.close();
    assert.equal(stream.ended, true);
    await writer.close();
    assert.equal(stream.ended, true);
  });

  it("returns no-op writer when file path is undefined", async () => {
    const source = new MockSource();
    const writer = createJsonlWriter(undefined, source);
    writer.writeLine('{"type":"a"}');
    await writer.close();
    assert.equal(source.paused, 0);
    assert.equal(source.resumed, 0);
  });

  it("stops writing when maxBytes exceeded without pausing source", () => {
    const source = new MockSource();
    const stream = new MockStream();
    const writer = createJsonlWriter("/tmp/out.jsonl", source, {
      createWriteStream: () => stream,
      maxBytes: 30,
    });
    writer.writeLine('{"type":"a"}');
    writer.writeLine('{"type":"b"}');
    writer.writeLine('{"type":"c"}');
    assert.equal(stream.writes.length, 2);
    assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
    assert.equal(source.paused, 0);
  });

  it("allows writes up to exactly maxBytes", () => {
    const source = new MockSource();
    const stream = new MockStream();
    const line = '{"x":"a"}';
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf-8");
    const writer = createJsonlWriter("/tmp/out.jsonl", source, {
      createWriteStream: () => stream,
      maxBytes: lineBytes * 2,
    });
    writer.writeLine(line);
    writer.writeLine(line);
    writer.writeLine(line);
    assert.equal(stream.writes.length, 2);
  });

  it("concurrent close() callers all await the same real completion", async () => {
    const source = new MockSource();
    let endCallCount = 0;
    let releaseEnd!: () => void;
    const stream = new (class extends MockStream {
      override end(callback?: () => void): void {
        endCallCount++;
        this.ended = true;
        // Store callback for manual release — deterministic handshake.
        releaseEnd = callback ?? (() => {});
      }
    })();
    const writer = createJsonlWriter("/tmp/out.jsonl", source, {
      createWriteStream: () => stream,
    });
    writer.writeLine('{"type":"a"}');

    // Three concurrent close() calls before the stream's end callback fires.
    const p1 = writer.close();
    const p2 = writer.close();
    const p3 = writer.close();

    // end() must be called exactly once, not three times.
    assert.equal(endCallCount, 1, "end() called exactly once");
    assert.equal(stream.ended, true);

    // None of the promises should resolve until the end callback fires.
    let settled = 0;
    void p1.then(() => settled++);
    void p2.then(() => settled++);
    void p3.then(() => settled++);
    await Promise.resolve(); // flush microtasks
    assert.equal(settled, 0, "no caller resolves before end callback fires");

    // Release the end callback and confirm all three callers resolve.
    releaseEnd();
    await Promise.all([p1, p2, p3]);
    assert.equal(settled, 3, "all callers resolve after end callback fires");
    assert.equal(endCallCount, 1, "end() still called exactly once");
  });

  it("repeated close() after completion is a no-op and returns the same resolved promise", async () => {
    // --- stream-backed writer ---
    {
      const source = new MockSource();
      let endCallCount = 0;
      const stream = new (class extends MockStream {
        override end(callback?: () => void): void {
          endCallCount++;
          this.ended = true;
          callback?.();
        }
      })();
      const writer = createJsonlWriter("/tmp/out.jsonl", source, {
        createWriteStream: () => stream,
      });
      const p1 = writer.close();
      const p2 = writer.close();
      const p3 = writer.close();
      await Promise.all([p1, p2, p3]);
      assert.strictEqual(p1, p2, "stream-backed: p1 and p2 are the same promise");
      assert.strictEqual(p2, p3, "stream-backed: p2 and p3 are the same promise");
      assert.equal(endCallCount, 1, "end() called exactly once even after repeated close()");
    }

    // --- no-filePath (no-op) writer ---
    {
      const source = new MockSource();
      const writer = createJsonlWriter(undefined, source);
      const p1 = writer.close();
      const p2 = writer.close();
      const p3 = writer.close();
      await Promise.all([p1, p2, p3]);
      assert.strictEqual(p1, p2, "no-filePath: p1 and p2 are the same promise");
      assert.strictEqual(p2, p3, "no-filePath: p2 and p3 are the same promise");
    }

    // --- createWriteStream-throws (no-op) writer ---
    {
      const source = new MockSource();
      const writer = createJsonlWriter("/tmp/out.jsonl", source, {
        createWriteStream: () => {
          throw new Error("stream unavailable");
        },
      });
      const p1 = writer.close();
      const p2 = writer.close();
      const p3 = writer.close();
      await Promise.all([p1, p2, p3]);
      assert.strictEqual(p1, p2, "createWriteStream-throws: p1 and p2 are the same promise");
      assert.strictEqual(p2, p3, "createWriteStream-throws: p2 and p3 are the same promise");
    }
  });
});
