import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";

export const ARCHITECT_BRANCH = [
  {
    type: "custom",
    customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
    data: { selected: "architect" },
  },
];

export function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

export function subagentEvent(model) {
  return {
    toolName: "subagent",
    input: {
      agent: "contrarian",
      task: "Stress-test the plan",
      model,
    },
  };
}
