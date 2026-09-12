import { createJiti } from "jiti";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const { TLH_TELEMETRY_STATE_SCHEMA_VERSION } = await jiti.import(
  "../../extensions/the-last-harness/constants.ts",
);

export const EXISTING_INSTALL_ID = "11111111-1111-4111-8111-111111111111";

export function telemetryStatePath(fixture) {
  return join(fixture.agent, "tlh", "telemetry-state.json");
}

export function writeTelemetryState(fixture, installId = EXISTING_INSTALL_ID) {
  mkdirSync(join(fixture.agent, "tlh"), { recursive: true });
  const stateContent = `${JSON.stringify({ schemaVersion: TLH_TELEMETRY_STATE_SCHEMA_VERSION, installId }, null, 2)}\n`;
  writeFileSync(telemetryStatePath(fixture), stateContent);
  return stateContent;
}
