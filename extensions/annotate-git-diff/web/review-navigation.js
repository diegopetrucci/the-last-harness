/* global window */

// The navigation module owns sidebar presentation and scope/file selection state.
// The app retains editor lifecycle, host requests, comments and startup wiring; all
// cross-boundary work is supplied as an explicit callback rather than duplicated here.
(function registerReviewNavigation(global) {
  function createReviewNavigation(options) {
    const { reviewData, state, elements, icons, callbacks } = options;
    const {
      sidebarEl,
      sidebarTitleEl,
      toggleSidebarButton,
      scopeBranchButton,
      scopeCommitsButton,
      scopeAllButton,
      commitPickerEl,
      commitListEl,
      fileTreeEl,
      summaryEl,
      refreshReviewButton,
    } = elements;
    const { OCTICON_CHEVRON_DOWN, OCTICON_CHEVRON_RIGHT, OCTICON_FOLDER, OCTICON_FILE } = icons;
    const {
      escapeHtml,
      getRequestState,
      getActiveStatus,
      isFileReviewed,
      fileKindBadgeMarkup,
      saveCurrentScrollPosition,
      renderAll,
      ensureFileLoaded,
      ensureCommitFilesLoaded,
      updateToggleButtons,
    } = callbacks;
    const documentRef = global.document;

    function scopeLabel(scope) {
      switch (scope) {
        case "branch":
          return "Branch";
        case "commits":
          return "Commits";
        default:
          return "All files";
      }
    }

    function commitInfoBySha(sha) {
      if (!sha) return null;
      return reviewData.commits.find((commit) => commit.sha === sha) ?? null;
    }

    function selectedCommitInfo() {
      return commitInfoBySha(state.selectedCommitSha);
    }

    function selectedCommitKind() {
      return selectedCommitInfo()?.kind ?? "commit";
    }

    function hasRepositoryHead() {
      return reviewData.repositoryHasHead === true;
    }

    function workingTreeOriginalLabel() {
      return hasRepositoryHead() ? "HEAD" : "Empty tree";
    }

    function workingTreeRangeLabel() {
      return hasRepositoryHead() ? "HEAD → working tree" : "Empty tree → working tree";
    }

    function isWorkingTreeCommit(sha) {
      return commitInfoBySha(sha)?.kind === "working-tree";
    }

    function isSelectedWorkingTreeCommit() {
      return state.currentScope === "commits" && isWorkingTreeCommit(state.selectedCommitSha);
    }

    function statusLabel(status) {
      if (!status) return "";
      return status.charAt(0).toUpperCase() + status.slice(1);
    }

    function statusBadgeClass(status) {
      switch (status) {
        case "added":
          return "gh-status gh-status-added";
        case "deleted":
          return "gh-status gh-status-deleted";
        case "renamed":
          return "gh-status gh-status-renamed";
        case "modified":
          return "gh-status gh-status-modified";
        default:
          return "gh-status gh-status-modified";
      }
    }

    function statusCode(status) {
      if (!status) return "";
      if (status === "renamed") return "R";
      return status.charAt(0).toUpperCase();
    }

    function activeFileList() {
      if (state.currentScope === "commits") {
        const sha = state.selectedCommitSha;
        if (!sha) return [];
        return state.commitFilesBySha[sha] ?? [];
      }
      return reviewData.files;
    }

    function getScopedFiles() {
      switch (state.currentScope) {
        case "branch":
          return reviewData.files.filter((file) => file.inGitDiff);
        case "commits":
          return activeFileList();
        default:
          return reviewData.files;
      }
    }

    function ensureActiveFileForScope() {
      const scopedFiles = getScopedFiles();
      if (scopedFiles.length === 0) {
        state.activeFileId = null;
        return;
      }
      if (scopedFiles.some((file) => file.id === state.activeFileId)) {
        return;
      }
      state.activeFileId = scopedFiles[0].id;
    }

    function activeFile() {
      const list = activeFileList();
      return list.find((file) => file.id === state.activeFileId) ?? null;
    }

    function getFileSearchPath(file) {
      return file?.path || "";
    }

    function getBaseName(path) {
      const parts = path.split("/");
      return parts[parts.length - 1] || path;
    }

    function normalizeQuery(query) {
      return String(query || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");
    }

    function scoreSubsequence(query, candidate) {
      if (!query) return 0;
      let queryIndex = 0;
      let score = 0;
      let firstMatchIndex = -1;
      let previousMatchIndex = -2;

      for (let i = 0; i < candidate.length && queryIndex < query.length; i += 1) {
        if (candidate[i] !== query[queryIndex]) continue;

        if (firstMatchIndex === -1) firstMatchIndex = i;
        score += 10;

        if (i === previousMatchIndex + 1) {
          score += 8;
        }

        const previousChar = i > 0 ? candidate[i - 1] : "";
        if (
          i === 0 ||
          previousChar === "/" ||
          previousChar === "_" ||
          previousChar === "-" ||
          previousChar === "."
        ) {
          score += 12;
        }

        previousMatchIndex = i;
        queryIndex += 1;
      }

      if (queryIndex !== query.length) return -1;
      if (firstMatchIndex >= 0) score += Math.max(0, 20 - firstMatchIndex);
      return score;
    }

    function getFileSearchScore(query, file) {
      const normalizedQuery = normalizeQuery(query);
      if (!normalizedQuery) return 0;

      const path = getFileSearchPath(file).toLowerCase();
      const baseName = getBaseName(path);
      const pathScore = scoreSubsequence(normalizedQuery, path);
      const baseScore = scoreSubsequence(normalizedQuery, baseName);
      let score = Math.max(pathScore, baseScore >= 0 ? baseScore + 40 : -1);

      if (score < 0) return -1;
      if (baseName === normalizedQuery) score += 200;
      else if (baseName.startsWith(normalizedQuery)) score += 120;
      else if (path.includes(normalizedQuery)) score += 35;

      return score;
    }

    function getFilteredFiles() {
      const scopedFiles = getScopedFiles();
      const query = state.fileFilter.trim();
      if (!query) return [...scopedFiles];

      return scopedFiles
        .map((file) => ({ file, score: getFileSearchScore(query, file) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return getFileSearchPath(a.file).localeCompare(getFileSearchPath(b.file));
        })
        .map((entry) => entry.file);
    }

    function collapseTreeNode(node, isRoot = false) {
      if (node.kind === "file") return node;

      const collapsedChildren = [...node.children.values()].map((child) => collapseTreeNode(child));
      let collapsed = {
        ...node,
        children: new Map(collapsedChildren.map((child) => [child.name, child])),
      };

      if (isRoot) return collapsed;

      while (collapsed.children.size === 1) {
        const [onlyChild] = collapsed.children.values();
        if (!onlyChild || onlyChild.kind !== "dir") break;
        collapsed = {
          name: `${collapsed.name}/${onlyChild.name}`,
          path: onlyChild.path,
          kind: "dir",
          children: onlyChild.children,
          file: null,
        };
      }

      return collapsed;
    }

    function buildTree(files) {
      const root = { name: "", path: "", kind: "dir", children: new Map(), file: null };
      for (const file of files) {
        const path = getFileSearchPath(file);
        const parts = path.split("/");
        let node = root;
        let currentPath = "";
        for (let i = 0; i < parts.length; i += 1) {
          const part = parts[i];
          const isLeaf = i === parts.length - 1;
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          if (!node.children.has(part)) {
            node.children.set(part, {
              name: part,
              path: currentPath,
              kind: isLeaf ? "file" : "dir",
              children: new Map(),
              file: isLeaf ? file : null,
            });
          }
          node = node.children.get(part);
          if (isLeaf) node.file = file;
        }
      }
      return collapseTreeNode(root, true);
    }

    function formatWorkingTreeLoadLabel(timestamp) {
      if (!timestamp) return "Not loaded yet";
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return "Not loaded yet";
      return date.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    }

    function formatLocalChangeLabel(timestamp) {
      if (!timestamp) return "just now";
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return "just now";
      return date.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    }

    function updateReviewRefreshButton() {
      if (!refreshReviewButton) return;
      const shouldShow = state.localChangesDetected || state.currentScope === "commits";
      if (!shouldShow) {
        refreshReviewButton.style.display = "none";
        refreshReviewButton.disabled = true;
        return;
      }
      const sha = state.currentScope === "commits" ? state.selectedCommitSha : null;
      const commitLoading = sha ? state.commitRequestIds[sha] != null : false;
      const reviewDataLoading = state.reviewDataRequestId != null;
      const loading = commitLoading || reviewDataLoading;
      refreshReviewButton.style.display = "inline-flex";
      refreshReviewButton.disabled = loading;
      refreshReviewButton.style.borderColor =
        state.localChangesDetected && !loading ? "rgba(210,153,34,0.65)" : "";
      refreshReviewButton.style.color = state.localChangesDetected && !loading ? "#d29922" : "";
      refreshReviewButton.textContent = loading
        ? "Refreshing…"
        : state.localChangesDetected
          ? "Changes detected · Refresh"
          : isSelectedWorkingTreeCommit()
            ? "Refresh live diff"
            : "Refresh review";
      refreshReviewButton.title = state.localChangesDetected
        ? `Local file changes detected at ${formatLocalChangeLabel(state.lastLocalChangeDetectedAt)}. Click to reload review data.`
        : isSelectedWorkingTreeCommit()
          ? `Working tree diff. Last loaded ${formatWorkingTreeLoadLabel(state.lastWorkingTreeLoadAt)}.`
          : "Refresh review data for all scopes.";
    }

    function openFile(fileId) {
      if (state.activeFileId === fileId) {
        ensureFileLoaded(fileId, state.currentScope);
        return;
      }
      saveCurrentScrollPosition();
      state.activeFileId = fileId;
      renderAll({ restoreFileScroll: true });
      ensureFileLoaded(fileId, state.currentScope);
    }

    function renderTreeNode(node, depth) {
      const children = [...node.children.values()].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const indentPx = 12;

      for (const child of children) {
        if (child.kind === "dir") {
          const collapsed = state.collapsedDirs[child.path] === true;
          const row = documentRef.createElement("button");
          row.type = "button";
          row.className = "gh-tree-row";
          row.style.paddingLeft = `${depth * indentPx + 8}px`;
          row.innerHTML = `
        <span class="flex h-3 w-3 items-center justify-center text-review-muted">${collapsed ? OCTICON_CHEVRON_RIGHT : OCTICON_CHEVRON_DOWN}</span>
        ${OCTICON_FOLDER}
        <span class="gh-row-name">${escapeHtml(child.name)}</span>
      `;
          row.addEventListener("click", () => {
            state.collapsedDirs[child.path] = !collapsed;
            renderTree();
          });
          fileTreeEl.appendChild(row);
          if (!collapsed) renderTreeNode(child, depth + 1);
          continue;
        }

        const file = child.file;
        const count = state.comments.filter(
          (comment) => comment.fileId === file.id && comment.scope === state.currentScope,
        ).length;
        const reviewed = isFileReviewed(file.id);
        const requestState = getRequestState(file.id, state.currentScope);
        const loading = requestState.requestId != null && requestState.contents == null;
        const errored = requestState.error != null;
        const status = getActiveStatus(file);
        const button = documentRef.createElement("button");
        button.type = "button";
        button.className = "gh-tree-row";
        button.dataset.selected = file.id === state.activeFileId ? "true" : "false";
        if (reviewed) button.style.opacity = "0.6";
        button.style.paddingLeft = `${depth * indentPx + 26}px`;
        const loadingBadge = loading
          ? '<span class="text-[10px] text-review-accent">…</span>'
          : errored
            ? '<span class="text-[10px] text-review-danger">!</span>'
            : "";
        button.innerHTML = `
      ${OCTICON_FILE}
      <span class="gh-row-name">${escapeHtml(child.name)}</span>
      <span class="gh-row-trail">
        ${fileKindBadgeMarkup(file)}
        ${loadingBadge}
        ${count > 0 ? `<span class="gh-comment-count">${count}</span>` : ""}
        ${status ? `<span class="${statusBadgeClass(status)}">${escapeHtml(statusCode(status))}</span>` : ""}
      </span>
    `;
        button.addEventListener("click", () => openFile(file.id));
        fileTreeEl.appendChild(button);
      }
    }

    function renderSearchResults(files) {
      files.forEach((file) => {
        const path = getFileSearchPath(file);
        const baseName = getBaseName(path);
        const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const count = state.comments.filter(
          (comment) => comment.fileId === file.id && comment.scope === state.currentScope,
        ).length;
        const reviewed = isFileReviewed(file.id);
        const requestState = getRequestState(file.id, state.currentScope);
        const loading = requestState.requestId != null && requestState.contents == null;
        const errored = requestState.error != null;
        const status = getActiveStatus(file);
        const button = documentRef.createElement("button");
        button.type = "button";
        button.className = "gh-tree-row";
        button.dataset.selected = file.id === state.activeFileId ? "true" : "false";
        if (reviewed) button.style.opacity = "0.6";
        button.style.alignItems = "flex-start";
        button.style.padding = "6px 8px";
        const loadingBadge = loading
          ? '<span class="text-[10px] text-review-accent">…</span>'
          : errored
            ? '<span class="text-[10px] text-review-danger">!</span>'
            : "";
        button.innerHTML = `
      ${OCTICON_FILE}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px]">${escapeHtml(baseName)}</span>
        <span class="block truncate text-[11px] text-review-muted">${escapeHtml(parentPath || path)}</span>
      </span>
      <span class="gh-row-trail">
        ${fileKindBadgeMarkup(file)}
        ${loadingBadge}
        ${count > 0 ? `<span class="gh-comment-count">${count}</span>` : ""}
        ${status ? `<span class="${statusBadgeClass(status)}">${escapeHtml(statusCode(status))}</span>` : ""}
      </span>
    `;
        button.addEventListener("click", () => openFile(file.id));
        fileTreeEl.appendChild(button);
      });
    }

    function updateSidebarLayout() {
      const collapsed = state.sidebarCollapsed;
      sidebarEl.style.width = collapsed ? "0px" : "280px";
      sidebarEl.style.minWidth = collapsed ? "0px" : "280px";
      sidebarEl.style.flexBasis = collapsed ? "0px" : "280px";
      sidebarEl.style.borderRightWidth = collapsed ? "0px" : "1px";
      sidebarEl.style.pointerEvents = collapsed ? "none" : "auto";
      toggleSidebarButton.dataset.active = collapsed ? "false" : "true";
      toggleSidebarButton.title = collapsed ? "Show sidebar" : "Hide sidebar";
    }

    function updateScopeButtons() {
      const counts = {
        branch: reviewData.files.filter((file) => file.inGitDiff).length,
        commits: reviewData.commits.length,
        all: reviewData.files.length,
      };

      const applyButtonClasses = (button, active, disabled) => {
        button.disabled = disabled;
        button.className = disabled
          ? "cursor-default rounded-md border border-review-border bg-review-bg px-2.5 py-1 text-[11px] font-medium text-review-muted opacity-60"
          : active
            ? "cursor-pointer rounded-md border border-review-success-emphasis/40 bg-review-success-emphasis/15 px-2.5 py-1 text-[11px] font-medium text-review-success hover:bg-review-success-emphasis/25"
            : "cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-[11px] font-medium text-review-text hover:bg-[#1f242c]";
      };

      scopeBranchButton.textContent = `Branch${counts.branch > 0 ? ` (${counts.branch})` : ""}`;
      scopeCommitsButton.textContent = `Commits${counts.commits > 0 ? ` (${counts.commits})` : ""}`;
      scopeAllButton.textContent = `All${counts.all > 0 ? ` (${counts.all})` : ""}`;

      applyButtonClasses(scopeBranchButton, state.currentScope === "branch", counts.branch === 0);
      applyButtonClasses(
        scopeCommitsButton,
        state.currentScope === "commits",
        counts.commits === 0,
      );
      applyButtonClasses(scopeAllButton, state.currentScope === "all", counts.all === 0);

      if (commitPickerEl) {
        commitPickerEl.style.display = state.currentScope === "commits" ? "" : "none";
      }
    }

    function renderCommitList() {
      if (!commitListEl) return;
      commitListEl.innerHTML = "";
      if (reviewData.commits.length === 0) {
        commitListEl.innerHTML =
          '<div class="px-3 py-2 text-[11px] text-review-muted">No commits to review.</div>';
        updateReviewRefreshButton();
        return;
      }
      for (const commit of reviewData.commits) {
        const row = documentRef.createElement("button");
        row.type = "button";
        row.className = "commit-row";
        row.dataset.selected = commit.sha === state.selectedCommitSha ? "true" : "false";
        const loading =
          state.commitRequestIds[commit.sha] != null && state.commitFilesBySha[commit.sha] == null;
        const errored = state.commitErrors[commit.sha] != null;
        const isWorkingTree = commit.kind === "working-tree";
        const date = !isWorkingTree && commit.authorDate ? new Date(commit.authorDate) : null;
        const dateLabel =
          date && !Number.isNaN(date.getTime())
            ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
            : "";
        const metaLabel = isWorkingTree
          ? `Live · ${workingTreeRangeLabel()}`
          : `${commit.authorName || ""}${dateLabel ? ` · ${dateLabel}` : ""}`;
        row.innerHTML = `
      <span class="commit-row-sha">${escapeHtml(commit.shortSha)}</span>
      <span class="commit-row-body">
        <span class="commit-row-subject">${escapeHtml(commit.subject)}</span>
        <span class="commit-row-meta">${escapeHtml(metaLabel)}</span>
      </span>
      <span class="commit-row-status">${loading ? "…" : errored ? "!" : ""}</span>
    `;
        row.addEventListener("click", () => selectCommit(commit.sha));
        commitListEl.appendChild(row);
      }
      updateReviewRefreshButton();
    }

    function selectCommit(sha) {
      if (!sha) return;
      if (state.selectedCommitSha === sha && state.commitFilesBySha[sha] != null) return;
      saveCurrentScrollPosition();
      state.selectedCommitSha = sha;
      state.activeFileId = null;
      ensureCommitFilesLoaded(sha);
      renderAll({ restoreFileScroll: false });
      const file = activeFile();
      if (file) ensureFileLoaded(file.id, state.currentScope);
    }

    function renderTree() {
      ensureActiveFileForScope();
      fileTreeEl.innerHTML = "";
      const scopedFiles = getScopedFiles();
      const visibleFiles = getFilteredFiles();

      if (visibleFiles.length === 0) {
        const message = state.fileFilter.trim()
          ? `No files match <span class="text-review-text">${escapeHtml(state.fileFilter.trim())}</span>.`
          : `No files in <span class="text-review-text">${escapeHtml(scopeLabel(state.currentScope).toLowerCase())}</span>.`;
        fileTreeEl.innerHTML = `
      <div class="px-3 py-4 text-sm text-review-muted">
        ${message}
      </div>
    `;
      } else if (state.fileFilter.trim()) {
        renderSearchResults(visibleFiles);
      } else {
        renderTreeNode(buildTree(visibleFiles), 0);
      }

      sidebarTitleEl.textContent = scopeLabel(state.currentScope);
      const comments = state.comments.length;
      const filteredSuffix = state.fileFilter.trim() ? ` • ${visibleFiles.length} shown` : "";
      const liveSuffix = isSelectedWorkingTreeCommit() ? " • live working tree" : "";
      const staleSuffix = state.localChangesDetected ? " • local changes detected" : "";
      summaryEl.textContent = `${scopedFiles.length} file(s) • ${comments} comment(s)${state.overallComment ? " • overall note" : ""}${filteredSuffix}${liveSuffix}${staleSuffix}`;
      updateToggleButtons();
      updateSidebarLayout();
    }

    function switchScope(scope) {
      const hasScopeFiles = {
        branch: reviewData.files.some((file) => file.inGitDiff),
        commits: reviewData.commits.length > 0,
        all: reviewData.files.length > 0,
      };
      if (!hasScopeFiles[scope] || state.currentScope === scope) return;
      saveCurrentScrollPosition();
      state.currentScope = scope;
      state.activeFileId = null;
      if (scope === "commits") {
        if (!state.selectedCommitSha && reviewData.commits[0]) {
          state.selectedCommitSha = reviewData.commits[0].sha;
        }
        if (state.selectedCommitSha) ensureCommitFilesLoaded(state.selectedCommitSha);
      }
      renderAll({ restoreFileScroll: true });
      const file = activeFile();
      if (file) ensureFileLoaded(file.id, state.currentScope);
    }

    function toggleSidebar() {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      updateSidebarLayout();
    }

    function setFileFilter(value) {
      state.fileFilter = String(value ?? "");
      renderTree();
    }

    return {
      scopeLabel,
      commitInfoBySha,
      selectedCommitInfo,
      selectedCommitKind,
      hasRepositoryHead,
      workingTreeOriginalLabel,
      workingTreeRangeLabel,
      isWorkingTreeCommit,
      isSelectedWorkingTreeCommit,
      activeFileList,
      getScopedFiles,
      ensureActiveFileForScope,
      activeFile,
      getFileSearchPath,
      getBaseName,
      getFilteredFiles,
      statusLabel,
      statusBadgeClass,
      statusCode,
      updateReviewRefreshButton,
      openFile,
      updateSidebarLayout,
      updateScopeButtons,
      renderCommitList,
      selectCommit,
      renderTree,
      switchScope,
      toggleSidebar,
      setFileFilter,
    };
  }

  global.__createReviewNavigation = createReviewNavigation;
})(typeof window === "undefined" ? globalThis : window);
