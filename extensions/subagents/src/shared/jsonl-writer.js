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
    let streamFailed = false;
    let backpressured = false;
    let closed = false;
    let closePromise;
    let resolveClose;
    let bytesWritten = 0;
    const maxBytes = deps.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;
    const markStreamFailed = () => {
        streamFailed = true;
        stream = undefined;
        if (backpressured) {
            backpressured = false;
            source.resume();
        }
        resolveClose?.();
    };
    try {
        stream = createWriteStream(filePath);
        stream.on("error", markStreamFailed);
    }
    catch {
        return {
            writeLine() { },
            close() {
                return NO_OP_CLOSE_PROMISE;
            },
        };
    }
    return {
        writeLine(line) {
            if (!stream || streamFailed || closed || !line.trim())
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
                        if (!backpressured)
                            return;
                        backpressured = false;
                        if (!closed && !streamFailed)
                            source.resume();
                    });
                }
            }
            catch {
                markStreamFailed();
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
            closePromise = new Promise((resolve) => {
                resolveClose = resolve;
                try {
                    current.end(resolve);
                }
                catch {
                    resolve();
                }
            });
            return closePromise;
        },
    };
}
