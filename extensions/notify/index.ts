/**
 * TLH notify extension (vendored from @diegopetrucci/pi-notify 0.1.15)
 *
 * Sends notifications when the agent is done and waiting for input.
 * Supports multiple channels:
 * - terminal notifications: OSC 777 and OSC 99
 * - desktop notifications: macOS Notification Center, Linux notify-send, Windows toast
 * - terminal bell
 * - sound playback
 *
 * Attribution: This started from the original `notify.ts` example in
 * earendil-works/pi, then evolved in @diegopetrucci/pi-notify (MIT).
 * See README.md for full attribution details.
 *
 * Config is resolved at runtime (project overrides global):
 * - <getAgentDir()>/extensions/notify.json  (default agent dir: ~/.the-last-harness/agent)
 * - <project>/<CONFIG_DIR_NAME>/notify.json, when the project is trusted
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { TLH_EFFECTIVE_ACTIVITY_EVENT } from "../shared/tlh-effective-activity.js";
import type { TlhEffectiveActivityPayload } from "../shared/tlh-effective-activity.js";

type TerminalBackend = "auto" | "osc777" | "osc99" | "none";
type DesktopBackend = "auto" | "macos" | "linux" | "windows-toast" | "none";
type SoundBackend = "auto" | "macos" | "linux" | "windows-beep" | "command" | "none";

type ProjectConfigContext = {
	cwd: string;
	isProjectTrusted?: () => boolean;
};

interface NotifyConfig {
	enabled: boolean;
	onlyWhenInteractive: boolean;
	/**
	 * When true (default), suppress all notification channels while the activity
	 * tracker reports background work in flight. Notifications resume once the
	 * snapshot clears. Has no effect when the TLH activity tracker is absent.
	 */
	suppressWhileActive: boolean;
	title: string;
	body: string;
	channels: {
		terminal: boolean;
		desktop: boolean;
		bell: boolean;
		sound: boolean;
	};
	terminal: {
		backend: TerminalBackend;
	};
	desktop: {
		backend: DesktopBackend;
	};
	sound: {
		backend: SoundBackend;
		name: string;
		linuxSoundId: string;
		frequencyHz: number;
		durationMs: number;
		command: string;
	};
}

const DEFAULT_CONFIG: NotifyConfig = {
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

function readConfigFile(path: string): Partial<NotifyConfig> {
	if (!existsSync(path)) return {};

	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Partial<NotifyConfig>;
	} catch (error) {
		console.error(`Warning: Could not parse ${path}: ${error}`);
		return {};
	}
}

function mergeConfig(base: NotifyConfig, overrides: Partial<NotifyConfig>): NotifyConfig {
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

function canReadProjectConfig(ctx: ProjectConfigContext): boolean {
	return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
}

function loadConfig(ctx: ProjectConfigContext): NotifyConfig {
	const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "notify.json"));
	const projectConfig = canReadProjectConfig(ctx) ? readConfigFile(join(ctx.cwd, CONFIG_DIR_NAME, "notify.json")) : {};
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function powershellString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function windowsToastScript(title: string, body: string): string {
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

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function ringBell(): void {
	process.stdout.write("\x07");
}

function runCommand(command: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(command, args, (error) => resolve(!error));
	});
}

function runShellCommand(command: string): Promise<boolean> {
	if (process.platform === "win32") {
		return runCommand("cmd.exe", ["/d", "/s", "/c", command]);
	}

	return runCommand(process.env.SHELL || "/bin/sh", ["-lc", command]);
}

function detectTerminalBackend(config: NotifyConfig): Exclude<TerminalBackend, "auto"> {
	if (config.terminal.backend !== "auto") return config.terminal.backend;
	if (process.env.KITTY_WINDOW_ID) return "osc99";
	return "osc777";
}

function detectDesktopBackend(config: NotifyConfig): Exclude<DesktopBackend, "auto"> {
	if (config.desktop.backend !== "auto") return config.desktop.backend;
	if (process.env.WT_SESSION || process.env.WSL_DISTRO_NAME) return "windows-toast";
	if (process.platform === "darwin") return "macos";
	if (process.platform === "linux") return "linux";
	if (process.platform === "win32") return "windows-toast";
	return "none";
}

function detectSoundBackend(config: NotifyConfig): Exclude<SoundBackend, "auto"> {
	if (config.sound.backend !== "auto") return config.sound.backend;
	if (process.env.WT_SESSION || process.platform === "win32" || process.env.WSL_DISTRO_NAME) return "windows-beep";
	if (process.platform === "darwin") return "macos";
	if (process.platform === "linux") return "linux";
	return "none";
}

function sendTerminalNotification(title: string, body: string, backend: Exclude<TerminalBackend, "auto">): void {
	if (backend === "osc99") {
		notifyOSC99(title, body);
		return;
	}
	if (backend === "osc777") {
		notifyOSC777(title, body);
	}
}

function appleScriptString(value: string): string {
	return JSON.stringify(value);
}

function sendDesktopNotification(
	title: string,
	body: string,
	backend: Exclude<DesktopBackend, "auto">,
): Promise<boolean> {
	if (backend === "windows-toast") {
		return runCommand("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
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

async function playSound(config: NotifyConfig, backend: Exclude<SoundBackend, "auto">): Promise<boolean> {
	if (backend === "command") {
		if (!config.sound.command.trim()) return false;
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
		if (viaCanberra) return true;
		return runCommand("paplay", [`/usr/share/sounds/freedesktop/stereo/${soundId}.oga`]);
	}

	return false;
}

function isActivityPayload(data: unknown): data is TlhEffectiveActivityPayload {
	return (
		typeof data === "object" &&
		data !== null &&
		"activeAsyncJobIds" in data &&
		Array.isArray((data as Record<string, unknown>).activeAsyncJobIds)
	);
}

/** Milliseconds to wait after agent_settled before deciding to notify. */
const DEFAULT_SETTLE_DEBOUNCE_MS = 300;

/**
 * Minimal ctx fields captured when a settle is suppressed, so the pending-settle
 * path can re-evaluate guards (enabled, onlyWhenInteractive, isIdle) when work later
 * clears. Matches the subset accessed during the debounce callback.
 */
type SettleCtx = {
	cwd: string;
	hasUI?: boolean;
	isProjectTrusted?: () => boolean;
	isIdle?: () => boolean;
};

/** Injectable options — used in tests to control timing without real timers. */
export type NotifyExtensionOptions = {
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
	/** Override settle-debounce delay (ms). Defaults to 300. */
	settleDebounceMs?: number;
	/**
	 * Optional test-only hook called instead of sending real notifications.
	 * When provided, all I/O (stdout writes, osascript, etc.) is skipped and
	 * this callback is invoked once per notification decision that would have fired.
	 */
	onNotify?: () => void;
};

/**
 * Build a notify extension with optional injectable timer dependencies.
 * The returned function is compatible with the Pi extension API.
 *
 * Exported for testing; typical usage is the `default` export which uses
 * real timers and the default debounce delay.
 */
export function createNotifyExtension(options: NotifyExtensionOptions = {}): (pi: ExtensionAPI) => void {
	const setTimeoutImpl = options.setTimeout ?? setTimeout;
	const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
	const settleDebounceMs = options.settleDebounceMs ?? DEFAULT_SETTLE_DEBOUNCE_MS;
	const onNotify = options.onNotify;

	return function notifyExtension(pi: ExtensionAPI) {
		/**
		 * Latest activeAsyncJobIds from the TLH activity tracker.
		 * undefined = no signal ever received (tracker absent or no events bus).
		 * Graceful-degradation rule: undefined must NOT be treated as "in flight",
		 * or notify would go permanently silent when running without TLH.
		 *
		 * We gate on this array rather than the aggregate `inProgress` flag so that
		 * primary-agent-loop reasons (e.g. retry-grace) do not suppress notifications.
		 * Suppression must only apply while background subagent work is actually
		 * in flight, matching the original ts-vy9k spec.
		 */
		let latestActiveAsyncJobIds: string[] | undefined = undefined;

		/** Pending settle-debounce timer. Replaced on each agent_settled. */
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;

		/** Unsubscribe handle for the TLH activity event subscription. */
		let activityUnsubscribe: (() => void) | undefined;

		/**
		 * When a settle is suppressed because background work was in flight, we
		 * remember the settle context here so we can re-evaluate and notify when
		 * the activity signal later reports no background work.
		 *
		 * Cleared on: new agent run (before_agent_start), session_shutdown, and
		 * after it fires — so it can neither leak nor double-fire.
		 * Also cleared when a new agent_settled supersedes it.
		 */
		let pendingSettleCtx: SettleCtx | undefined;

		/**
		 * Send a notification for the given config/ctx without any suppression guards.
		 * All guards must have been checked by the caller.
		 */
		const sendNotification = async (config: NotifyConfig): Promise<void> => {
			// Test-only dry-run hook: skip real I/O when provided.
			if (onNotify) {
				onNotify();
				return;
			}

			const tasks: Array<Promise<unknown>> = [];

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

		// Subscribe to the activity bus only if pi.events is available.
		if (pi.events) {
			activityUnsubscribe = pi.events.on(TLH_EFFECTIVE_ACTIVITY_EVENT, (data: unknown) => {
				if (isActivityPayload(data)) {
					latestActiveAsyncJobIds = data.activeAsyncJobIds;

					// Re-evaluate a suppressed settle when background work just cleared.
					// This is the falling-edge path: the periodic liveness drain fired,
					// detected a dead child, and emitted an updated snapshot.
					//
					// IMPORTANT: do NOT send synchronously here. On a normal async child
					// completion the tracker emits this falling edge from handleAsyncComplete
					// before the completion has woken the parent, so ctx.isIdle() is still
					// true at this point. Sending synchronously would produce a notification
					// immediately, and then the woken turn's own agent_settled would produce
					// a second one — the exact double-ping this feature exists to eliminate.
					//
					// Instead, re-arm the existing settle debounce with the stored ctx. This
					// gives the parent wake a chance to land first. If it does,
					// before_agent_start will cancel this timer and the woken turn's own
					// agent_settled becomes the single notification. If the parent does not
					// wake (background-only child completion), the debounce fires and the
					// isIdle() guard passes, producing exactly one notification.
					if (pendingSettleCtx !== undefined && data.activeAsyncJobIds.length === 0) {
						const ctx = pendingSettleCtx;
						// Clear now so another activity event cannot double-schedule.
						pendingSettleCtx = undefined;
						// Cancel any existing debounce before re-arming.
						if (debounceTimer !== undefined) {
							clearTimeoutImpl(debounceTimer);
						}
						debounceTimer = setTimeoutImpl(async () => {
							debounceTimer = undefined;
							const config = loadConfig(ctx);
							if (!config.enabled) return;
							if (config.onlyWhenInteractive && !ctx.hasUI) return;
							if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
							await sendNotification(config);
						}, settleDebounceMs);
					}
				}
			});
		}

		pi.on("session_shutdown", () => {
			// Cancel any pending notification timer so it cannot fire against a
			// torn-down session after shutdown.
			if (debounceTimer !== undefined) {
				clearTimeoutImpl(debounceTimer);
				debounceTimer = undefined;
			}
			// Clear any pending-settle state so it cannot fire after shutdown.
			pendingSettleCtx = undefined;
			// Unsubscribe from the activity event bus (best-effort).
			if (activityUnsubscribe) {
				try {
					activityUnsubscribe();
				} catch {
					// Best-effort event-bus cleanup during shutdown.
				}
				activityUnsubscribe = undefined;
			}
		});

		// Clear the pending settle when a new agent run starts so a superseded
		// settle cannot fire after the new run begins.  Also cancel the debounce
		// timer — the pending-settle path now re-arms it, so an in-flight re-arm
		// must be cancelled here too, or the woken turn's settle would race with
		// the re-armed release and produce two notifications.
		pi.on("before_agent_start", () => {
			pendingSettleCtx = undefined;
			if (debounceTimer !== undefined) {
				clearTimeoutImpl(debounceTimer);
				debounceTimer = undefined;
			}
		});

		pi.on("agent_settled", (_event, ctx) => {
			// A new settle supersedes any earlier pending-settle state.
			pendingSettleCtx = undefined;
			// Cancel any pending notification from a prior settle.
			if (debounceTimer !== undefined) {
				clearTimeoutImpl(debounceTimer);
			}

			// Schedule the notification after a short delay. This absorbs the
			// rapid settle-then-child-complete flap: if the child finishes and
			// updates inProgress before the timer fires, we read the fresh value.
			debounceTimer = setTimeoutImpl(async () => {
				debounceTimer = undefined;
				const config = loadConfig(ctx);
				if (!config.enabled) return;
				if (config.onlyWhenInteractive && !ctx.hasUI) return;

				// If the agent is no longer idle, a new turn has started (e.g. a child
				// completing woke the parent). Do not notify — the new turn's own
				// eventual agent_settled will be responsible for notification.
				if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;

				// Suppress only when background subagent work is in flight.
				// Primary-agent-loop reasons (e.g. retry-grace) must NOT suppress.
				// Never suppress when no signal has been received (graceful degradation:
				// undefined means tracker is absent, not that work is in flight).
				if (config.suppressWhileActive && latestActiveAsyncJobIds !== undefined && latestActiveAsyncJobIds.length > 0) {
					// Remember this suppressed settle so the activity falling-edge can
					// re-evaluate it once background work clears.  Store a snapshot of
					// the ctx fields we need; isIdle() is a live function so it reflects
					// the current state when evaluated later.
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
