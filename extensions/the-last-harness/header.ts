import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TLH_HEADER_TOGGLE_SHORTCUT_LABEL, TLH_NAME } from "./constants.js";
import { formatTlhInstallNoticeTrackLabel } from "./install-state.js";
import type { StartupResources, TlhHeaderUpdate, TlhInstallNotice } from "./types.js";

export function createTlhHeader(
	theme: Theme,
	resources: StartupResources,
	headerUpdate: TlhHeaderUpdate | undefined,
	installNotice?: TlhInstallNotice,
	options: { requestRender?: () => void; startupTip?: string } = {},
) {
	let expanded = false;
	const color = {
		heading: (text: string) => theme.fg("mdHeading", text),
		dim: (text: string) => theme.fg("dim", text),
		accent: (text: string) => theme.fg("accent", text),
		warning: (text: string) => theme.fg("warning", text),
	};

	const logo = headerUpdate
		? `${theme.bold(color.accent(TLH_NAME))}${color.dim(` v${headerUpdate.version}`)} ${color.accent(headerUpdate.releasesUrl)}`
		: theme.bold(color.accent(TLH_NAME));

	const section = (name: string, items: string[], width: number): string[] => {
		if (items.length === 0) {
			return [];
		}
		const heading = truncateToWidth(color.heading(`[${name}]`), width, color.dim("..."));

		// Wrap items across multiple lines, splitting on ", " boundaries (never mid-item).
		const prefix = "  ";
		const wrappedLines: string[] = [];
		let currentLine = prefix;

		for (const item of items) {
			const isFirstOnLine = currentLine === prefix;
			const candidate = isFirstOnLine ? prefix + item : currentLine + ", " + item;

			if (isFirstOnLine || visibleWidth(candidate) <= width - 2) {
				currentLine = candidate;
			} else {
				// Non-final line: append ", " separator if it fits, otherwise push bare.
				// The isFirstOnLine force-accept can leave currentLine near or at `width`,
				// so appending ", " would overflow the terminal width.
				if (visibleWidth(currentLine + ", ") > width) {
					wrappedLines.push(color.dim(currentLine));
				} else {
					wrappedLines.push(color.dim(currentLine + ", "));
				}
				currentLine = prefix + item;
			}
		}
		// Final line: no trailing ", ".
		wrappedLines.push(color.dim(currentLine));

		return [heading, ...wrappedLines];
	};

	const installWarningLine = (width: number): string[] => {
		if (!installNotice) {
			return [];
		}
		const label = formatTlhInstallNoticeTrackLabel(installNotice);
		const warningLine = `${color.warning("Warning")}${color.dim(`: running TLH from ${label} track`)}`;
		return [truncateToWidth(warningLine, width, color.dim("..."))];
	};

	const contextLine = (items: string[], width: number): string[] => {
		if (items.length === 0) {
			return [];
		}
		return [truncateToWidth(color.dim(`Context: ${items.join(", ")}`), width, color.dim("..."))];
	};

	const startupTipLine = (width: number): string[] => {
		if (!options.startupTip) {
			return [];
		}
		return [truncateToWidth(color.dim(`Tip: ${options.startupTip}`), width, color.dim("..."))];
	};

	const collapsedHintLine = (width: number): string => truncateToWidth(
		color.dim(`${TLH_HEADER_TOGGLE_SHORTCUT_LABEL} to show skills, prompts, extensions, themes`),
		width,
		color.dim("..."),
	);

	const headerDetails = (width: number): string[] => [
		...installWarningLine(width),
		...contextLine(resources.context, width),
		...startupTipLine(width),
	];

	const renderCollapsed = (width: number) => {
		const lines = [logo, "", ...headerDetails(width), collapsedHintLine(width)];
		return lines;
	};

	const renderExpanded = (width: number) => {
		const lines = [logo];
		const details = headerDetails(width);
		if (details.length > 0) {
			lines.push("", ...details);
		}
		const resourceSections = [
			section("Skills", resources.skills, width),
			section("Prompts", resources.prompts, width),
			section("Extensions", resources.extensions, width),
			section("Themes", resources.themes, width),
		].filter((resourceSection) => resourceSection.length > 0);

		for (const resourceSection of resourceSections) {
			lines.push("", ...resourceSection);
		}
		return lines;
	};

	return {
		render(width: number): string[] {
			return expanded ? renderExpanded(width) : renderCollapsed(width);
		},
		setExpanded(nextExpanded: boolean) {
			expanded = nextExpanded;
		},
		toggleExpanded() {
			expanded = !expanded;
			options.requestRender?.();
		},
		invalidate() {},
	};
}
