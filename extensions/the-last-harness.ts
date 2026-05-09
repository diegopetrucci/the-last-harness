import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	SettingsManager,
	VERSION as PI_VERSION,
	getAgentDir,
	keyText,
	loadProjectContextFiles,
	type ExtensionAPI,
	type ResolvedResource,
	type Theme,
} from "@earendil-works/pi-coding-agent";

const TLH_NAME = "tlh";
const TLH_PACKAGE_NAME = "The Last Harness";

const HARNESS_PROMPT = `
## The Last Harness Defaults

The Last Harness (tlh) profile is active. Prefer safe, transparent, and reviewable changes:

- Refer to this environment as "tlh" or "The Last Harness" in user-facing text.
- Mention Pi only when specifically discussing the upstream Pi runtime or compatibility.
- Explain high-impact actions before taking them.
- Use the narrowest tool or command that solves the task.
- Preserve user-owned configuration unless explicitly asked to change it.
- Make installer and setup changes idempotent whenever possible.
- Document how to undo any persistent change.
`;

type StartupResources = {
	context: string[];
	skills: string[];
	prompts: string[];
	extensions: string[];
	themes: string[];
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ReasoningModel = {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const FALLBACK_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No extra reasoning effort",
	minimal: "Smallest reasoning budget",
	low: "Light reasoning budget",
	medium: "Balanced default reasoning budget",
	high: "Deeper reasoning budget",
	xhigh: "Maximum reasoning budget when the model supports it",
};

function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function getTlhVersion(): string {
	try {
		const packageJson = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
		return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function parseFrontmatterValue(content: string | undefined, key: string): string | undefined {
	if (!content?.startsWith("---")) {
		return undefined;
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) {
		return undefined;
	}
	const frontmatter = content.slice(3, end).split(/\r?\n/);
	for (const line of frontmatter) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match || match[1] !== key) {
			continue;
		}
		return match[2].trim().replace(/^['"]|['"]$/g, "") || undefined;
	}
	return undefined;
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function formatPathFromCwd(cwd: string, filePath: string): string {
	const absolutePath = resolve(filePath);
	const rel = relative(cwd, absolutePath);
	if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
		return rel;
	}
	const home = process.env.HOME;
	if (home && (absolutePath === home || absolutePath.startsWith(`${home}/`))) {
		return `~${absolutePath.slice(home.length)}`;
	}
	return absolutePath;
}

function packageSourceLabel(source: string | undefined): string | undefined {
	if (!source) {
		return undefined;
	}
	const github = source.match(/^git:github\.com\/([^@]+)(?:@.*)?$/);
	if (github) {
		return github[1];
	}
	const npm = source.match(/^npm:(.+)$/);
	if (npm) {
		return npm[1];
	}
	return source;
}

function labelSkill(resource: ResolvedResource): string {
	const content = readText(resource.path);
	return parseFrontmatterValue(content, "name") ?? basename(dirname(resource.path));
}

function labelPrompt(resource: ResolvedResource): string {
	const content = readText(resource.path);
	const name = parseFrontmatterValue(content, "name") ?? basename(resource.path, extname(resource.path));
	return `/${name}`;
}

function labelExtension(resource: ResolvedResource): string {
	const sourceLabel = packageSourceLabel(resource.metadata.source);
	const fileLabel = basename(resource.path);
	return sourceLabel ? `${sourceLabel}:${fileLabel}` : fileLabel;
}

function labelTheme(resource: ResolvedResource): string {
	try {
		const theme = JSON.parse(readFileSync(resource.path, "utf8"));
		if (typeof theme.name === "string" && theme.name.trim()) {
			return theme.name.trim();
		}
	} catch {
		// fall through to filename
	}
	return basename(resource.path, extname(resource.path));
}

function getAvailableThinkingLevels(model: ReasoningModel | undefined): ThinkingLevel[] {
	if (!model) {
		return FALLBACK_THINKING_LEVELS;
	}
	if (!model.reasoning) {
		return ["off"];
	}

	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) {
			return false;
		}
		if (level === "xhigh") {
			return mapped !== undefined;
		}
		return true;
	});
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}

function formatThinkingLevelOption(level: ThinkingLevel, currentLevel: ThinkingLevel): string {
	const marker = level === currentLevel ? "✓" : " ";
	return `${marker} ${level} — ${THINKING_LEVEL_DESCRIPTIONS[level]}`;
}

function parseThinkingLevelOption(option: string): ThinkingLevel | undefined {
	return THINKING_LEVELS.find((level) => option.includes(` ${level} —`));
}

async function collectStartupResources(cwd: string): Promise<StartupResources> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	const enabled = (resources: ResolvedResource[]) => resources.filter((resource) => resource.enabled && existsSync(resource.path));

	return {
		context: loadProjectContextFiles({ cwd, agentDir }).map((contextFile) => formatPathFromCwd(cwd, contextFile.path)),
		skills: uniqueSorted(enabled(resolved.skills).map(labelSkill)),
		prompts: uniqueSorted(enabled(resolved.prompts).map(labelPrompt)),
		extensions: uniqueSorted(enabled(resolved.extensions).map(labelExtension)),
		themes: uniqueSorted(enabled(resolved.themes).map(labelTheme)),
	};
}

function createTlhHeader(theme: Theme, resources: StartupResources) {
	let expanded = false;
	const tlhVersion = getTlhVersion();

	const color = {
		heading: (text: string) => theme.fg("mdHeading", text),
		dim: (text: string) => theme.fg("dim", text),
		muted: (text: string) => theme.fg("muted", text),
		accent: (text: string) => theme.fg("accent", text),
	};

	const key = (id: string, fallback: string) => keyText(id) || fallback;
	const hint = (keyName: string, label: string) => `${color.dim(keyName)}${color.muted(` ${label}`)}`;
	const logo = `${theme.bold(color.accent(TLH_NAME))}${color.dim(` v${tlhVersion}`)}  ${color.muted("pi")}${color.dim(` v${PI_VERSION}`)}`;
	const compactInstructions = [
		hint(key("app.interrupt", "escape"), "interrupt"),
		hint(`${key("app.clear", "ctrl+c")}/${key("app.exit", "ctrl+d")}`, "clear/exit"),
		hint("/", "commands"),
		hint("!", "bash"),
		hint(key("app.tools.expand", "ctrl+o"), "more"),
	].join(color.muted(" · "));

	const section = (name: string, items: string[]): string[] => {
		if (items.length === 0) {
			return [];
		}
		return [color.heading(`[${name}]`), color.dim(`  ${items.join(", ")}`)];
	};

	const renderCollapsed = () => {
		const lines = [logo, compactInstructions];
		const contextLines = section("Context", resources.context);
		if (contextLines.length > 0) {
			lines.push("", ...contextLines);
		}
		return lines;
	};

	const renderExpanded = () => {
		const lines = renderCollapsed();
		const resourceSections = [
			section("Skills", resources.skills),
			section("Prompts", resources.prompts),
			section("Extensions", resources.extensions),
			section("Themes", resources.themes),
		].filter((resourceSection) => resourceSection.length > 0);

		for (const resourceSection of resourceSections) {
			lines.push("", ...resourceSection);
		}
		return lines;
	};

	return {
		render(_width: number): string[] {
			return expanded ? renderExpanded() : renderCollapsed();
		},
		setExpanded(nextExpanded: boolean) {
			expanded = nextExpanded;
		},
		invalidate() {},
	};
}

export default function theLastHarness(pi: ExtensionAPI) {
	pi.registerCommand("tlh", {
		description: "Show tlh package status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${TLH_PACKAGE_NAME} (${TLH_NAME}) profile is installed and active.`, "info");
		},
	});

	pi.registerCommand("harness", {
		description: "Alias for /tlh",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${TLH_PACKAGE_NAME} (${TLH_NAME}) profile is installed and active.`, "info");
		},
	});

	pi.registerCommand("effort", {
		description: "Pick the model reasoning effort / thinking level",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const completions = THINKING_LEVELS.filter((level) => level.startsWith(normalizedPrefix)).map((level) => ({
				value: level,
				label: level,
				description: THINKING_LEVEL_DESCRIPTIONS[level],
			}));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args, ctx) => {
			const currentLevel = pi.getThinkingLevel();
			const availableLevels = getAvailableThinkingLevels(ctx.model as ReasoningModel | undefined);
			const requestedLevel = args.trim().toLowerCase();

			if (requestedLevel) {
				if (!isThinkingLevel(requestedLevel)) {
					ctx.ui.notify(`Unknown effort "${args.trim()}". Available: ${availableLevels.join(", ")}.`, "error");
					return;
				}
				if (!availableLevels.includes(requestedLevel)) {
					ctx.ui.notify(`Effort "${requestedLevel}" is not available for the current model. Available: ${availableLevels.join(", ")}.`, "warning");
					return;
				}
				pi.setThinkingLevel(requestedLevel);
				ctx.ui.notify(`Effort set to ${pi.getThinkingLevel()}.`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(`Available efforts: ${availableLevels.join(", ")}. Current: ${currentLevel}.`, "info");
				return;
			}

			const options = availableLevels.map((level) => formatThinkingLevelOption(level, currentLevel));
			const selected = await ctx.ui.select("Pick reasoning effort", options);
			const selectedLevel = selected ? parseThinkingLevelOption(selected) : undefined;
			if (!selectedLevel) {
				return;
			}

			pi.setThinkingLevel(selectedLevel);
			ctx.ui.notify(`Effort set to ${pi.getThinkingLevel()}.`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		let resources: StartupResources = { context: [], skills: [], prompts: [], extensions: [], themes: [] };
		try {
			resources = await collectStartupResources(ctx.cwd);
		} catch {
			// Keep startup resilient. The header can still render without resource details.
		}

		ctx.ui.setHeader((_tui, theme) => createTlhHeader(theme, resources));
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n${HARNESS_PROMPT}`,
	}));
}
