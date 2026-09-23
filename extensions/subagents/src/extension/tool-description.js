export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents with the TLH minimal contract. Use exactly one mode per call.

EXECUTION
• Call { action: "list" } first; run only listed executable agents.
• SINGLE: { agent, task?, ticket? }.
• PARALLEL: { tasks:[{ agent, task, ticket?, cwd?, count?, output?, outputMode?, model? }, ...] }.
• ticket is an optional ticket ID. TLH runs tk show <id> in the effective task cwd before launch, injects the exact body under ## Ticket <id>, and records only the ID in status/results.
• Sync (default): the parent awaits the run and receives its terminal result; ordinary single/parallel calls use the TLH-tracked awaited runner.
• Optional execution fields: async:true, cwd, artifacts. async:true keeps the detached background behavior.
• artifacts controls whether per-child run artifacts are written; diagnostic detail is profile-configured.

OUTPUT / MODELS
• SINGLE also accepts output, outputMode, and model.
• PARALLEL tasks accept cwd, output, outputMode, and model. Relative task cwd values resolve against the run cwd.
• Agent definitions control defaultReads, defaultProgress, and fallbackModels; configured parallel settings control concurrency.
• output can be a path string or false. outputMode can be "inline" or "file-only".


ACTIONS
• Supported actions only: { action: "list" }, { action: "get", agent: "name" }, { action: "status", id?: "...", view?: "transcript", lines?: 1-500 }, { action: "interrupt", id?: "..." }, { action: "resume", id: "...", message?: "...", index?: 0 }, { action: "steer", id: "...", message: "...", index?: 0 }, { action: "doctor" }.
• Status-only options: view: "transcript" tails retained output/session text; lines limits that tail to 1-500 lines. Do not send them with another action or execution call.
• Paused-awaiting-supervisor status reports that no child process is running and gives exact unchanged resume, guided resume, and cancel commands.

ASYNC / SAFETY
• async:true launches detached background work. Do not sleep or poll just to wait; continue useful work or let completion notifications arrive.
• Subagents cannot spawn subagents. Subagent processes do not have orchestrator capability.
• Keep one writer per cwd; use fresh read-only review when needed, then have the parent apply edits.
• Async status/artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, and { action:"status", id:"..." }.`;
