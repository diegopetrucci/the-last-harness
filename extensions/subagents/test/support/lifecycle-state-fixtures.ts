import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function expectNoSecretInError(fn: () => void, secret: string, expected: RegExp): void {
  assert.throws(() => {
    try {
      fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, expected);
      assert.equal(
        message.includes(secret),
        false,
        `expected error to avoid secret root '${secret}', got: ${message}`,
      );
      throw error;
    }
  }, expected);
}
