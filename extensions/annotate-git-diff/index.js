import { readSystemClipboard, writeSystemClipboard } from "./clipboard.js";
import { getCommitFiles, getReviewWindowData, loadReviewFileContents } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import { openQuietGlimpse } from "../shared/quiet-glimpse.js";
import { buildReviewHtml } from "./ui.js";
import { createRepoChangeWatcher } from "./watch.js";
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isString(value) {
    return typeof value === "string";
}
function isNullableString(value) {
    return value == null || typeof value === "string";
}
function isCommentSide(value) {
    return value === "original" || value === "modified" || value === "file";
}
function isReviewScope(value) {
    return value === "branch" || value === "commits" || value === "all";
}
function isReviewCommitKind(value) {
    return value == null || value === "commit" || value === "working-tree";
}
function hasNullableInteger(value, key) {
    if (!Object.prototype.hasOwnProperty.call(value, key))
        return false;
    const field = value[key];
    return field === null || (typeof field === "number" && Number.isInteger(field));
}
function isDiffReviewComment(value) {
    if (!isRecord(value))
        return false;
    return (isString(value.id) &&
        isString(value.fileId) &&
        isReviewScope(value.scope) &&
        isNullableString(value.commitSha) &&
        isNullableString(value.commitShort) &&
        isReviewCommitKind(value.commitKind) &&
        isCommentSide(value.side) &&
        hasNullableInteger(value, "startLine") &&
        hasNullableInteger(value, "endLine") &&
        isString(value.body));
}
function parseWindowMessage(data) {
    if (!isRecord(data) || !isString(data.type))
        return null;
    switch (data.type) {
        case "submit":
            if (!isString(data.overallComment) || !Array.isArray(data.comments) || !data.comments.every(isDiffReviewComment)) {
                return null;
            }
            return {
                type: "submit",
                overallComment: data.overallComment,
                comments: data.comments,
                draft: data.draft !== false,
            };
        case "cancel":
            return { type: "cancel" };
        case "request-file":
            if (!isString(data.requestId) || !isString(data.fileId) || !isReviewScope(data.scope) || !isNullableString(data.commitSha)) {
                return null;
            }
            return {
                type: "request-file",
                requestId: data.requestId,
                fileId: data.fileId,
                scope: data.scope,
                commitSha: data.commitSha ?? null,
            };
        case "request-commit":
            if (!isString(data.requestId) || !isString(data.sha))
                return null;
            return {
                type: "request-commit",
                requestId: data.requestId,
                sha: data.sha,
            };
        case "request-review-data":
            if (!isString(data.requestId))
                return null;
            return {
                type: "request-review-data",
                requestId: data.requestId,
            };
        case "clipboard-read":
            if (!isString(data.requestId))
                return null;
            return {
                type: "clipboard-read",
                requestId: data.requestId,
            };
        case "clipboard-write":
            if (!isString(data.text))
                return null;
            return {
                type: "clipboard-write",
                text: data.text,
            };
        default:
            return null;
    }
}
function escapeForInlineScript(value) {
    return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
function hasReviewFeedback(payload) {
    return payload.overallComment.trim().length > 0 || payload.comments.some((comment) => comment.body.trim().length > 0);
}
function appendReviewPrompt(ctx, prompt) {
    const prefix = ctx.ui.getEditorText().trim().length > 0 ? "\n\n" : "";
    ctx.ui.pasteToEditor(`${prefix}${prompt}`);
}
export function createAnnotateGitDiffController(pi, dependencies = {}) {
    const readClipboard = dependencies.readClipboard ?? readSystemClipboard;
    const writeClipboard = dependencies.writeClipboard ?? writeSystemClipboard;
    const loadReviewWindowData = dependencies.getReviewWindowData ?? getReviewWindowData;
    const loadCommitFileList = dependencies.getCommitFiles ?? getCommitFiles;
    const loadFileContents = dependencies.loadReviewFileContents ?? loadReviewFileContents;
    const composePrompt = dependencies.composeReviewPrompt ?? composeReviewPrompt;
    const openReviewWindow = dependencies.openReviewWindow ?? openQuietGlimpse;
    const buildHtml = dependencies.buildReviewHtml ?? buildReviewHtml;
    const startRepoChangeWatcher = dependencies.createRepoChangeWatcher ?? createRepoChangeWatcher;
    const setTimer = dependencies.setTimeoutFn ?? setTimeout;
    const clearTimer = dependencies.clearTimeoutFn ?? clearTimeout;
    let activeWindow = null;
    let activeWatcher = null;
    let lifecycleGeneration = 0;
    let openingGeneration = null;
    const suppressedWindows = new WeakSet();
    function stopActiveWatcher() {
        if (activeWatcher == null)
            return;
        activeWatcher.dispose();
        activeWatcher = null;
    }
    function closeActiveWindow(options = {}) {
        if (activeWindow == null)
            return;
        const windowToClose = activeWindow;
        activeWindow = null;
        stopActiveWatcher();
        if (options.suppressResults) {
            suppressedWindows.add(windowToClose);
        }
        try {
            windowToClose.close();
        }
        catch {
        }
    }
    const handler = async (_args, ctx) => {
        if (activeWindow != null || openingGeneration != null) {
            ctx.ui.notify("A review window is already open.", "warning");
            return;
        }
        const generation = lifecycleGeneration;
        openingGeneration = generation;
        try {
            let reviewData = await loadReviewWindowData(pi, ctx.cwd);
            if (generation !== lifecycleGeneration)
                return;
            const { repoRoot } = reviewData;
            if (reviewData.files.length === 0 && reviewData.commits.length === 0) {
                ctx.ui.notify("No reviewable files found.", "info");
                return;
            }
            const html = buildHtml(reviewData);
            const window = await openReviewWindow(html, {
                width: 1680,
                height: 1020,
                title: "TLH annotate-git-diff",
            });
            if (generation !== lifecycleGeneration) {
                suppressedWindows.add(window);
                try {
                    window.close();
                }
                catch {
                }
                return;
            }
            activeWindow = window;
            openingGeneration = null;
            let reviewSnapshotVersion = 0;
            let latestRefreshRequestSequence = 0;
            const retainedImmutablePromiseVersions = new WeakMap();
            const buildSnapshotState = (nextReviewData, previousSnapshot) => {
                const version = ++reviewSnapshotVersion;
                const allFiles = new Map(nextReviewData.files.map((file) => [file.id, file]));
                const branchFiles = new Map(nextReviewData.files.filter((file) => file.inGitDiff).map((file) => [file.id, file]));
                const immutableCommitShas = new Set(nextReviewData.commits.filter((commit) => commit.kind !== "working-tree").map((commit) => commit.sha));
                const commitFilesBySha = new Map();
                const commitFileCache = new Map();
                const contentCache = new Map();
                if (previousSnapshot != null) {
                    for (const sha of immutableCommitShas) {
                        const commitFiles = previousSnapshot.commitFilesBySha.get(sha);
                        if (commitFiles != null)
                            commitFilesBySha.set(sha, commitFiles);
                        const commitPromise = previousSnapshot.commitFileCache.get(sha);
                        if (commitPromise != null) {
                            commitFileCache.set(sha, commitPromise);
                            retainedImmutablePromiseVersions.set(commitPromise, version);
                        }
                        const contentPrefix = `commits:${sha}:`;
                        for (const [cacheKey, contentPromise] of previousSnapshot.contentCache) {
                            if (!cacheKey.startsWith(contentPrefix))
                                continue;
                            contentCache.set(cacheKey, contentPromise);
                            retainedImmutablePromiseVersions.set(contentPromise, version);
                        }
                    }
                }
                return {
                    version,
                    reviewData: nextReviewData,
                    allFiles,
                    branchFiles,
                    commitFilesBySha,
                    commitFileCache,
                    contentCache,
                };
            };
            let snapshot = buildSnapshotState(reviewData);
            const advertisedCommitShas = () => new Set(snapshot.reviewData.commits.map((commit) => commit.sha));
            const isAllowedCommitSha = (sha) => advertisedCommitShas().has(sha);
            const isImmutableCommitSha = (sha) => snapshot.reviewData.commits.some((commit) => commit.sha === sha && commit.kind !== "working-tree");
            const isCurrentSnapshot = (version) => snapshot.version === version;
            const getAuthorizedFile = (requestScope, fileId, commitSha) => {
                if (requestScope === "all") {
                    return snapshot.allFiles.get(fileId) ?? null;
                }
                if (requestScope === "branch") {
                    return snapshot.branchFiles.get(fileId) ?? null;
                }
                if (commitSha == null)
                    return null;
                return snapshot.commitFilesBySha.get(commitSha)?.get(fileId) ?? null;
            };
            const getPromptFiles = () => {
                const files = new Map(snapshot.allFiles);
                for (const commitFiles of snapshot.commitFilesBySha.values()) {
                    for (const [fileId, file] of commitFiles) {
                        files.set(fileId, file);
                    }
                }
                return [...files.values()];
            };
            const sendWindowMessage = (message) => {
                if (activeWindow !== window)
                    return;
                const payload = escapeForInlineScript(JSON.stringify(message));
                window.send(`window.__reviewReceive(${payload});`);
            };
            let watcherWarningShown = false;
            activeWatcher = startRepoChangeWatcher(repoRoot, () => {
                sendWindowMessage({ type: "working-tree-changed", changedAt: Date.now() });
            }, {
                onError: (error) => {
                    if (watcherWarningShown || activeWindow !== window)
                        return;
                    watcherWarningShown = true;
                    ctx.ui.notify(`Review change watcher failed: ${error.message}`, "warning");
                },
            });
            const loadCommitFiles = (sha) => {
                const cached = snapshot.commitFileCache.get(sha);
                if (cached != null)
                    return cached;
                const pending = loadCommitFileList(pi, repoRoot, sha).catch((error) => {
                    if (snapshot.commitFileCache.get(sha) === pending) {
                        snapshot.commitFileCache.delete(sha);
                    }
                    throw error;
                });
                snapshot.commitFileCache.set(sha, pending);
                return pending;
            };
            const contentCacheKey = (file, scope, commitSha) => `${scope}:${commitSha ?? ""}:${file.id}`;
            const loadContents = (file, scope, commitSha) => {
                const cacheKey = contentCacheKey(file, scope, commitSha);
                const cached = snapshot.contentCache.get(cacheKey);
                if (cached != null)
                    return cached;
                const pending = loadFileContents(pi, repoRoot, file, scope, commitSha, snapshot.reviewData.branchMergeBaseSha).catch((error) => {
                    if (snapshot.contentCache.get(cacheKey) === pending) {
                        snapshot.contentCache.delete(cacheKey);
                    }
                    throw error;
                });
                snapshot.contentCache.set(cacheKey, pending);
                return pending;
            };
            const terminalMessagePromise = new Promise((resolve, reject) => {
                let settled = false;
                let closeTimer = null;
                const cleanup = () => {
                    if (closeTimer != null) {
                        clearTimer(closeTimer);
                        closeTimer = null;
                    }
                    window.removeListener("message", onMessage);
                    window.removeListener("closed", onClosed);
                    window.removeListener("error", onError);
                    if (activeWindow === window) {
                        activeWindow = null;
                        stopActiveWatcher();
                    }
                };
                const settle = (value) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    resolve(value);
                };
                const handleRequestFile = async (message) => {
                    if (message.scope === "commits") {
                        if (message.commitSha == null || !isAllowedCommitSha(message.commitSha)) {
                            sendWindowMessage({
                                type: "file-error",
                                requestId: message.requestId,
                                fileId: message.fileId,
                                scope: message.scope,
                                commitSha: message.commitSha ?? null,
                                message: "Unknown commit requested.",
                            });
                            return;
                        }
                    }
                    else if (message.commitSha != null) {
                        sendWindowMessage({
                            type: "file-error",
                            requestId: message.requestId,
                            fileId: message.fileId,
                            scope: message.scope,
                            commitSha: message.commitSha,
                            message: "Unexpected commit requested for this scope.",
                        });
                        return;
                    }
                    const requestCommitSha = message.commitSha ?? null;
                    const snapshotVersion = snapshot.version;
                    const file = getAuthorizedFile(message.scope, message.fileId, requestCommitSha);
                    if (file == null) {
                        sendWindowMessage({
                            type: "file-error",
                            requestId: message.requestId,
                            fileId: message.fileId,
                            scope: message.scope,
                            commitSha: requestCommitSha,
                            message: "Unknown file requested.",
                        });
                        return;
                    }
                    const cacheKey = contentCacheKey(file, message.scope, requestCommitSha);
                    const pendingContents = loadContents(file, message.scope, requestCommitSha);
                    const canFinishRequest = (allowRetainedRejection = false) => {
                        if (getAuthorizedFile(message.scope, message.fileId, requestCommitSha) !== file)
                            return false;
                        if (isCurrentSnapshot(snapshotVersion))
                            return true;
                        if (message.scope !== "commits" || requestCommitSha == null || !isImmutableCommitSha(requestCommitSha)) {
                            return false;
                        }
                        return (snapshot.contentCache.get(cacheKey) === pendingContents ||
                            (allowRetainedRejection && retainedImmutablePromiseVersions.get(pendingContents) === snapshot.version));
                    };
                    try {
                        const contents = await pendingContents;
                        if (!canFinishRequest())
                            return;
                        sendWindowMessage({
                            type: "file-data",
                            requestId: message.requestId,
                            fileId: message.fileId,
                            scope: message.scope,
                            commitSha: requestCommitSha,
                            originalContent: contents.originalContent,
                            modifiedContent: contents.modifiedContent,
                            kind: contents.kind,
                            mimeType: contents.mimeType,
                            originalExists: contents.originalExists,
                            modifiedExists: contents.modifiedExists,
                            originalPreviewUrl: contents.originalPreviewUrl,
                            modifiedPreviewUrl: contents.modifiedPreviewUrl,
                        });
                    }
                    catch (error) {
                        if (!canFinishRequest(true))
                            return;
                        const messageText = error instanceof Error ? error.message : String(error);
                        sendWindowMessage({
                            type: "file-error",
                            requestId: message.requestId,
                            fileId: message.fileId,
                            scope: message.scope,
                            commitSha: requestCommitSha,
                            message: messageText,
                        });
                    }
                };
                const handleRequestCommit = async (message) => {
                    if (!isAllowedCommitSha(message.sha)) {
                        sendWindowMessage({
                            type: "commit-error",
                            requestId: message.requestId,
                            sha: message.sha,
                            message: "Unknown commit requested.",
                        });
                        return;
                    }
                    const snapshotVersion = snapshot.version;
                    const pendingCommitFiles = loadCommitFiles(message.sha);
                    const canFinishRequest = (allowRetainedRejection = false) => {
                        if (!isAllowedCommitSha(message.sha))
                            return false;
                        if (isCurrentSnapshot(snapshotVersion))
                            return true;
                        if (!isImmutableCommitSha(message.sha))
                            return false;
                        return (snapshot.commitFileCache.get(message.sha) === pendingCommitFiles ||
                            (allowRetainedRejection && retainedImmutablePromiseVersions.get(pendingCommitFiles) === snapshot.version));
                    };
                    try {
                        const commitFiles = await pendingCommitFiles;
                        if (!canFinishRequest())
                            return;
                        snapshot.commitFilesBySha.set(message.sha, new Map(commitFiles.map((file) => [file.id, file])));
                        sendWindowMessage({
                            type: "commit-data",
                            requestId: message.requestId,
                            sha: message.sha,
                            files: commitFiles,
                        });
                    }
                    catch (error) {
                        if (!canFinishRequest(true))
                            return;
                        const messageText = error instanceof Error ? error.message : String(error);
                        sendWindowMessage({
                            type: "commit-error",
                            requestId: message.requestId,
                            sha: message.sha,
                            message: messageText,
                        });
                    }
                };
                const handleRequestReviewData = async (message) => {
                    const refreshRequestSequence = ++latestRefreshRequestSequence;
                    try {
                        const nextReviewData = await loadReviewWindowData(pi, repoRoot);
                        if (refreshRequestSequence !== latestRefreshRequestSequence)
                            return;
                        reviewData = nextReviewData;
                        snapshot = buildSnapshotState(nextReviewData, snapshot);
                        sendWindowMessage({
                            type: "review-data",
                            requestId: message.requestId,
                            files: snapshot.reviewData.files,
                            commits: snapshot.reviewData.commits,
                            branchBaseRef: snapshot.reviewData.branchBaseRef,
                            branchMergeBaseSha: snapshot.reviewData.branchMergeBaseSha,
                            repositoryHasHead: snapshot.reviewData.repositoryHasHead,
                        });
                    }
                    catch (error) {
                        if (refreshRequestSequence !== latestRefreshRequestSequence)
                            return;
                        const messageText = error instanceof Error ? error.message : String(error);
                        sendWindowMessage({
                            type: "review-data-error",
                            requestId: message.requestId,
                            message: messageText,
                        });
                    }
                };
                const handleClipboardRead = (message) => {
                    try {
                        sendWindowMessage({
                            type: "clipboard-data",
                            requestId: message.requestId,
                            text: readClipboard(),
                        });
                    }
                    catch (error) {
                        const messageText = error instanceof Error ? error.message : String(error);
                        sendWindowMessage({
                            type: "clipboard-data",
                            requestId: message.requestId,
                            text: "",
                            message: messageText,
                        });
                    }
                };
                const handleClipboardWrite = (message) => {
                    try {
                        writeClipboard(message.text);
                    }
                    catch (error) {
                        const messageText = error instanceof Error ? error.message : String(error);
                        ctx.ui.notify(`Failed to copy from review window: ${messageText}`, "warning");
                    }
                };
                const onMessage = (data) => {
                    const message = parseWindowMessage(data);
                    if (message == null)
                        return;
                    if (message.type === "request-file") {
                        void handleRequestFile(message);
                        return;
                    }
                    if (message.type === "request-commit") {
                        void handleRequestCommit(message);
                        return;
                    }
                    if (message.type === "request-review-data") {
                        void handleRequestReviewData(message);
                        return;
                    }
                    if (message.type === "clipboard-read") {
                        handleClipboardRead(message);
                        return;
                    }
                    if (message.type === "clipboard-write") {
                        handleClipboardWrite(message);
                        return;
                    }
                    settle(message);
                };
                const onClosed = () => {
                    if (settled || closeTimer != null)
                        return;
                    closeTimer = setTimer(() => {
                        closeTimer = null;
                        settle(null);
                    }, 250);
                };
                const onError = (error) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    reject(error);
                };
                window.on("message", onMessage);
                window.on("closed", onClosed);
                window.on("error", onError);
            });
            void (async () => {
                try {
                    const message = await terminalMessagePromise;
                    if (suppressedWindows.has(window))
                        return;
                    if (message == null)
                        return;
                    if (message.type === "cancel") {
                        ctx.ui.notify("Review cancelled.", "info");
                        return;
                    }
                    if (!hasReviewFeedback(message))
                        return;
                    const prompt = composePrompt(getPromptFiles(), message);
                    if (message.draft === true) {
                        appendReviewPrompt(ctx, prompt);
                        ctx.ui.notify("Appended review feedback to the editor.", "info");
                    }
                    else {
                        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
                        ctx.ui.notify("Review feedback sent to the agent.", "info");
                    }
                }
                catch (error) {
                    if (suppressedWindows.has(window))
                        return;
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Review failed: ${message}`, "error");
                }
            })();
            ctx.ui.notify("Opened native review window.", "info");
        }
        catch (error) {
            if (generation !== lifecycleGeneration)
                return;
            closeActiveWindow({ suppressResults: true });
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Review failed: ${message}`, "error");
        }
        finally {
            if (openingGeneration === generation) {
                openingGeneration = null;
            }
        }
    };
    return {
        handler,
        shutdown: () => {
            lifecycleGeneration += 1;
            openingGeneration = null;
            closeActiveWindow({ suppressResults: true });
        },
    };
}
export function registerAnnotateGitDiff(pi, dependencies = {}) {
    const controller = createAnnotateGitDiffController(pi, dependencies);
    pi.registerCommand("annotate-git-diff", {
        description: "Open a native review window with branch, per-commit, and all-files scopes",
        handler: controller.handler,
    });
    pi.on("session_shutdown", async () => {
        controller.shutdown();
    });
}
export default function registerAnnotateGitDiffDefault(pi) {
    registerAnnotateGitDiff(pi);
}
