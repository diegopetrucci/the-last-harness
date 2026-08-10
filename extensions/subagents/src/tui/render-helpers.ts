import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase();
	const lt = text.toLowerCase();
	if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
	let score = 0;
	let qi = 0;
	let consecutive = 0;
	for (let i = 0; i < lt.length && qi < lq.length; i++) {
		if (lt[i] === lq[qi]) {
			score += 10 + consecutive;
			consecutive += 5;
			qi++;
		} else {
			consecutive = 0;
		}
	}
	return qi === lq.length ? score : 0;
}

export function fuzzyFilter<T extends { name: string; description: string; model?: string }>(
	items: T[],
	query: string,
): T[] {
	const q = query.trim();
	if (!q) return items;
	return items
		.map((item) => ({
			item,
			score: Math.max(
				fuzzyScore(q, item.name),
				fuzzyScore(q, item.description) * 0.8,
				fuzzyScore(q, item.model ?? "") * 0.6,
			),
		}))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.item);
}

export function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

export function row(content: string, width: number, theme: Theme): string {
	if (width <= 0) return "";
	const normalized = content.replace(/\t/g, "  ");
	if (width < 3) return wrapTextWithAnsi(normalized, width).join("\n");
	const innerW = width - 2;
	return wrapTextWithAnsi(normalized, innerW)
		.map((line) => theme.fg("border", "│") + pad(line, innerW) + theme.fg("border", "│"))
		.join("\n");
}

export function renderHeader(text: string, width: number, theme: Theme): string {
	if (width <= 0) return "";
	if (width < 3) return wrapTextWithAnsi(text, width).join("\n");
	const innerW = width - 2;
	return wrapTextWithAnsi(text, innerW)
		.map((line, index) => {
			const padLen = Math.max(0, innerW - visibleWidth(line));
			const padLeft = Math.floor(padLen / 2);
			const padRight = padLen - padLeft;
			if (index === 0) {
				return (
					theme.fg("border", "╭" + "─".repeat(padLeft)) +
					theme.fg("accent", line) +
					theme.fg("border", "─".repeat(padRight) + "╮")
				);
			}
			return (
				theme.fg("border", "│" + " ".repeat(padLeft)) +
				theme.fg("accent", line) +
				theme.fg("border", " ".repeat(padRight) + "│")
			);
		})
		.join("\n");
}

export function formatPath(filePath: string): string {
	const home = process.env.HOME;
	if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

export function formatScrollInfo(above: number, below: number): string {
	let info = "";
	if (above > 0) info += `↑ ${above} more`;
	if (below > 0) info += `${info ? "  " : ""}↓ ${below} more`;
	return info;
}

export function renderFooter(text: string, width: number, theme: Theme): string {
	if (width <= 0) return "";
	if (width < 3) return wrapTextWithAnsi(text, width).join("\n");
	const innerW = width - 2;
	const lines = wrapTextWithAnsi(text, innerW);
	return lines
		.map((line, index) => {
			const padLen = Math.max(0, innerW - visibleWidth(line));
			const padLeft = Math.floor(padLen / 2);
			const padRight = padLen - padLeft;
			if (index === lines.length - 1) {
				return (
					theme.fg("border", "╰" + "─".repeat(padLeft)) +
					theme.fg("dim", line) +
					theme.fg("border", "─".repeat(padRight) + "╯")
				);
			}
			return (
				theme.fg("border", "│" + " ".repeat(padLeft)) +
				theme.fg("dim", line) +
				theme.fg("border", " ".repeat(padRight) + "│")
			);
		})
		.join("\n");
}
