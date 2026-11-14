import assert from "node:assert/strict";
import test from "node:test";
import { wrapTmuxPassthrough } from "../extensions/shared/tmux-passthrough.js";

const osc7501 = "\x1b]7501;status\x1b\\";
const osc777 = "\x1b]777;notify;t;b\x07";

test("returns input unchanged when TMUX unset or empty", () => {
  for (const env of [{}, { TMUX: "" }, { TMUX: undefined }]) {
    assert.equal(wrapTmuxPassthrough(osc7501, env), osc7501);
    assert.equal(wrapTmuxPassthrough(osc777, env), osc777);
  }
});

test("wraps ST-terminated OSC 7501 with doubled ESC", () => {
  assert.equal(
    wrapTmuxPassthrough(osc7501, { TMUX: "/tmp/tmux-1/default,1,0" }),
    "\x1bPtmux;\x1b\x1b]7501;status\x1b\x1b\\\x1b\\",
  );
});

test("wraps BEL-terminated OSC 777", () => {
  assert.equal(
    wrapTmuxPassthrough(osc777, { TMUX: "x" }),
    "\x1bPtmux;\x1b\x1b]777;notify;t;b\x07\x1b\\",
  );
});
