import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSkillInput } from "../../src/agents/skills.ts";
import { makeAgent } from "../support/helpers.ts";
import {
  buildExecutionInstructions,
  resolveStepBehavior,
  suppressProgressForReadOnlyTask,
  taskDisallowsFileUpdates,
  type ResolvedStepBehavior,
} from "../../src/shared/settings.ts";

describe("resolveStepBehavior", () => {
  it("returns agent defaults when no overrides", () => {
    // Uses agentConfig.output, .defaultReads, .defaultProgress
    const config = makeAgent("test", {
      output: "report.md",
      defaultProgress: true,
      defaultReads: ["input.md"],
    });
    const behavior = resolveStepBehavior(config, {});
    assert.equal(behavior.output, "report.md");
    assert.equal(behavior.progress, true);
    assert.deepEqual(behavior.reads, ["input.md"]);
  });

  it("step overrides take precedence", () => {
    const config = makeAgent("test", { output: "report.md" });
    const behavior = resolveStepBehavior(config, { output: "custom.md" });
    assert.equal(behavior.output, "custom.md");
  });

  it("defaults outputMode to inline unless a step overrides it", () => {
    const inlineBehavior = resolveStepBehavior(makeAgent("test", { output: "report.md" }), {});
    assert.equal(inlineBehavior.outputMode, "inline");

    const stepOverrideBehavior = resolveStepBehavior(makeAgent("test", { output: "report.md" }), {
      outputMode: "file-only",
    });
    assert.equal(stepOverrideBehavior.outputMode, "file-only");
  });

  it("false disables output", () => {
    const config = makeAgent("test", { output: "report.md" });
    const behavior = resolveStepBehavior(config, { output: false });
    assert.equal(behavior.output, false);
  });

  it("string false disables output defensively", () => {
    const config = makeAgent("test", { output: "report.md" });
    const behavior = resolveStepBehavior(config, { output: "false" });
    assert.equal(behavior.output, false);
  });

  it("defaults to false when agent has no config", () => {
    const config = makeAgent("test");
    const behavior = resolveStepBehavior(config, {});
    assert.equal(behavior.output, false);
    assert.equal(behavior.reads, false);
    assert.equal(behavior.progress, false);
  });
});

describe("buildExecutionInstructions", () => {
  const baseDir = "/tmp/step-behavior";

  it("adds read headers to the task prefix", () => {
    const instructions = buildExecutionInstructions(
      {
        reads: ["context.md"],
        output: false,
        outputMode: "inline",
        progress: false,
        skills: false,
      },
      baseDir,
      false,
    );
    assert.equal(instructions.prefix, "[Read from: /tmp/step-behavior/context.md]\n\n");
    assert.equal(instructions.suffix, "");
  });

  it("adds write headers to the task prefix", () => {
    const instructions = buildExecutionInstructions(
      {
        reads: false,
        output: "output.md",
        outputMode: "inline",
        progress: false,
        skills: false,
      },
      baseDir,
      false,
    );
    assert.equal(instructions.prefix, "[Write to: /tmp/step-behavior/output.md]\n\n");
    assert.equal(instructions.suffix, "");
  });

  it("adds create-progress instructions for the first progress task", () => {
    const instructions = buildExecutionInstructions(
      {
        reads: false,
        output: false,
        outputMode: "inline",
        progress: true,
        skills: false,
      },
      baseDir,
      true,
    );
    assert.equal(
      instructions.suffix,
      "\n\n---\nCreate and maintain progress at: /tmp/step-behavior/progress.md",
    );
  });

  it("adds update-progress instructions for later progress tasks", () => {
    const instructions = buildExecutionInstructions(
      {
        reads: false,
        output: false,
        outputMode: "inline",
        progress: true,
        skills: false,
      },
      baseDir,
      false,
    );
    assert.equal(
      instructions.suffix,
      "\n\n---\nUpdate progress at: /tmp/step-behavior/progress.md",
    );
  });

  it("returns empty instructions when no behavior is configured", () => {
    const instructions = buildExecutionInstructions(
      {
        reads: false,
        output: false,
        outputMode: "inline",
        progress: false,
        skills: false,
      },
      baseDir,
      false,
    );
    assert.deepEqual(instructions, { prefix: "", suffix: "" });
  });
});

describe("read-only progress suppression", () => {
  it("suppresses progress for review-only or no-edit tasks", () => {
    const behavior: ResolvedStepBehavior = {
      reads: false,
      output: false,
      outputMode: "inline",
      progress: true,
      skills: false,
    };

    assert.equal(taskDisallowsFileUpdates("Review-only. Do not edit files."), true);
    assert.equal(taskDisallowsFileUpdates("Implement read-only mode for config files."), false);
    assert.equal(taskDisallowsFileUpdates("This task is not read-only; edit files."), false);
    assert.equal(
      suppressProgressForReadOnlyTask(behavior, "Review-only. Do not edit files.").progress,
      false,
    );
    assert.equal(
      suppressProgressForReadOnlyTask(behavior, "{task}", "Review-only. Do not edit files.")
        .progress,
      false,
    );
    assert.equal(
      suppressProgressForReadOnlyTask(behavior, "Implement the approved fix.").progress,
      true,
    );
  });
});

// normalizeSkillInput is a pure function and requires no pi packages.
describe("normalizeSkillInput", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(normalizeSkillInput(undefined), undefined);
  });

  it("returns undefined for true (use default)", () => {
    assert.equal(normalizeSkillInput(true), undefined);
  });

  it("returns false for false (disable)", () => {
    assert.equal(normalizeSkillInput(false), false);
  });

  it("splits comma-separated string", () => {
    assert.deepEqual(normalizeSkillInput("web-search,pdf"), ["web-search", "pdf"]);
  });

  it("passes through array", () => {
    assert.deepEqual(normalizeSkillInput(["a", "b"]), ["a", "b"]);
  });

  it("deduplicates", () => {
    assert.deepEqual(normalizeSkillInput(["a", "b", "a"]), ["a", "b"]);
  });

  it("trims whitespace", () => {
    assert.deepEqual(normalizeSkillInput(" a , b "), ["a", "b"]);
  });

  it("filters empty strings", () => {
    assert.deepEqual(normalizeSkillInput(",a,,b,"), ["a", "b"]);
  });
});
