import * as fs from "node:fs";
const NO_OP_CLOSE_PROMISE = Promise.resolve();
const DEFAULT_MAX_JSONL_BYTES = 50 * 1024 * 1024;
export function createJsonlWriter(filePath, source, deps = {}) {
    if (!filePath) {
        return {
            writeLine() { },
            close() {
                return NO_OP_CLOSE_PROMISE;
            },
        };
    }
    const createWriteStream = deps.createWriteStream ??
        ((targetPath) => fs.createWriteStream(targetPath, { flags: "a" }));
    let stream;
    try {
        stream = createWriteStream(filePath);
    }
    catch {
        return {
            writeLine() { },
            close() {
                return NO_OP_CLOSE_PROMISE;
            },
        };
    }
    let backpressured = false;
    let closed = false;
    let closePromise;
    let bytesWritten = 0;
    const maxBytes = deps.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;
    return {
        writeLine(line) {
            if (!stream || closed || !line.trim())
                return;
            const chunk = `${line}\n`;
            const chunkBytes = Buffer.byteLength(chunk, "utf-8");
            if (bytesWritten + chunkBytes > maxBytes)
                return;
            try {
                const ok = stream.write(chunk);
                bytesWritten += chunkBytes;
                if (!ok && !backpressured) {
                    backpressured = true;
                    source.pause();
                    stream.once("drain", () => {
                        backpressured = false;
                        if (!closed)
                            source.resume();
                    });
                }
            }
            catch {
                void 0;
            }
        },
        close() {
            if (closePromise !== undefined)
                return closePromise;
            if (!stream) {
                closePromise = Promise.resolve();
                return closePromise;
            }
            closed = true;
            const current = stream;
            stream = undefined;
            closePromise = new Promise((resolve) => current.end(() => resolve()));
            return closePromise;
        },
    };
}
