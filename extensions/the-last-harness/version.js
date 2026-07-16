import { VERSION } from "@earendil-works/pi-coding-agent";
import { getTlhVersion } from "./package-version.js";
/**
 * Format a concise plain-text version string for both TLH and Pi.
 * Exported for unit testing without side effects.
 */
export function formatVersionOutput(tlhVersion, piVersion) {
    return `tlh: ${tlhVersion}  |  pi: ${piVersion}`;
}
export function registerVersionCommand(pi) {
    pi.registerCommand("version", {
        description: "Show the installed TLH and Pi runtime versions",
        handler: async (_args, ctx) => {
            const tlhVersion = getTlhVersion();
            const piVersion = VERSION;
            ctx.ui.notify(formatVersionOutput(tlhVersion, piVersion), "info");
        },
    });
}
