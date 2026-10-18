import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const pidFile = process.env.FIXTURE_PID_FILE;
const logFile = process.env.FIXTURE_LOG;
const record = (event) => {
  if (logFile) appendFileSync(logFile, `${event}\n`);
};
const cleanup = () => {
  if (pidFile && existsSync(pidFile)) unlinkSync(pidFile);
};
const stop = () => {
  cleanup();
  process.exit(0);
};

if (!pidFile || !logFile) throw new Error("fixture paths are required");
writeFileSync(pidFile, `${process.pid}\n`);
record("started");
process.once("exit", cleanup);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

const output = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  record(message.method ?? "notification");
  if (message.method === "initialize") {
    output(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tlh-test-fixture", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    output(message.id, {
      tools: [
        {
          name: "read_fixture",
          description: "Read deterministic fixture",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
  } else if (message.method === "tools/call") {
    record("tools/call:read_fixture");
    output(message.id, { content: [{ type: "text", text: "FIXTURE_MCP_OK" }], isError: false });
  } else if (message.method === "ping") {
    output(message.id, {});
  }
});
input.once("close", stop);
