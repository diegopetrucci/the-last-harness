import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { QuietGlimpseWindowImpl } = await jiti.import("../extensions/shared/quiet-glimpse.ts");

test("quiet glimpse silently ignores non-object JSON and preserves valid message data", async () => {
  const expectedMessageData = {
    kind: "future-message",
    nested: { values: ["preserve", 7] },
  };
  const protocolLines = [
    "null",
    "[1,2]",
    JSON.stringify("primitive"),
    "42",
    JSON.stringify({ type: "future_event", extraField: { nested: true } }),
    JSON.stringify({
      type: "message",
      data: expectedMessageData,
      extraField: { nested: "preserve" },
    }),
  ];
  const childScript = `setTimeout(() => process.stdout.write(${JSON.stringify(`${protocolLines.join("\n")}\n`)}), 10)`;
  const proc = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const window = new QuietGlimpseWindowImpl(proc, "<p>initial</p>");
  const messages = [];
  const errors = [];
  window.on("message", (data) => messages.push(data));
  window.on("error", (error) => errors.push(error));

  await new Promise((resolve) => window.on("closed", resolve));

  assert.deepEqual(messages, [expectedMessageData]);
  assert.deepEqual(errors, []);
});
