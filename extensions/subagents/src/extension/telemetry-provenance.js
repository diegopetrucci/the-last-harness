import { VERSION } from "@earendil-works/pi-coding-agent";
import { getTlhVersion } from "../../../the-last-harness/package-version.js";
import { readTlhInstallState } from "../../../the-last-harness/profile-state.js";
export function captureSubagentTelemetryProvenance(loadedAt = Date.now()) {
    const installGeneration = readTlhInstallState().installedAt;
    return {
        tlhVersion: getTlhVersion(),
        piVersion: VERSION,
        ...(typeof installGeneration === "string" && installGeneration.trim()
            ? { installGeneration: installGeneration.trim() }
            : {}),
        loadedAt,
    };
}
