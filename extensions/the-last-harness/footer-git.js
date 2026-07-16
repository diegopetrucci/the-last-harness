const BRANCH_HEAD_PREFIX = "# branch.head ";
const BRANCH_AB_PREFIX = "# branch.ab ";
function createEmptyGitStatus() {
    return {
        branch: undefined,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflict: 0,
        ahead: 0,
        behind: 0,
    };
}
function positiveCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
function addTrackedStatusCounts(status, xy) {
    if (xy.length !== 2) {
        return;
    }
    if (xy[0] !== ".") {
        status.staged += 1;
    }
    if (xy[1] !== ".") {
        status.unstaged += 1;
    }
}
function parseBranchAheadBehind(line, status) {
    const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
    if (!match) {
        return;
    }
    status.ahead = Number.parseInt(match[1], 10);
    status.behind = Number.parseInt(match[2], 10);
}
function normalizeBranchHead(value) {
    const branch = value.trim();
    return branch === "(detached)" ? "detached" : branch;
}
export function parseGitStatusPorcelainV2(output) {
    const status = createEmptyGitStatus();
    if (typeof output !== "string") {
        return status;
    }
    for (const rawLine of output.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line) {
            continue;
        }
        if (line.startsWith(BRANCH_HEAD_PREFIX)) {
            status.branch = normalizeBranchHead(line.slice(BRANCH_HEAD_PREFIX.length)) || undefined;
            continue;
        }
        if (line.startsWith(BRANCH_AB_PREFIX)) {
            parseBranchAheadBehind(line, status);
            continue;
        }
        if (line.startsWith("1 ") || line.startsWith("2 ")) {
            addTrackedStatusCounts(status, line.slice(2, 4));
            continue;
        }
        if (line.startsWith("u ")) {
            status.conflict += 1;
            continue;
        }
        if (line.startsWith("? ")) {
            status.untracked += 1;
        }
    }
    return status;
}
export function formatGitStatusFooterSegment(status) {
    if (!status) {
        return undefined;
    }
    const parts = [];
    const indicators = [
        ["!", positiveCount(status.conflict)],
        ["+", positiveCount(status.staged)],
        ["~", positiveCount(status.unstaged)],
        ["?", positiveCount(status.untracked)],
        ["↑", positiveCount(status.ahead)],
        ["↓", positiveCount(status.behind)],
    ];
    for (const [prefix, count] of indicators) {
        if (count > 0) {
            parts.push(`${prefix}${count}`);
        }
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
}
export function formatPullRequestFooterSegment(pullRequest) {
    const value = pullRequest?.number;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        return `PR #${value}`;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (/^[1-9]\d*$/.test(trimmed)) {
            return `PR #${trimmed}`;
        }
    }
    return undefined;
}
export function formatTlhGitFooterSegments(status, pullRequest) {
    const segments = [];
    const branch = typeof status?.branch === "string" ? status.branch.trim() : "";
    if (branch) {
        segments.push(branch);
    }
    const statusSegment = formatGitStatusFooterSegment(status);
    if (statusSegment) {
        segments.push(statusSegment);
    }
    const pullRequestSegment = formatPullRequestFooterSegment(pullRequest);
    if (pullRequestSegment) {
        segments.push(pullRequestSegment);
    }
    return segments;
}
