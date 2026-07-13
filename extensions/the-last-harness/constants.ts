import type { ThinkingLevel } from "./types.js";

export const TLH_NAME = "tlh";
export const TLH_PACKAGE_NAME = "The Last Harness";
export const TLH_REPO = "diegopetrucci/the-last-harness";
export const TLH_RELEASES_URL = `https://github.com/${TLH_REPO}/releases`;
export const TLH_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${TLH_REPO}/releases/latest`;
export const TLH_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const TLH_UPDATE_CHECK_TIMEOUT_MS = 3000;
// TelemetryDeck appID/namespace are public client analytics identifiers, not secrets.
// Env overrides support local verification against mock TelemetryDeck endpoints.
export const TLH_TELEMETRY_NAMESPACE = "com.gordicorp";
export const TLH_TELEMETRY_APP_ID = "A4B1E0A4-E03B-450A-B0FA-2ED9895353F3";
export const TLH_TELEMETRY_INGEST_BASE_URL = "https://nom.telemetrydeck.com/v2/namespace";
export const TLH_TELEMETRY_EVENT_TYPE = "Tlh.launched";
export const TLH_TELEMETRY_TIMEOUT_MS = 1500;
export const TLH_TELEMETRY_STATE_SCHEMA_VERSION = 1;
export const DUMB_ZONE_THRESHOLD_TOKENS = 200_000;
export const DUMB_ZONE_LABEL = "DUMB ZONE";
// Pi prefixes package-backed commands with provenance tags like [u:git:github.com/org/repo@ref].
// tlh keeps autocomplete focused on the command description instead.
export const AUTOCOMPLETE_SOURCE_TAG_PATTERN = /(^|—\s*)\[(?:u|p|t)(?::(?:npm|git):[^\]]+)?\]\s*/g;
export const PRIMARY_AGENT_CYCLE_SHORTCUT = "shift+tab";
export const TLH_HEADER_TOGGLE_SHORTCUT = "ctrl+shift+e";
export const TLH_HEADER_TOGGLE_SHORTCUT_LABEL = "Ctrl+Shift+E";

export const HARNESS_PROMPT = `
## The Last Harness Defaults

The Last Harness (tlh) profile is active. Prefer safe, transparent, and reviewable changes:

- Refer to this environment as "tlh" or "The Last Harness" in user-facing text.
- Mention Pi only when specifically discussing the upstream Pi runtime or compatibility.
- Explain high-impact actions before taking them.
- Never create a git commit on your own. Always ask the user and get explicit approval before running git commit (or any commit-creating command), even when changes look complete.
- Use the narrowest tool or command that solves the task.
- Preserve user-owned configuration unless explicitly asked to change it.
- Make installer and setup changes idempotent whenever possible.
- Document how to undo any persistent change.
`;

export const GNOSIS_PROMPT = [
	"At the start of any task, run `gn help plan` and follow its instructions.",
	"After finishing a task, run `gn help review`.",
].join("\n");

export const CHILD_SUBAGENT_PROMPT = `
## TLH Child Subagent Defaults

You are running inside a delegated TLH child subagent session.

- Follow your assigned minor-agent prompt and task brief.
- Do not run Gnosis (\`gn\`) planning, review, write, edit, or removal commands, and do not update project memory directly.
- If you learn something durable that should be recorded in project memory, report it to the parent primary agent or supervisor instead.
`;

export const GNOSIS_VALIDATION_TIMEOUT_MS = 5000;

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const FALLBACK_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No extra reasoning effort",
	minimal: "Smallest reasoning budget",
	low: "Light reasoning budget",
	medium: "Balanced default reasoning budget",
	high: "Deeper reasoning budget",
	xhigh: "Extra-high reasoning budget when the model supports it",
	max: "Maximum reasoning budget when the model supports it",
};
