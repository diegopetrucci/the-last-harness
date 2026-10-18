// Generated from extensions/the-last-harness/footer-first-line.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { formatTlhGitFooterSegments, } from "./footer-git.js";
const FOOTER_FIRST_LINE_SEPARATOR = " • ";
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
