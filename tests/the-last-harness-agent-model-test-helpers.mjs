import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeAgentModelDefaults } = await jiti.import(
  "../extensions/the-last-harness/prompts.ts",
);

function frontmatterModelFields(agent) {
  const frontmatter = {};
  for (const key of [
    "model",
    "thinking",
    "tlhOpenaiModels",
    "tlhAnthropicModels",
    "tlhOpenaiThinking",
    "tlhAnthropicThinking",
    "tlhOpenrouterThinking",
  ]) {
    const value = agent[key];
    if (Array.isArray(value)) {
      frontmatter[key] = value.join(",");
    } else if (typeof value === "string") {
      frontmatter[key] = value;
    }
  }
  return frontmatter;
}

export function normalizeAgentModelFixture(agent) {
  const {
    tlhOpenaiModels: _openaiModels,
    tlhAnthropicModels: _anthropicModels,
    tlhOpenaiThinking: _openaiThinking,
    tlhAnthropicThinking: _anthropicThinking,
    tlhOpenrouterThinking: _openrouterThinking,
    ...withoutLegacyFields
  } = agent;
  return {
    ...withoutLegacyFields,
    ...normalizeAgentModelDefaults(frontmatterModelFields(agent), agent.tlhModelDefaults),
  };
}
