import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

// Pi extension that registers a deterministic faux model. FAUX_STEPS names a JSON file with
// scripted steps: { tool, args } emits a tool call, { text } ends the turn.
export default function fauxModelExtension(pi) {
  const steps = JSON.parse(readFileSync(process.env.FAUX_STEPS, "utf8"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "child", contextWindow: 200000 }] });
  faux.setResponses(
    steps.map((step, index) =>
      step.tool
        ? fauxAssistantMessage(fauxToolCall(step.tool, step.args ?? {}, { id: `call-${index}` }), {
            stopReason: "toolUse",
          })
        : fauxAssistantMessage(fauxText(step.text), { stopReason: "stop" }),
    ),
  );
  pi.registerProvider(faux.provider);
}
