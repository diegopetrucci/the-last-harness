export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents with the TLH minimal contract. Use exactly one mode per call.

EXECUTION
• Call { action: "list" } first; run only listed executable agents.
• SINGLE: { agent, task?, ticket? }. Fresh bundled TLH developer calls require ticket; non-developers must omit it.
• PARALLEL: { tasks:[{ agent, task, ticket?, count?, output?, outputMode?, reads?, progress?, model? }, ...], concurrency? }. Every fresh developer task requires its own ticket; non-developer tasks must omit ticket.
• ticket is developer-only: other agents are rejected if they supply it, and new dispatches never infer ticket metadata from task text. It resolves from the effective cwd/TICKETS_DIR.
• Optional execution fields: context:"fresh"|"fork", async:true, timeoutMs, cwd, artifacts, includeProgress.

OUTPUT / MODELS
• SINGLE also accepts output, outputMode, model, fallbackModels.
• PARALLEL tasks accept output, outputMode, reads, progress, model.
• output can be a path string or false. outputMode can be "inline" or "file-only".
• Agent acceptanceRole may be "read-only" or "writer" when configured through management or frontmatter. It affects inferred acceptance only, never tools; explicit task intent wins, omission keeps name heuristics, and false clears the override.


ACTIONS
• Supported actions only: { action: "list" }, { action: "get", agent: "name" }, { action: "status", id?: "..." }, { action: "interrupt", id?: "..." }, { action: "resume", id: "...", message?: "...", index?: 0 }, { action: "steer", id: "...", message: "...", index?: 0 }, { action: "doctor" }.
• Paused-awaiting-supervisor status reports that no child process is running and gives exact unchanged resume, guided resume, and cancel commands.

ASYNC / SAFETY
• async:true launches detached background work. Do not sleep or poll just to wait; continue useful work or let completion notifications arrive.
• Subagents cannot spawn subagents. Subagent processes do not have orchestrator capability.
• Keep one writer per cwd; use fresh read-only review when needed, then have the parent apply edits.
• Async status/artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, and { action:"status", id:"..." }.`;
