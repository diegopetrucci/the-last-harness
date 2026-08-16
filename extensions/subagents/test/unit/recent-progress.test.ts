import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRecentProgressItem,
  RECENT_PROGRESS_ITEM_LIMIT,
} from "../../src/shared/recent-progress.ts";

test("recent progress storage keeps the newest 50 exact tool records", () => {
  const retained: Array<{ tool: string; args: string; endMs: number }> = [];
  const records = Array.from({ length: RECENT_PROGRESS_ITEM_LIMIT + 25 }, (_, index) => ({
    tool: `tool-${index}`,
    args: `--exact-${index}=${"argument-value-".repeat(200)}tail-${index}`,
    endMs: index,
  }));

  for (const record of records) appendRecentProgressItem(retained, record);

  assert.equal(retained.length, RECENT_PROGRESS_ITEM_LIMIT);
  assert.strictEqual(retained[0], records[25]);
  assert.strictEqual(retained.at(-1), records.at(-1));
  assert.equal(retained[0]?.args, records[25]?.args);
  assert.equal(retained.at(-1)?.args, records.at(-1)?.args);
});
