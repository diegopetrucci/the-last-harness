import * as fs from "node:fs";

// Stable resolved promise shared by all no-op writer variants so close() identity
// is consistent (async close(){} would allocate a fresh promise per call).
const NO_OP_CLOSE_PROMISE: Promise<void> = Promise.resolve();

export interface DrainableSource {
	pause(): void;
	resume(): void;
}

export interface JsonlWriteStream {
	write(chunk: string): boolean;
	once(event: "drain", listener: () => void): JsonlWriteStream;
	end(callback?: () => void): void;
}

const DEFAULT_MAX_JSONL_BYTES = 50 * 1024 * 1024;

interface JsonlWriterDeps {
	createWriteStream?: (filePath: string) => JsonlWriteStream;
	maxBytes?: number;
}

interface JsonlWriter {
	writeLine(line: string): void;
	close(): Promise<void>;
}

export function createJsonlWriter(
	filePath: string | undefined,
	source: DrainableSource,
	deps: JsonlWriterDeps = {},
): JsonlWriter {
	if (!filePath) {
		return {
			writeLine() {},
			close() {
				return NO_OP_CLOSE_PROMISE;
			},
		};
	}

	const createWriteStream =
		deps.createWriteStream ?? ((targetPath: string) => fs.createWriteStream(targetPath, { flags: "a" }));
	let stream: JsonlWriteStream | undefined;
	try {
		stream = createWriteStream(filePath);
	} catch {
		return {
			writeLine() {},
			close() {
				return NO_OP_CLOSE_PROMISE;
			},
		};
	}

	let backpressured = false;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	let bytesWritten = 0;
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;

	return {
		writeLine(line: string) {
			if (!stream || closed || !line.trim()) return;
			const chunk = `${line}\n`;
			const chunkBytes = Buffer.byteLength(chunk, "utf-8");
			if (bytesWritten + chunkBytes > maxBytes) return;
			try {
				const ok = stream.write(chunk);
				bytesWritten += chunkBytes;
				if (!ok && !backpressured) {
					backpressured = true;
					source.pause();
					stream.once("drain", () => {
						backpressured = false;
						if (!closed) source.resume();
					});
				}
			} catch {
				void 0;
			}
		},
		close(): Promise<void> {
			if (closePromise !== undefined) return closePromise;
			if (!stream) {
				closePromise = Promise.resolve();
				return closePromise;
			}
			closed = true;
			const current = stream;
			stream = undefined;
			closePromise = new Promise<void>((resolve) => current.end(() => resolve()));
			return closePromise;
		},
	};
}
