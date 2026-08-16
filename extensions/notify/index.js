import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { TLH_EFFECTIVE_ACTIVITY_EVENT } from "../shared/tlh-effective-activity.js";
const DEFAULT_CONFIG = {
    enabled: true,
    onlyWhenInteractive: true,
    suppressWhileActive: true,
    title: "tlh",
    body: "Ready for input",
    channels: {
        terminal: true,
        desktop: true,
        bell: true,
        sound: false,
    },
    terminal: {
        backend: "auto",
    },
    desktop: {
        backend: "auto",
    },
    sound: {
        backend: "auto",
        name: "Glass",
        linuxSoundId: "complete",
        frequencyHz: 1000,
        durationMs: 250,
        command: "",
    },
};
function readConfigFile(path) {
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    }
    catch (error) {
        console.error(`Warning: Could not parse ${path}: ${error}`);
        return {};
    }
}
function mergeConfig(base, overrides) {
    return {
        ...base,
        ...overrides,
        channels: {
            ...base.channels,
            ...overrides.channels,
        },
        terminal: {
            ...base.terminal,
            ...overrides.terminal,
        },
        desktop: {
            ...base.desktop,
            ...overrides.desktop,
        },
        sound: {
            ...base.sound,
            ...overrides.sound,
        },
    };
}
function canReadProjectConfig(ctx) {
    return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
}
function loadConfig(ctx) {
    const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "notify.json"));
    const projectConfig = canReadProjectConfig(ctx)
        ? readConfigFile(join(ctx.cwd, CONFIG_DIR_NAME, "notify.json"))
        : {};
    return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}
function powershellString(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
function windowsToastScript(title, body) {
    const type = "Windows.UI.Notifications";
    const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
    const template = `[${type}.ToastTemplateType]::ToastText01`;
    const toast = `[${type}.ToastNotification]::new($xml)`;
    return [
        `${mgr} > $null`,
        `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
        `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode(${powershellString(body)})) > $null`,
        `[${type}.ToastNotificationManager]::CreateToastNotifier(${powershellString(title)}).Show(${toast})`,
    ].join("; ");
}
function notifyOSC777(title, body) {
    process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}
function notifyOSC99(title, body) {
    process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
    process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}
function ringBell() {
    process.stdout.write("\x07");
}
function runCommand(command, args) {
    return new Promise((resolve) => {
        execFile(command, args, (error) => resolve(!error));
    });
}
function runShellCommand(command) {
    if (process.platform === "win32") {
        return runCommand("cmd.exe", ["/d", "/s", "/c", command]);
    }
    return runCommand(process.env.SHELL || "/bin/sh", ["-lc", command]);
}
function detectTerminalBackend(config) {
    if (config.terminal.backend !== "auto")
        return config.terminal.backend;
    if (process.env.KITTY_WINDOW_ID)
        return "osc99";
    return "osc777";
}
function detectDesktopBackend(config) {
    if (config.desktop.backend !== "auto")
        return config.desktop.backend;
    if (process.env.WT_SESSION || process.env.WSL_DISTRO_NAME)
        return "windows-toast";
    if (process.platform === "darwin")
        return "macos";
    if (process.platform === "linux")
        return "linux";
    if (process.platform === "win32")
        return "windows-toast";
    return "none";
}
function detectSoundBackend(config) {
    if (config.sound.backend !== "auto")
        return config.sound.backend;
    if (process.env.WT_SESSION || process.platform === "win32" || process.env.WSL_DISTRO_NAME)
        return "windows-beep";
    if (process.platform === "darwin")
        return "macos";
    if (process.platform === "linux")
        return "linux";
    return "none";
}
function sendTerminalNotification(title, body, backend) {
    if (backend === "osc99") {
        notifyOSC99(title, body);
        return;
    }
    if (backend === "osc777") {
        notifyOSC777(title, body);
    }
}
function appleScriptString(value) {
    return JSON.stringify(value);
}
function sendDesktopNotification(title, body, backend) {
    if (backend === "windows-toast") {
        return runCommand("powershell.exe", [
            "-NoProfile",
            "-Command",
            windowsToastScript(title, body),
        ]);
    }
    if (backend === "macos") {
        return runCommand("osascript", [
            "-e",
            `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`,
        ]);
    }
    if (backend === "linux") {
        return runCommand("notify-send", [title, body]);
    }
    return Promise.resolve(false);
}
async function playSound(config, backend) {
    if (backend === "command") {
        if (!config.sound.command.trim())
            return false;
        return runShellCommand(config.sound.command);
    }
    if (backend === "windows-beep") {
        return runCommand("powershell.exe", [
            "-NoProfile",
            "-Command",
            `[console]::beep(${config.sound.frequencyHz}, ${config.sound.durationMs})`,
        ]);
    }
    if (backend === "macos") {
        return runCommand("afplay", [`/System/Library/Sounds/${config.sound.name}.aiff`]);
    }
    if (backend === "linux") {
        const soundId = config.sound.linuxSoundId;
        const viaCanberra = await runCommand("canberra-gtk-play", ["-i", soundId]);
        if (viaCanberra)
            return true;
        return runCommand("paplay", [`/usr/share/sounds/freedesktop/stereo/${soundId}.oga`]);
    }
    return false;
}
function isActivityPayload(data) {
    return (typeof data === "object" &&
        data !== null &&
        "activeAsyncJobIds" in data &&
        Array.isArray(data.activeAsyncJobIds));
}
const DEFAULT_SETTLE_DEBOUNCE_MS = 300;
export function createNotifyExtension(options = {}) {
    const setTimeoutImpl = options.setTimeout ?? setTimeout;
    const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
    const settleDebounceMs = options.settleDebounceMs ?? DEFAULT_SETTLE_DEBOUNCE_MS;
    const onNotify = options.onNotify;
    return function notifyExtension(pi) {
        let latestActiveAsyncJobIds = undefined;
        let debounceTimer;
        let activityUnsubscribe;
        let pendingSettleCtx;
        const sendNotification = async (config) => {
            if (onNotify) {
                onNotify();
                return;
            }
            const tasks = [];
            if (config.channels.terminal) {
                sendTerminalNotification(config.title, config.body, detectTerminalBackend(config));
            }
            if (config.channels.desktop) {
                tasks.push(sendDesktopNotification(config.title, config.body, detectDesktopBackend(config)));
            }
            if (config.channels.bell) {
                ringBell();
            }
            if (config.channels.sound) {
                tasks.push(playSound(config, detectSoundBackend(config)));
            }
            if (tasks.length > 0) {
                await Promise.allSettled(tasks);
            }
        };
        if (pi.events) {
            activityUnsubscribe = pi.events.on(TLH_EFFECTIVE_ACTIVITY_EVENT, (data) => {
                if (isActivityPayload(data)) {
                    latestActiveAsyncJobIds = data.activeAsyncJobIds;
                    if (pendingSettleCtx !== undefined && data.activeAsyncJobIds.length === 0) {
                        const ctx = pendingSettleCtx;
                        pendingSettleCtx = undefined;
                        if (debounceTimer !== undefined) {
                            clearTimeoutImpl(debounceTimer);
                        }
                        debounceTimer = setTimeoutImpl(async () => {
                            debounceTimer = undefined;
                            const config = loadConfig(ctx);
                            if (!config.enabled)
                                return;
                            if (config.onlyWhenInteractive && !ctx.hasUI)
                                return;
                            if (typeof ctx.isIdle === "function" && !ctx.isIdle())
                                return;
                            await sendNotification(config);
                        }, settleDebounceMs);
                    }
                }
            });
        }
        pi.on("session_shutdown", () => {
            if (debounceTimer !== undefined) {
                clearTimeoutImpl(debounceTimer);
                debounceTimer = undefined;
            }
            pendingSettleCtx = undefined;
            if (activityUnsubscribe) {
                try {
                    activityUnsubscribe();
                }
                catch {
                }
                activityUnsubscribe = undefined;
            }
        });
        pi.on("before_agent_start", () => {
            pendingSettleCtx = undefined;
            if (debounceTimer !== undefined) {
                clearTimeoutImpl(debounceTimer);
                debounceTimer = undefined;
            }
        });
        pi.on("agent_settled", (_event, ctx) => {
            pendingSettleCtx = undefined;
            if (debounceTimer !== undefined) {
                clearTimeoutImpl(debounceTimer);
            }
            debounceTimer = setTimeoutImpl(async () => {
                debounceTimer = undefined;
                const config = loadConfig(ctx);
                if (!config.enabled)
                    return;
                if (config.onlyWhenInteractive && !ctx.hasUI)
                    return;
                if (typeof ctx.isIdle === "function" && !ctx.isIdle())
                    return;
                if (config.suppressWhileActive &&
                    latestActiveAsyncJobIds !== undefined &&
                    latestActiveAsyncJobIds.length > 0) {
                    pendingSettleCtx = {
                        cwd: ctx.cwd,
                        hasUI: ctx.hasUI,
                        isProjectTrusted: ctx.isProjectTrusted,
                        isIdle: ctx.isIdle,
                    };
                    return;
                }
                await sendNotification(config);
            }, settleDebounceMs);
        });
    };
}
export default createNotifyExtension();
