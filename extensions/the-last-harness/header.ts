import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TLH_NAME } from "./constants.js";
import type { StartupResources, TlhHeaderUpdate } from "./types.js";

export function createTlhHeader(theme: Theme, resources: StartupResources, headerUpdate: TlhHeaderUpdate | undefined) {
	let expanded = false;
	const color = {
		heading: (text: string) => theme.fg("mdHeading", text),
		dim: (text: string) => theme.fg("dim", text),
		accent: (text: string) => theme.fg("accent", text),
	};

	const logo = headerUpdate
		? `${theme.bold(color.accent(TLH_NAME))}${color.dim(` v${headerUpdate.version}`)} ${color.accent(headerUpdate.releasesUrl)}`
		: theme.bold(color.accent(TLH_NAME));

	const section = (name: string, items: string[]): string[] => {
		if (items.length === 0) {
			return [];
		}
		return [color.heading(`[${name}]`), color.dim(`  ${items.join(", ")}`)];
	};

	const contextLine = (items: string[], width: number): string[] => {
		if (items.length === 0) {
			return [];
		}
		return [truncateToWidth(color.dim(`Context: ${items.join(", ")}`), width, color.dim("..."))];
	};

	const renderCollapsed = (width: number) => {
		const lines = [logo];
		const contextLines = contextLine(resources.context, width);
		if (contextLines.length > 0) {
			lines.push("", ...contextLines);
		}
		return lines;
	};

	const renderExpanded = (width: number) => {
		const lines = renderCollapsed(width);
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
		render(width: number): string[] {
			return expanded ? renderExpanded(width) : renderCollapsed(width);
		},
		setExpanded(nextExpanded: boolean) {
			expanded = nextExpanded;
		},
		invalidate() {},
	};
}
