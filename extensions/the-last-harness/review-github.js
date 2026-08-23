export function isGhGraphqlQuotaFailure(stderr) {
    return /graphql/i.test(stderr) && /(rate limit|quota|submitted too quickly)/i.test(stderr);
}
function parseGitHubPrUrl(value) {
    try {
        const url = new URL(value);
        if (url.hostname !== "github.com") {
            return undefined;
        }
        const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
        if (!match) {
            return undefined;
        }
        return { owner: match[1], repo: match[2], number: Number.parseInt(match[3], 10) };
    }
    catch {
        return undefined;
    }
}
function parseGitHubRepoSlug(value) {
    const match = value.trim().match(/^([^/\s]+)\/([^/\s]+)$/u);
    if (!match) {
        return undefined;
    }
    return { owner: match[1], repo: match[2] };
}
function parseGitHubRemoteUrl(value) {
    const trimmed = value.trim();
    const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (sshMatch) {
        return { owner: sshMatch[1], repo: sshMatch[2] };
    }
    try {
        const url = new URL(trimmed);
        if (url.hostname !== "github.com") {
            return undefined;
        }
        const match = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
        if (!match) {
            return undefined;
        }
        return { owner: match[1], repo: match[2] };
    }
    catch {
        return undefined;
    }
}
async function resolveGitHubRepoRefFromGhDefault(pi, cwd) {
    const defaultRepoResult = await pi.exec("gh", ["repo", "set-default", "--view"], { cwd });
    if (defaultRepoResult.code !== 0) {
        return undefined;
    }
    for (const line of defaultRepoResult.stdout.split(/\r?\n/u)) {
        const repoRef = parseGitHubRepoSlug(line);
        if (repoRef) {
            return repoRef;
        }
    }
    return undefined;
}
async function resolveGitHubRepoRefFromLocalRemotes(pi, cwd) {
    const remoteListResult = await pi.exec("git", ["remote"], { cwd });
    if (remoteListResult.code !== 0) {
        const firstLine = remoteListResult.stderr.split("\n")[0]?.trim() || "git remote failed";
        return { ok: false, message: `could not list git remotes: ${firstLine}` };
    }
    const remoteNames = remoteListResult.stdout
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean);
    if (remoteNames.length === 0) {
        return {
            ok: false,
            message: "could not resolve GitHub repository because this repo has no git remotes",
        };
    }
    const orderedRemoteNames = Array.from(new Set(["origin", ...remoteNames]));
    const remoteFailures = [];
    for (const remoteName of orderedRemoteNames) {
        const remoteUrlResult = await pi.exec("git", ["remote", "get-url", remoteName], { cwd });
        if (remoteUrlResult.code !== 0) {
            const firstLine = remoteUrlResult.stderr.split("\n")[0]?.trim() || `git remote get-url ${remoteName} failed`;
            remoteFailures.push(`${remoteName}: ${firstLine}`);
            continue;
        }
        const repoRef = parseGitHubRemoteUrl(remoteUrlResult.stdout);
        if (repoRef) {
            return { ok: true, repoRef };
        }
        remoteFailures.push(`${remoteName}: unsupported remote URL '${remoteUrlResult.stdout.trim()}'`);
    }
    return {
        ok: false,
        message: `could not parse a GitHub owner/repo from local git remotes (${remoteFailures.join("; ")})`,
    };
}
export async function resolveGitHubPrRef(pi, cwd, nOrUrl, prNumberHint) {
    const urlRef = parseGitHubPrUrl(nOrUrl);
    if (urlRef) {
        return { ok: true, prRef: urlRef };
    }
    if (prNumberHint === undefined) {
        return { ok: false, message: `could not resolve a PR number from '${nOrUrl}'` };
    }
    const ghDefaultRepoRef = await resolveGitHubRepoRefFromGhDefault(pi, cwd);
    if (ghDefaultRepoRef) {
        return { ok: true, prRef: { ...ghDefaultRepoRef, number: prNumberHint } };
    }
    const repoRefResult = await resolveGitHubRepoRefFromLocalRemotes(pi, cwd);
    if (repoRefResult.ok === false) {
        return { ok: false, message: repoRefResult.message };
    }
    return { ok: true, prRef: { ...repoRefResult.repoRef, number: prNumberHint } };
}
export async function fetchPrMetadataViaRest(pi, cwd, prRef) {
    const result = await pi.exec("gh", ["api", `repos/${prRef.owner}/${prRef.repo}/pulls/${prRef.number}`], { cwd });
    if (result.code !== 0) {
        const firstLine = result.stderr.split("\n")[0]?.trim() || "gh api failed";
        return { ok: false, message: firstLine };
    }
    try {
        const payload = JSON.parse(result.stdout);
        const number = typeof payload.number === "number" ? payload.number : prRef.number;
        const headRefName = payload.head?.ref;
        const baseRefName = payload.base?.ref;
        if (!headRefName || !baseRefName) {
            return { ok: false, message: "REST PR metadata response was missing head/base refs" };
        }
        return {
            ok: true,
            prData: {
                number,
                headRefName,
                baseRefName,
                isCrossRepository: typeof payload.head?.repo?.full_name === "string" &&
                    typeof payload.base?.repo?.full_name === "string"
                    ? payload.head.repo.full_name !== payload.base.repo.full_name
                    : false,
            },
        };
    }
    catch {
        return { ok: false, message: "Could not parse REST PR metadata response" };
    }
}
export async function fetchPrDiffViaRest(pi, cwd, prRef) {
    const result = await pi.exec("gh", [
        "api",
        "-H",
        "Accept: application/vnd.github.v3.diff",
        `repos/${prRef.owner}/${prRef.repo}/pulls/${prRef.number}`,
    ], { cwd });
    if (result.code !== 0) {
        const firstLine = result.stderr.split("\n")[0]?.trim() || "gh api failed";
        return { ok: false, message: firstLine };
    }
    return { ok: true, diff: result.stdout };
}
