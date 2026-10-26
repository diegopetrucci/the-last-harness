import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCurrentPath } from "../../src/runs/shared/long-running-guard.ts";

describe("resolveCurrentPath", () => {
  it("prefers explicit path-like tool arguments", () => {
    assert.equal(
      resolveCurrentPath("edit", { path: " src/app.ts ", cwd: "/tmp/project" }),
      "src/app.ts",
    );
    assert.equal(resolveCurrentPath("bash", { cwd: "/tmp/project" }), "/tmp/project");
  });

  it("finds bash redirect and tee targets without classifying the command", () => {
    assert.equal(resolveCurrentPath("bash", { command: "printf hi >./out.txt" }), "./out.txt");
    assert.equal(resolveCurrentPath("bash", { command: "tee ./out.txt" }), "./out.txt");
    assert.equal(resolveCurrentPath("bash", { command: "echo 'a > b'" }), undefined);
  });

  it("returns no path for missing or non-string arguments", () => {
    assert.equal(resolveCurrentPath(undefined, { path: "src/app.ts" }), undefined);
    assert.equal(resolveCurrentPath("edit", undefined), undefined);
    assert.equal(resolveCurrentPath("edit", { path: 42 }), undefined);
  });
});
