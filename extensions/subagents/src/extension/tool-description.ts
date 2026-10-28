export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents with the TLH minimal contract. Use exactly one mode per call.

EXECUTION
• Call { action: "list" } first; run only listed executable agents.
• SINGLE: { agent, task?, ticket? }.
• PARALLEL: { tasks:[{ agent, task, ticket?, cwd?, output?, outputMode?, model? }, ...] }.
• ticket is an optional ticket ID. TLH runs tk show <id> in the effective task cwd before launch, injects the exact body under ## Ticket <id>, and records only the ID in status/results.
• Runs are always detached: a launch returns immediately and the run continues in the background. A launch that overlaps another in-flight launch is rejected; use tasks[] for parallel work.
• Optional execution fields: cwd, artifacts. async is deprecated and ignored when true; async:false is rejected.
• artifacts controls whether per-child run artifacts are written; diagnostic detail is profile-configured.

OUTPUT / MODELS
• SINGLE also accepts output, outputMode, and model.
• PARALLEL tasks accept cwd, output, outputMode, and model. Relative task cwd values resolve against the run cwd.
• Agent definitions control defaultReads, defaultProgress, and fallbackModels; configured parallel settings control concurrency.
• output can be a path string or false. outputMode can be "inline" or "file-only".


ACTIONS
• Supported actions only: { action: "list" }, { action: "get", agent: "name" }, { action: "status", id?: "..." }, { action: "interrupt", id?: "..." }, { action: "resume", id: "...", message?: "...", index?: 0 }, { action: "steer", id: "...", message: "...", index?: 0 }, { action: "result", id: "...", index?: 0 }, { action: "doctor" }.
• action="result" returns bounded per-child output for a finished run you own; each child is bounded independently and its artifact path holds the full output.
• Paused-awaiting-supervisor status reports that no child process is running and gives exact unchanged resume, guided resume, and cancel commands.

ASYNC / SAFETY
• Completion notifications contain only runtime facts (run id, status, counts, paths), never child output. Do not sleep or poll just to wait; end the turn or continue useful work, then call { action:"result", id } when notified. Supervisor requests are listed by subagent_supervisor pending.
• Parent Esc does not stop launched children; stop them with action interrupt or the pause-all shortcut.
• Execution is unavailable in print/json mode (headless); management actions still work.
• Subagents cannot spawn subagents. Subagent processes do not have orchestrator capability.
• Writer agents (developer, test-runner, custom/embedded) are serialized per workspace by a reservation; a conflicting launch is rejected naming the holder run. Read-only agents may run alongside.
• Async status/artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, and { action:"status", id:"..." }.`;
