import { appendFileSync } from "node:fs";
import readline from "node:readline";

// Minimal stdio MCP server. FIXTURE_NAME namespaces its replies; FIXTURE_LOG receives one
// JSON line per observed event so tests can prove what actually reached the server process.
const name = process.env.FIXTURE_NAME;
const logFile = process.env.FIXTURE_LOG;
if (!name || !logFile) throw new Error("FIXTURE_NAME and FIXTURE_LOG are required");
const record = (event, extra = {}) =>
  appendFileSync(
    logFile,
    `${JSON.stringify({ server: name, pid: process.pid, event, ...extra })}\n`,
  );
const stop = () => process.exit(0);
record("started");
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

const tools = [
  ["read_fixture", "Read deterministic fixture"],
  ["fail_fixture", "Return an MCP isError result"],
  ["slow_fixture", "Never answers until the call is cancelled"],
].map(([toolName, description]) => ({
  name: toolName,
  description,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}));
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const slowCalls = new Set();

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  record(message.method ?? "response");
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `tlh-test-fixture-${name}`, version: "1.0.0" },
      },
    });
  } else if (message.method === "tools/list") {
    send({ id: message.id, result: { tools } });
  } else if (message.method === "tools/call") {
    const tool = message.params?.name;
    record("tools/call", { tool });
    if (tool === "read_fixture") {
      send({ id: message.id, result: { content: [{ type: "text", text: `FIXTURE_OK:${name}` }] } });
    } else if (tool === "fail_fixture") {
      send({
        id: message.id,
        result: { content: [{ type: "text", text: `FIXTURE_ERROR:${name}` }], isError: true },
      });
    } else if (tool === "slow_fixture") {
      slowCalls.add(message.id);
    } else {
      send({ id: message.id, error: { code: -32601, message: `unknown tool ${tool}` } });
    }
  } else if (message.method === "notifications/cancelled") {
    const requestId = message.params?.requestId;
    if (slowCalls.delete(requestId)) record("slow_fixture:cancelled");
  } else if (message.method === "ping") {
    send({ id: message.id, result: {} });
  }
});
input.once("close", stop);
