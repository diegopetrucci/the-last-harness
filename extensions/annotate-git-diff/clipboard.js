import { spawnSync } from "node:child_process";
const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;
const defaultRunner = (command, args, options) => spawnSync(command, args, options);
function clipboardReadCommands(platform) {
    switch (platform) {
        case "darwin":
            return [{ command: "pbpaste", args: [] }];
        case "win32":
            return [
                {
                    command: "powershell.exe",
                    args: [
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw",
                    ],
                },
            ];
        case "linux":
            return [
                { command: "wl-paste", args: ["--type", "text/plain"] },
                { command: "xclip", args: ["-selection", "clipboard", "-out"] },
                { command: "xsel", args: ["--clipboard", "--output"] },
            ];
        default:
            return [];
    }
}
function clipboardWriteCommands(platform) {
    switch (platform) {
        case "darwin":
            return [{ command: "pbcopy", args: [] }];
        case "win32":
            return [
                {
                    command: "powershell.exe",
                    args: [
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
                    ],
                },
            ];
        case "linux":
            return [
                { command: "wl-copy", args: ["--type", "text/plain"] },
                { command: "xclip", args: ["-selection", "clipboard", "-in"] },
                { command: "xsel", args: ["--clipboard", "--input"] },
            ];
        default:
            return [];
    }
}
function commandLabel(command) {
    return [command.command, ...command.args].join(" ");
}
function outputToString(value) {
    if (value == null)
        return "";
    return typeof value === "string" ? value : value.toString("utf8");
}
function runClipboardCommand(command, runner, input) {
    const result = runner(command.command, command.args, {
        encoding: "utf8",
        maxBuffer: MAX_CLIPBOARD_BYTES,
        ...(input == null ? {} : { input }),
    });
    if (result.error)
        throw result.error;
    if (result.status !== 0) {
        const stderr = outputToString(result.stderr).trim();
        const status = result.status == null ? result.signal || "unknown" : result.status;
        throw new Error(`${commandLabel(command)} exited with ${status}${stderr ? `: ${stderr}` : ""}`);
    }
    return outputToString(result.stdout);
}
function runFirstAvailable(commands, runner, input) {
    if (commands.length === 0) {
        throw new Error(`System clipboard is unsupported on ${process.platform}.`);
    }
    const errors = [];
    for (const command of commands) {
        try {
            return runClipboardCommand(command, runner, input);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${commandLabel(command)}: ${message}`);
        }
    }
    throw new Error(`No system clipboard command succeeded. ${errors.join("; ")}`);
}
export function readSystemClipboard(options = {}) {
    const platform = options.platform ?? process.platform;
    const runner = options.runner ?? defaultRunner;
    return runFirstAvailable(clipboardReadCommands(platform), runner);
}
export function writeSystemClipboard(text, options = {}) {
    const platform = options.platform ?? process.platform;
    const runner = options.runner ?? defaultRunner;
    runFirstAvailable(clipboardWriteCommands(platform), runner, text);
}
export const __testing = {
    clipboardReadCommands,
    clipboardWriteCommands,
};
