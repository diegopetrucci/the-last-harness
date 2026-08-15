import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildAnnotateLastMessageHtml } = await jiti.import(
  "../extensions/the-last-harness/annotate-last-message/ui.ts",
);
const { composeAnnotateLastMessagePrompt, hasAnnotateLastMessageFeedback } = await jiti.import(
  "../extensions/the-last-harness/annotate-last-message/prompt.ts",
);
const { findLastAssistantMessage } = await jiti.import(
  "../extensions/the-last-harness/annotate-last-message/session.ts",
);
const {
  ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION,
  buildAnnotateLastMessageCommand,
  registerAnnotateLastMessageCommand,
} = await jiti.import("../extensions/the-last-harness/annotate-last-message.ts");

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.closeCalls = 0;
  }

  close() {
    this.closeCalls += 1;
    this.emit("closed");
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function messageEntry(role, content, stopReason = "stop") {
  return {
    type: "message",
    message: {
      role,
      stopReason,
      content,
    },
  };
}

function createContext({ branch = [] } = {}) {
  const notifications = [];
  return {
    notifications,
    ctx: {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getBranch() {
          return branch;
        },
      },
    },
  };
}

function createSendUserMessage() {
  const sent = [];
  const sendUserMessage = (message, options) => sent.push({ message, options });
  return { sent, sendUserMessage };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("registerAnnotateLastMessageCommand reuses the exported command builder and description", () => {
  let registeredCommand;
  let sessionShutdownHandler;
  registerAnnotateLastMessageCommand({
    registerCommand(name, command) {
      if (name === "annotate-last-message") {
        registeredCommand = command;
      }
    },
    on(event, handler) {
      if (event === "session_shutdown") {
        sessionShutdownHandler = handler;
      }
    },
  });

  assert.equal(registeredCommand.description, ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION);
  assert.equal(typeof registeredCommand.handler, "function");
  assert.equal(typeof sessionShutdownHandler, "function");

  const builtCommand = buildAnnotateLastMessageCommand({ sendUserMessage: () => {} });
  assert.equal(typeof builtCommand.handler, "function");
  assert.equal(typeof builtCommand.handleSessionShutdown, "function");
  assert.doesNotThrow(() => builtCommand.handleSessionShutdown());
});

test("findLastAssistantMessage reports stable diagnostics for missing, incomplete, and empty messages", () => {
  assert.deepEqual(findLastAssistantMessage([]), {
    ok: false,
    code: "missing",
    message: "No assistant messages found on the current session branch.",
  });

  assert.deepEqual(
    findLastAssistantMessage([
      messageEntry("assistant", [{ type: "text", text: "Still running" }], "max_tokens"),
    ]),
    {
      ok: false,
      code: "incomplete",
      message:
        "Latest assistant message is incomplete (max_tokens). Wait for it to finish, then try again.",
    },
  );

  assert.deepEqual(
    findLastAssistantMessage([messageEntry("assistant", [{ type: "image", source: "ignored" }])]),
    {
      ok: false,
      code: "empty",
      message: "Latest assistant message has no text to annotate.",
    },
  );
});

test("findLastAssistantMessage selects the latest completed assistant message on the active branch", () => {
  const result = findLastAssistantMessage([
    { type: "branch", branchId: "root" },
    messageEntry("assistant", [{ type: "text", text: "Earlier assistant reply" }]),
    messageEntry("user", [{ type: "text", text: "Question" }]),
    { type: "tool_call", toolName: "bash" },
    messageEntry("assistant", [{ type: "text", text: "Latest assistant reply" }]),
    messageEntry("user", [{ type: "text", text: "Follow-up" }]),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.data.text, "Latest assistant reply");
  assert.deepEqual(result.data.lines, [{ number: 1, text: "Latest assistant reply" }]);
});

test("findLastAssistantMessage extracts text blocks into normalized lines and sections", () => {
  const result = findLastAssistantMessage([
    messageEntry("assistant", [
      { type: "text", text: "Intro line\r\nDetail line" },
      { type: "image", source: "ignored" },
      { type: "text", text: "Third line\n\nClosing line" },
    ]),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.data.text, "Intro line\nDetail line\nThird line\n\nClosing line");
  assert.deepEqual(result.data.lines, [
    { number: 1, text: "Intro line" },
    { number: 2, text: "Detail line" },
    { number: 3, text: "Third line" },
    { number: 4, text: "" },
    { number: 5, text: "Closing line" },
  ]);
  assert.deepEqual(result.data.sections, [
    {
      id: "section-1",
      index: 1,
      startLine: 1,
      endLine: 3,
      preview: "Intro line",
      text: "Intro line\nDetail line\nThird line",
    },
    {
      id: "section-2",
      index: 2,
      startLine: 5,
      endLine: 5,
      preview: "Closing line",
      text: "Closing line",
    },
  ]);
});

test("composeAnnotateLastMessagePrompt trims and orders overall, section, inline, and unknown-reference comments", () => {
  const prompt = composeAnnotateLastMessagePrompt(
    {
      text: "Alpha\nBeta\n\nGamma",
      lines: [
        { number: 1, text: "Alpha" },
        { number: 2, text: "Beta" },
        { number: 3, text: "" },
        { number: 4, text: "Gamma" },
      ],
      sections: [
        {
          id: "section-1",
          index: 1,
          startLine: 1,
          endLine: 2,
          preview: "Alpha",
          text: "Alpha\nBeta",
        },
        { id: "section-2", index: 2, startLine: 4, endLine: 4, preview: "Gamma", text: "Gamma" },
      ],
    },
    {
      type: "submit",
      overallComment: "  Tighten the plan.  ",
      sectionComments: [
        { sectionId: "missing", body: "  Unknown section still needs attention.  " },
        { sectionId: "section-2", body: "  Clarify the ending.  " },
        { sectionId: "section-1", body: "" },
      ],
      inlineComments: [
        { line: 99, body: "  Missing line reference.  " },
        { line: 2, body: "  Cite the assumption.  " },
        { line: 1, body: "\n\t" },
      ],
    },
  );

  assert.equal(
    prompt,
    [
      "Please revisit your last assistant message using the annotation feedback below.",
      "",
      "Treat this as planning-oriented feedback:",
      "- update your explanation, plan, or proposed approach in chat;",
      "- do not assume any code or file changes have already been applied;",
      "- do not auto-apply anything outside the normal response flow.",
      "",
      "## Overall guidance",
      "Tighten the plan.",
      "",
      "## Section comments",
      "1. Section 2 (line 4) — “Gamma”",
      "   Clarify the ending.",
      "",
      "2. Unknown section",
      "   Unknown section still needs attention.",
      "",
      "## Inline comments",
      "1. line 2 — “Beta”",
      "   Cite the assumption.",
      "",
      "2. line 99 — “(blank line)”",
      "   Missing line reference.",
      "",
      "Please respond by revising your last message or its plan in chat, incorporating the feedback above.",
    ].join("\n"),
  );
});

test("composeAnnotateLastMessagePrompt excludes inline comments targeting known blank lines but keeps unknown-line comments", () => {
  const message = {
    text: "Alpha\n\nBeta",
    lines: [
      { number: 1, text: "Alpha" },
      { number: 2, text: "" },
      { number: 3, text: "Beta" },
    ],
    sections: [],
  };

  const prompt = composeAnnotateLastMessagePrompt(message, {
    type: "submit",
    overallComment: "",
    sectionComments: [],
    inlineComments: [
      { line: 2, body: "Note on blank line — should be excluded." },
      { line: 3, body: "Note on Beta — should be included." },
      { line: 99, body: "Note on unknown line — should be included." },
    ],
  });

  // blank-line comment (line 2) is excluded
  assert.doesNotMatch(prompt, /Note on blank line/);
  assert.doesNotMatch(prompt, /line 2/);
  // non-blank line comment (line 3) is present
  assert.match(prompt, /Note on Beta/);
  assert.match(prompt, /line 3/);
  // unknown-line comment (line 99) is present and shows (blank line) fallback
  assert.match(prompt, /Note on unknown line/);
  assert.match(prompt, /line 99/);
  assert.match(prompt, /\(blank line\)/);
});

test("hasAnnotateLastMessageFeedback ignores whitespace-only feedback and accepts trimmed comments", () => {
  assert.equal(
    hasAnnotateLastMessageFeedback({
      type: "submit",
      overallComment: "   ",
      inlineComments: [{ line: 2, body: "\n\t" }],
      sectionComments: [{ sectionId: "section-1", body: "  " }],
    }),
    false,
  );

  assert.equal(
    hasAnnotateLastMessageFeedback({
      type: "submit",
      overallComment: "   ",
      inlineComments: [{ line: 2, body: "  Tighten this step.  " }],
      sectionComments: [],
    }),
    true,
  );
});

test("annotate-last-message ignores malformed and primitive window messages", async () => {
  const window = new FakeWindow();
  const { sent, sendUserMessage } = createSendUserMessage();
  const command = buildAnnotateLastMessageCommand({
    openAnnotationWindow: async () => window,
    sendUserMessage,
  });
  const context = createContext({
    branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])],
  });

  await command.handler("", context.ctx);
  const invalidInlineLinePayloads = [0, -1, 1.5].map((line) => ({
    type: "submit",
    overallComment: "bad",
    inlineComments: [{ line, body: "oops" }],
    sectionComments: [],
  }));
  for (const payload of [
    null,
    undefined,
    0,
    "text",
    {},
    { type: "submit" },
    { type: "submit", overallComment: "bad", inlineComments: [], sectionComments: {} },
    {
      type: "submit",
      overallComment: "bad",
      inlineComments: [{ line: "2", body: "oops" }],
      sectionComments: [],
    },
    ...invalidInlineLinePayloads,
    {
      type: "submit",
      overallComment: "bad",
      inlineComments: [],
      sectionComments: [{ sectionId: 1, body: "oops" }],
    },
  ]) {
    assert.doesNotThrow(() => {
      window.emit("message", payload);
    });
  }

  await flushAsyncWork();
  assert.deepEqual(sent, []);
  assert.deepEqual(context.notifications, [
    { message: "Opened native annotation window.", level: "info" },
  ]);
  command.handleSessionShutdown();
});

test("annotate-last-message blocks concurrent opens until the first annotation window resolves", async () => {
  const openDeferred = createDeferred();
  const window = new FakeWindow();
  let openCalls = 0;
  const command = buildAnnotateLastMessageCommand({
    openAnnotationWindow: async () => {
      openCalls += 1;
      return openDeferred.promise;
    },
  });
  const context = createContext({
    branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])],
  });

  const first = command.handler("", context.ctx);
  await Promise.resolve();
  await command.handler("", context.ctx);
  assert.equal(openCalls, 1);
  assert.deepEqual(context.notifications, [
    { message: "A last-message annotation window is already open.", level: "warning" },
  ]);

  openDeferred.resolve(window);
  await first;
  assert.equal(context.notifications.at(-1)?.message, "Opened native annotation window.");
  command.handleSessionShutdown();
});

test("annotate-last-message cancels a pending open on shutdown without blocking a later invocation", async () => {
  const firstOpen = createDeferred();
  const firstWindow = new FakeWindow();
  const secondWindow = new FakeWindow();
  let openCalls = 0;
  const command = buildAnnotateLastMessageCommand({
    openAnnotationWindow: async () => {
      openCalls += 1;
      return openCalls === 1 ? firstOpen.promise : secondWindow;
    },
  });
  const context = createContext({
    branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])],
  });

  const interrupted = command.handler("", context.ctx);
  await flushAsyncWork();
  assert.equal(openCalls, 1);

  command.handleSessionShutdown();
  await command.handler("", context.ctx);
  assert.equal(openCalls, 2);
  assert.equal(secondWindow.closeCalls, 0);

  firstOpen.resolve(firstWindow);
  await interrupted;
  assert.equal(firstWindow.closeCalls, 1);
  assert.equal(
    context.notifications.filter(({ message }) => message === "Opened native annotation window.")
      .length,
    1,
  );

  command.handleSessionShutdown();
  assert.equal(secondWindow.closeCalls, 1);
});

test("annotate-last-message suppresses terminal results settled immediately before shutdown", async (t) => {
  const terminalEvents = [
    {
      name: "submit",
      emit(window) {
        window.emit("message", {
          type: "submit",
          overallComment: "Queued feedback",
          inlineComments: [],
          sectionComments: [],
        });
      },
    },
    {
      name: "error",
      emit(window) {
        window.emit("error", new Error("queued failure"));
      },
    },
  ];

  for (const terminalEvent of terminalEvents) {
    await t.test(terminalEvent.name, async () => {
      const window = new FakeWindow();
      const { sent, sendUserMessage } = createSendUserMessage();
      const command = buildAnnotateLastMessageCommand({
        openAnnotationWindow: async () => window,
        sendUserMessage,
      });
      const context = createContext({
        branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])],
      });

      await command.handler("", context.ctx);
      terminalEvent.emit(window);
      command.handleSessionShutdown();
      await flushAsyncWork();

      assert.equal(window.closeCalls, 0);
      assert.deepEqual(sent, []);
      assert.deepEqual(context.notifications, [
        { message: "Opened native annotation window.", level: "info" },
      ]);
    });
  }
});

test("annotate-last-message suppresses late submit and error events after shutdown", async () => {
  const timers = [];
  const window = new FakeWindow();
  const { sent, sendUserMessage } = createSendUserMessage();
  const command = buildAnnotateLastMessageCommand({
    openAnnotationWindow: async () => window,
    sendUserMessage,
    setTimeoutFn: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeoutFn: () => {},
  });
  const context = createContext({
    branch: [messageEntry("assistant", [{ type: "text", text: "Latest reply" }])],
  });

  await command.handler("", context.ctx);
  command.handleSessionShutdown();
  window.emit("error", new Error("too late"));
  window.emit("message", {
    type: "submit",
    overallComment: "Late feedback",
    inlineComments: [],
    sectionComments: [],
  });
  for (const timer of timers) {
    timer();
  }
  await flushAsyncWork();

  assert.equal(window.closeCalls, 1);
  assert.deepEqual(sent, []);
  assert.deepEqual(context.notifications, [
    { message: "Opened native annotation window.", level: "info" },
  ]);
});

test("annotate-last-message sends feedback to the agent via sendUserMessage with deliverAs followUp", async () => {
  const window = new FakeWindow();
  const { sent, sendUserMessage } = createSendUserMessage();
  const command = buildAnnotateLastMessageCommand({
    openAnnotationWindow: async () => window,
    sendUserMessage,
  });
  const context = createContext({
    branch: [messageEntry("assistant", [{ type: "text", text: "Alpha\n\nBeta" }])],
  });

  await command.handler("", context.ctx);
  window.emit("message", {
    type: "submit",
    overallComment: "  Tighten the structure.  ",
    inlineComments: [],
    sectionComments: [],
  });
  await flushAsyncWork();

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /^Please revisit your last assistant message/);
  assert.deepEqual(sent[0].options, { deliverAs: "followUp" });
  assert.equal(context.notifications.at(-1)?.message, "Annotation feedback sent to the agent.");
});

// ---------------------------------------------------------------------------
// buildAnnotateLastMessageHtml — theme injection
// ---------------------------------------------------------------------------

const MINIMAL_DATA = {
  text: "Hello",
  lines: [{ number: 1, text: "Hello" }],
  sections: [
    { id: "section-1", index: 1, startLine: 1, endLine: 1, preview: "Hello", text: "Hello" },
  ],
};

test("buildAnnotateLastMessageHtml: built HTML contains injected theme custom properties", () => {
  const html = buildAnnotateLastMessageHtml(MINIMAL_DATA);
  // The vars must be declared inside the injected <style id="tlh-theme-vars"> block,
  // not merely referenced in CSS rules elsewhere in the page.
  const match = html.match(/<style[^>]+id="tlh-theme-vars"[^>]*>([\s\S]*?)<\/style>/);
  assert.ok(match, '<style id="tlh-theme-vars"> element must be present in the built HTML');
  const styleContent = match[1];
  assert.match(styleContent, /--mdHeading/, "injected block must declare --mdHeading");
  assert.match(styleContent, /--mdCode/, "injected block must declare --mdCode");
  assert.match(styleContent, /--accent/, "injected block must declare --accent");
  assert.match(styleContent, /--muted/, "injected block must declare --muted");
  assert.match(styleContent, /--dim/, "injected block must declare --dim");
});

test("buildAnnotateLastMessageHtml: __INLINE_THEME__ placeholder is replaced", () => {
  const html = buildAnnotateLastMessageHtml(MINIMAL_DATA);
  assert.doesNotMatch(html, /__INLINE_THEME__/);
});

test("buildAnnotateLastMessageHtml: injected :root block appears after static :root defaults", () => {
  const html = buildAnnotateLastMessageHtml(MINIMAL_DATA);
  // The static :root with fallback --accent: #f4c95d must appear before the
  // injected :root block (which also defines --accent), so the injected value
  // wins the cascade.
  const staticDefaultPos = html.indexOf("--accent: #f4c95d");
  const tlhThemeVarsPos = html.indexOf('id="tlh-theme-vars"');
  assert.ok(staticDefaultPos !== -1, "static --accent fallback not found");
  assert.ok(tlhThemeVarsPos !== -1, "tlh-theme-vars style element not found");
  assert.ok(
    staticDefaultPos < tlhThemeVarsPos,
    "injected theme vars must appear after the static :root defaults to win the cascade",
  );
});

test("buildAnnotateLastMessageHtml: existing inline-data escaping behaviour is unchanged", () => {
  const dataWithSpecialChars = {
    text: "<script>alert('xss')</script>",
    lines: [{ number: 1, text: "<script>alert('xss')</script>" }],
    sections: [],
  };
  const html = buildAnnotateLastMessageHtml(dataWithSpecialChars);
  // Angle brackets must be escaped in the JSON payload.
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /\\u003cscript\\u003e/);
});

test("buildAnnotateLastMessageHtml: $-pattern sequences in assistant text are inlined literally without corruption", () => {
  // Regression: String.replace(token, string) interprets $& $` $' $$ as
  // replacement patterns, corrupting the injected JSON payload when the
  // assistant message contains those sequences.
  const specialText = "cost is $& and $` plus $' and $$";
  const data = {
    text: specialText,
    lines: [{ number: 1, text: specialText }],
    sections: [],
  };
  const html = buildAnnotateLastMessageHtml(data);

  // Extract the inlined JSON payload from the inline-data script element.
  const scriptMatch = html.match(
    /<script[^>]*\bid="annotate-last-message-data"[^>]*>([\s\S]*?)<\/script>/,
  );
  assert.ok(scriptMatch, "could not find inline-data script element in built HTML");
  const inlinedText = scriptMatch[1].trim();

  // The payload must be valid JSON that round-trips the original text.
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(inlinedText);
  }, "inlined JSON payload must be parseable ($ patterns must not corrupt it)");
  assert.equal(
    parsed.text,
    specialText,
    "parsed text must round-trip back to the original, including $& $` $' $$ sequences",
  );
});

test("buildAnnotateLastMessageHtml: markdown-content CSS classes are defined in the output", () => {
  const html = buildAnnotateLastMessageHtml(MINIMAL_DATA);
  assert.match(html, /\.markdown-content/);
  assert.match(html, /--mdHeading/);
  assert.match(html, /--mdCode/);
  assert.match(html, /--mdQuoteBorder/);
  assert.match(html, /--mdListBullet/);
  assert.match(html, /--mdHr/);
  assert.match(html, /font-weight: bold/);
  assert.match(html, /font-style: italic/);
});

// ---------------------------------------------------------------------------
// Guard tests: renderer is inlined from md-renderer.js, not duplicated in app.js
// ---------------------------------------------------------------------------

test("buildAnnotateLastMessageHtml: renderer definition appears exactly once in built HTML", () => {
  const html = buildAnnotateLastMessageHtml(MINIMAL_DATA);
  // applyFenceState is a distinctive symbol that only lives in md-renderer.js.
  const occurrences = (html.match(/function applyFenceState/g) ?? []).length;
  assert.equal(occurrences, 1, "applyFenceState must be defined exactly once in the built HTML");
});

test("buildAnnotateLastMessageHtml: app.js does not contain the parsing function definitions", async () => {
  // Verify the single-source guarantee: the shipped app.js must not define
  // the parsing functions that md-renderer.js owns.
  const { readFileSync } = await import("node:fs");
  const appJs = readFileSync(
    new URL("../extensions/the-last-harness/annotate-last-message/web/app.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(appJs, /function applyFenceState/, "app.js must not define applyFenceState");
  assert.doesNotMatch(appJs, /function classifyLine/, "app.js must not define classifyLine");
  assert.doesNotMatch(appJs, /function tokenizeLine/, "app.js must not define tokenizeLine");
});
