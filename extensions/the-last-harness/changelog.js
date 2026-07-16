import { readFileSync } from "node:fs";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, matchesKey } from "@earendil-works/pi-tui";
const TLH_CHANGELOG_PATH = new URL("../../CHANGELOG.md", import.meta.url);
export const TLH_CHANGELOG_COMMAND_DESCRIPTION = "Show TLH release notes from the packaged changelog";
const TLH_RELEASE_NOTES_LABEL = "TLH release notes";
const TLH_RELEASE_NOTES_TITLE = "TLH Release Notes";
const TLH_CHANGELOG_CLOSE_HINT = "Press Enter or Esc to close";
function readTlhChangelog() {
    return readFileSync(TLH_CHANGELOG_PATH, "utf8");
}
async function showTlhChangelogUi(changelog, ctx) {
    if (!ctx.hasUI) {
        return false;
    }
    let rendered = false;
    await ctx.ui.custom((_tui, theme, _kb, done) => {
        rendered = true;
        const container = new Container();
        const border = new DynamicBorder((segment) => theme.fg("accent", segment));
        const markdownTheme = getMarkdownTheme();
        container.addChild(border);
        container.addChild(new Text(theme.fg("accent", theme.bold(TLH_RELEASE_NOTES_TITLE)), 1, 0));
        container.addChild(new Markdown(changelog, 1, 1, markdownTheme));
        container.addChild(new Text(theme.fg("dim", TLH_CHANGELOG_CLOSE_HINT), 1, 0));
        container.addChild(border);
        return {
            render: (width) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
                if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
                    done(undefined);
                }
            },
        };
    });
    return rendered;
}
export async function handleTlhChangelogCommand(pi, _args, ctx) {
    let changelog;
    try {
        changelog = readTlhChangelog();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not load TLH release notes: ${message}`, "error");
        return;
    }
    if (await showTlhChangelogUi(changelog, ctx)) {
        return;
    }
    // RPC/print modes cannot host a custom markdown component. Fall back to a displayed
    // custom message without triggering a turn, which keeps the release notes visible but
    // also persists the changelog text in session history/context until it is compacted away.
    pi.sendMessage({
        customType: TLH_RELEASE_NOTES_LABEL,
        content: changelog,
        display: true,
        details: { title: TLH_RELEASE_NOTES_TITLE },
    });
}
export function registerTlhChangelogCommand(pi) {
    pi.registerCommand("tlh-changelog", {
        description: TLH_CHANGELOG_COMMAND_DESCRIPTION,
        handler: async (args, ctx) => handleTlhChangelogCommand(pi, args, ctx),
    });
}
