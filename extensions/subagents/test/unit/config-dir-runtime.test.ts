import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  getConfigDirName,
  PI_CODING_AGENT_PACKAGE_ROOT_ENV,
  resolveConfigDirName,
} from "../../src/shared/utils.ts";

let previousPackageRootEnv: string | undefined;

describe("config directory resolution", () => {
  beforeEach(() => {
    previousPackageRootEnv = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
    delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
  });

  afterEach(() => {
    if (previousPackageRootEnv === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
    else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previousPackageRootEnv;
  });

  it("falls back without importing the Pi peer package at runtime", () => {
    assert.equal(resolveConfigDirName(), ".pi");
    assert.equal(getConfigDirName(), ".pi");
  });
});
