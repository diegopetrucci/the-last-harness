/**
 * Tests for step behavior resolution, skill normalization, and chain instruction building.
 *
 * Covers the pure logic of isParallelStep, normalizeSkillInput, resolveStepBehavior,
 * suppressProgressForReadOnlyTask / taskDisallowsFileUpdates, and buildChainInstructions.
 * Uses dynamic import since settings.ts transitively depends on pi packages.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";

// Top-level await
const settings = await tryImport<any>("./src/shared/settings.ts");
const skills = await tryImport<any>("./src/agents/skills.ts");
const available = !!(settings && skills);

const buildChainInstructions = settings?.buildChainInstructions;
const resolveStepBehavior = settings?.resolveStepBehavior;
const suppressProgressForReadOnlyTask = settings?.suppressProgressForReadOnlyTask;
const taskDisallowsFileUpdates = settings?.taskDisallowsFileUpdates;
const isParallelStep = settings?.isParallelStep;
const normalizeSkillInput = skills?.normalizeSkillInput;

describe("isParallelStep", { skip: !available ? "pi packages not available" : undefined }, () => {
  it("returns true for parallel steps", () => {
    assert.ok(isParallelStep({ parallel: [{ agent: "a", task: "t" }] }));
  });

  it("returns false for sequential steps", () => {
    assert.ok(!isParallelStep({ agent: "a", task: "t" }));
  });
});

describe(
  "normalizeSkillInput",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
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
  },
);

describe(
  "resolveStepBehavior",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
    it("returns agent defaults when no overrides", () => {
      // Uses agentConfig.output, .defaultReads, .defaultProgress
      const config = {
        name: "test",
        output: "report.md",
        defaultProgress: true,
        defaultReads: ["input.md"],
      };
      const behavior = resolveStepBehavior(config, {});
      assert.equal(behavior.output, "report.md");
      assert.equal(behavior.progress, true);
      assert.deepEqual(behavior.reads, ["input.md"]);
    });

    it("step overrides take precedence", () => {
      const config = { name: "test", output: "report.md" };
      const behavior = resolveStepBehavior(config, { output: "custom.md" });
      assert.equal(behavior.output, "custom.md");
    });

    it("defaults outputMode to inline unless a step overrides it", () => {
      const inlineBehavior = resolveStepBehavior({ name: "test", output: "report.md" }, {});
      assert.equal(inlineBehavior.outputMode, "inline");

      const stepOverrideBehavior = resolveStepBehavior(
        { name: "test", output: "report.md" },
        { outputMode: "file-only" },
      );
      assert.equal(stepOverrideBehavior.outputMode, "file-only");
    });

    it("false disables output", () => {
      const config = { name: "test", output: "report.md" };
      const behavior = resolveStepBehavior(config, { output: false });
      assert.equal(behavior.output, false);
    });

    it("string false disables output defensively", () => {
      const config = { name: "test", output: "report.md" };
      const behavior = resolveStepBehavior(config, { output: "false" });
      assert.equal(behavior.output, false);
    });

    it("defaults to false when agent has no config", () => {
      const config = { name: "test" };
      const behavior = resolveStepBehavior(config, {});
      assert.equal(behavior.output, false);
      assert.equal(behavior.reads, false);
      assert.equal(behavior.progress, false);
    });
  },
);

describe(
  "read-only progress suppression",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
    it("suppresses progress for review-only or no-edit tasks", () => {
      const behavior = {
        reads: undefined,
        output: false,
        outputMode: "inline",
        progress: true,
        skills: undefined,
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
  },
);

describe(
  "buildChainInstructions",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
    it("adds [Read from:] prefix for reads", () => {
      const behavior = {
        reads: ["context.md"],
        output: false,
        outputMode: "inline",
        progress: false,
        skills: undefined,
      };
      const dir = createTempDir("chain-test-");
      try {
        const { prefix } = buildChainInstructions(behavior, dir, false);
        assert.ok(prefix.includes("[Read from:"), `should have Read instruction: ${prefix}`);
        assert.ok(prefix.includes("context.md"), "should reference the file");
      } finally {
        removeTempDir(dir);
      }
    });

    it("adds [Write to:] prefix for output", () => {
      const behavior = {
        reads: undefined,
        output: "output.md",
        outputMode: "inline",
        progress: false,
        skills: undefined,
      };
      const dir = createTempDir("chain-test-");
      try {
        const { prefix } = buildChainInstructions(behavior, dir, false);
        assert.ok(prefix.includes("[Write to:"), `should have Write instruction: ${prefix}`);
        assert.ok(prefix.includes("output.md"), "should reference the file");
      } finally {
        removeTempDir(dir);
      }
    });

    it("adds progress instructions in suffix for first progress step", () => {
      const behavior = {
        reads: undefined,
        output: false,
        outputMode: "inline",
        progress: true,
        skills: undefined,
      };
      const dir = createTempDir("chain-test-");
      try {
        const { suffix } = buildChainInstructions(behavior, dir, true);
        assert.ok(suffix.includes("progress.md"), `should reference progress.md: ${suffix}`);
        assert.ok(
          suffix.includes("Create") || suffix.includes("maintain"),
          `should say create/maintain for first progress step: ${suffix}`,
        );
      } finally {
        removeTempDir(dir);
      }
    });

    it("includes previous output in suffix when not in template", () => {
      const behavior = {
        reads: undefined,
        output: false,
        outputMode: "inline",
        progress: false,
        skills: undefined,
      };
      const dir = createTempDir("chain-test-");
      try {
        const { suffix } = buildChainInstructions(
          behavior,
          dir,
          false,
          "Previous step output here",
        );
        assert.ok(suffix.includes("Previous step output here"), "should include previous output");
      } finally {
        removeTempDir(dir);
      }
    });

    it("returns empty prefix/suffix when no behavior configured", () => {
      const behavior = {
        reads: undefined,
        output: false,
        outputMode: "inline",
        progress: false,
        skills: undefined,
      };
      const dir = createTempDir("chain-test-");
      try {
        const { prefix, suffix } = buildChainInstructions(behavior, dir, false);
        assert.equal(prefix, "");
        assert.equal(suffix, "");
      } finally {
        removeTempDir(dir);
      }
    });
  },
);
