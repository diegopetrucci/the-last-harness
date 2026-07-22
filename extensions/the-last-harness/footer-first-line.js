import { formatTlhGitFooterSegments } from "./footer-git.js";
export const FOOTER_FIRST_LINE_SEPARATOR = " • ";
export function composeTlhFooterFirstLine(input) {
    const segments = [input.cwd];
    if (input.status !== undefined) {
        for (const segment of formatTlhGitFooterSegments(input.status, input.pullRequest)) {
            segments.push(segment);
        }
    }
    else if (input.fallbackBranch) {
        segments.push(input.fallbackBranch);
    }
    if (input.sessionName) {
        segments.push(input.sessionName);
    }
    return segments.join(FOOTER_FIRST_LINE_SEPARATOR);
}
