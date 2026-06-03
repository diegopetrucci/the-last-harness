---
description: Safely create a new git worktree from the current repository
---
Help the user spawn a new worktree from the current repository.

This prompt takes no slash-command arguments. Gather all required choices in the normal TLH chat/TUI before running any commands.

Before changing anything, ask the user for:

1. The worktree name or destination path. If they give only a short name, propose the full destination path and get confirmation.
2. Whether they want to create a new branch for the worktree.
3. The new branch name if they chose to create one.
4. The optional base ref or start point for the new branch or detached worktree. Default to `HEAD` if they do not provide one.
5. If they do not want a new branch, whether they want:
   - a detached worktree from the resolved start point, or
   - an explicit existing local branch checkout. If they choose an existing branch, ask which branch.

Before any `git worktree add`:

1. Verify the current directory is inside a git work tree with `git rev-parse --is-inside-work-tree`, verify it is not bare with `git rev-parse --is-bare-repository`, and capture the repo root with `git rev-parse --show-toplevel`.
2. Validate the destination path exactly as it will be used: resolve it to a concrete path, verify it does not already exist, and verify it will not clobber files.
3. Resolve the start point to the user-provided base ref or `HEAD`, and verify it before any `git worktree add`, for example with `git rev-parse --verify --quiet <start-point>^{commit}`.
4. If creating a new branch, first validate the branch name syntax explicitly with `git check-ref-format --branch <branch>`. If that fails, stop and ask the user for a different branch name. Only after it passes, verify `git show-ref --verify --quiet refs/heads/<branch>` does not already succeed, and check `git worktree list --porcelain` so the branch is not already checked out elsewhere.
5. If checking out an existing branch, first validate the branch name syntax explicitly with `git check-ref-format --branch <branch>`. If that fails, stop and ask the user for a valid existing branch name. Only after it passes, verify `git show-ref --verify --quiet refs/heads/<branch>` succeeds and check `git worktree list --porcelain` so the branch is not already checked out elsewhere.
6. If any repo, path, branch, or start-point validation fails, stop, explain the issue, and ask the user how they want to proceed instead of guessing.

Use `git worktree add` explicitly and never rely on implicit path-based defaults such as bare `git worktree add <path>`:

- New branch from the resolved start point: `git worktree add -b <branch> <path> <start-point>`
- Detached worktree from the resolved start point: `git worktree add --detach <path> <start-point>`
- Existing branch checkout only if the branch already exists and is not checked out in another worktree: `git worktree add <path> <branch>`

Before running the command, show the user the exact `git worktree add ...` command you plan to execute and get explicit confirmation.

Do not:

- accept slash-command arguments for this prompt,
- run bare `git worktree add <path>` or otherwise rely on implicit path-based branch creation,
- overwrite, delete, or reuse an existing destination path,
- reuse an existing branch name with `-b`,
- force-add a branch that is already checked out in another worktree unless the user explicitly asks and you explain the risk first.

After creation:

- Report the repo root, new worktree path, resulting branch or detached HEAD state, and the exact command you ran.
- Include undo guidance:
  - remove the worktree: `git worktree remove <path>`
  - if you created a branch and the user also wants to remove it after deleting the worktree: `git branch -d <branch>`
  - use `git branch -D <branch>` only when needed and after warning that it force-deletes unmerged work.
