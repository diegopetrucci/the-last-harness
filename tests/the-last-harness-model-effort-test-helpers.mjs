/** @type {import("../extensions/the-last-harness/types.ts").SubagentMetadata} */
export const developerSubagent = {
  name: "developer",
  description: "Developer subagent",
  tlhModelDefaultsSource: "frontmatter",
  tlhModelDefaults: [
    {
      provider: "openai-codex",
      models: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
      effort: "max",
    },
    {
      provider: "anthropic",
      models: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
      effort: "medium",
    },
    { provider: "openrouter", effort: "medium" },
  ],
};
