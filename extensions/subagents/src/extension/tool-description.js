export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents with the TLH minimal contract. Use exactly one mode per call.

EXECUTION
• Call { action: "list" } first; run only listed executable agents.
• SINGLE: { agent, task? }.
• PARALLEL: { tasks:[{ agent, task, cwd?, count?, output?, outputMode?, model? }, ...] }.
• All dispatch runs in background. Optional execution fields: cwd, artifacts. async is deprecated — omit it; async:false is rejected.
• artifacts controls whether per-child run artifacts are written; diagnostic detail is profile-configured.
• Launch receipt: "Background run started" + Run ID + status location. Record the run ID. Completion arrives separately in a notification — do not poll or wait.
• Continue independent work or end the turn after dispatch. Never finalize results until the required completion notification has arrived and been consumed.

OUTPUT / MODELS
• SINGLE also accepts output, outputMode, and model.
• PARALLEL tasks accept cwd, output, outputMode, and model. Relative task cwd values resolve against the run cwd.
• Agent definitions control defaultReads, defaultProgress, and fallbackModels; configured parallel settings control concurrency.
• output can be a path string or false. outputMode can be "inline" or "file-only".
• Agent acceptanceRole may be "read-only" or "writer" when configured through management or frontmatter. It affects inferred acceptance only, never tools; explicit task intent wins, omission keeps name heuristics, and false clears the override.


ACTIONS
• Supported actions only: { action: "list" }, { action: "get", agent: "name" }, { action: "status", id?: "..." }, { action: "interrupt", id?: "..." }, { action: "resume", id: "...", message?: "...", index?: 0 }, { action: "steer", id: "...", message: "...", index?: 0 }, { action: "doctor" }.
• Paused-awaiting-supervisor status reports that no child process is running and gives exact unchanged resume, guided resume, and cancel commands.
• action:status is for diagnosis/recovery only — never use it as a wait-poll loop.
• States: launched (run started, not yet complete), terminal (complete/failed/cancelled), report-consumed (notification arrived and acknowledged). Treat these as distinct; do not finalize until report-consumed.

ASYNC / SAFETY
• All runs are background. Completion notifications arrive when the child finishes (up to 8 completions per notification chunk). Do not sleep or poll just to wait.
• Subagents cannot spawn subagents. Subagent processes do not have orchestrator capability.
• Keep one writer per cwd; use fresh read-only review when needed, then have the parent apply edits.
• Status/artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, and { action:"status", id:"..." }.`;
