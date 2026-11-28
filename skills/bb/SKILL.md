---
name: bb
description: "Inspect or manage bb (tlh gui) threads, projects, and environments through the bb CLI. Use only when the user explicitly mentions bb, tlh gui, or bb threads. Inside a bb-launched session bb's own bb-cli skill may also be loaded; `bb guide` is authoritative."
---

# bb (tlh gui)

bb is the agent-orchestration app behind tlh gui; its `bb` CLI reads and drives its projects, threads, and environments. bb injects its own `bb-cli` skill only into sessions it launches, so this skill covers the rest. Default to read-only inspection.

## Preflight

```sh
command -v bb || test -x "${BB_CLI:-}"
bb status --json
```

If `bb` is not on PATH but `BB_CLI` points to an executable, substitute `"$BB_CLI"` for `bb` in every command below. When both exist, bare `bb` re-execs to `BB_CLI`.

If neither resolves or `status` fails, say so and stop. `BB_THREAD_ID`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID`, and `BB_CLI` are set only inside a bb thread; outside one, pass IDs explicitly. Do not set `BB_SERVER_URL` unless the user asks for a non-default server.

## The installed binary is the authority

Do not rely on, or copy, a CLI reference; ask the installed version:

```sh
bb guide                      # overview and chapter list
bb guide thread-inspection    # also: thread-messaging, thread-lifecycle, environments, threads
bb guide commands thread      # every command in a group, with options
bb thread list --help         # per-command flags
```

## Inspect (read-only)

```sh
bb thread list --json                       # add --project <id>, --parent-thread <id>, --include-archived
bb thread show <id> --json
bb thread log <id> --json --limit 50        # raw events; or page with --after-seq <seq> instead of --limit
bb thread output <id> --json                # final output of a thread
bb thread search "<query>" --json
bb thread wait <id> --status idle --timeout 5m --json
bb project list --json
bb environment list --json                  # also: bb environment show <id> --json
```

Parse stdout only. With `--json` a failure prints `{"ok": false, "error": {code, message, hint}}` on stdout, so never use `2>&1`, which would corrupt the JSON. `bb thread list` hides archived threads unless asked. `bb guide json` lists each command's output shape.

## Rules

- Do not spawn, fork, tell/message, stop, archive, delete, retry, clear, or compact threads, or otherwise mutate bb state, unless the user explicitly asks.
- Resolve IDs with `list` or `show` before any mutation; never guess an ID, and confirm the title and status match what the user meant.
- Send one message per `bb thread tell`. Pass long or multi-line text via `--message-file -` with a quoted heredoc, so the shell does not expand backticks or `$(...)`:

  ```sh
  bb thread tell <id> --message-file - <<'MSG'
  Text here, verbatim.
  MSG
  ```

- Reference a thread as `@thread:<id>` when mentioning it to the user.
- Delegation stays with the TLH `subagent` tool; use bb threads for orchestration only when the user asks for it.
