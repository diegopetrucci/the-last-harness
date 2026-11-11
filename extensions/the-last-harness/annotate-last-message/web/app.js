/* global window, document */

// Markdown parsing helpers are provided by the md-renderer.js script that
// ui.ts inlines before this file.  Access them via globalThis.__tlhMdRenderer.

const messageData = JSON.parse(
  document.getElementById("annotate-last-message-data").textContent || "{}",
);
if (!Array.isArray(messageData.lines)) messageData.lines = [];
if (!Array.isArray(messageData.sections)) messageData.sections = [];

const state = {
  overallComment: "",
  inlineComments: new Map(),
  sectionComments: new Map(),
};

const elements = {
  messageLines: document.getElementById("message-lines"),
  overallComment: document.getElementById("overall-comment"),
  sectionComments: document.getElementById("section-comments"),
  status: document.getElementById("status"),
  submitButton: document.getElementById("submit-button"),
  cancelButton: document.getElementById("cancel-button"),
  submitHint: document.getElementById("submit-hint"),
};

function feedbackCount() {
  let count = state.overallComment.trim().length > 0 ? 1 : 0;
  for (const value of state.inlineComments.values()) {
    if (value.trim().length > 0) count += 1;
  }
  for (const value of state.sectionComments.values()) {
    if (value.trim().length > 0) count += 1;
  }
  return count;
}

function setStatus(message, status = "idle") {
  elements.status.textContent = message;
  elements.status.dataset.state = status;
}

function updateSubmitState() {
  const count = feedbackCount();
  elements.submitButton.disabled = count === 0;
  if (count === 0) {
    setStatus("Add any feedback you want to send to the agent.");
    return;
  }
  const noun = count === 1 ? "item" : "items";
  setStatus(`Ready to submit ${count} feedback ${noun}.`, "ready");
}

function setInlineComment(lineNumber, value) {
  state.inlineComments.set(lineNumber, value);
  updateSubmitState();
}

function setSectionComment(sectionId, value) {
  state.sectionComments.set(sectionId, value);
  updateSubmitState();
}

const autoGrowTextareas = [];

// No-op without layout (test fake DOM) or when hidden (scrollHeight is 0).
function autoGrow(textarea) {
  if (!textarea || !textarea.style || typeof textarea.scrollHeight !== "number") return;
  textarea.style.height = "auto";
  if (textarea.scrollHeight <= 0) return;
  const borders = (textarea.offsetHeight || 0) - (textarea.clientHeight || 0);
  textarea.style.height = `${textarea.scrollHeight + Math.max(0, borders)}px`;
}

function enableAutoGrow(textarea) {
  autoGrowTextareas.push(textarea);
  textarea.addEventListener("input", () => autoGrow(textarea));
}

function createPencilIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of [
    "M2 14l.8-3.4L11 2.4a1.4 1.4 0 0 1 2 0l.6.6a1.4 1.4 0 0 1 0 2L5.4 13.2z",
    "M9.5 4l2.5 2.5",
  ]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function createInlineEditor(line) {
  const container = document.createElement("div");
  container.className = "inline-editor";
  container.hidden = true;

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Note on this line…";
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "off");
  textarea.value = state.inlineComments.get(line.number) || "";
  enableAutoGrow(textarea);
  container.append(textarea);

  return { container, textarea };
}

// ---------------------------------------------------------------------------
// Markdown DOM rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render an array of inline tokens into a parent element using
 * createElement/textContent only (no innerHTML).
 */
function renderInlineTokens(parent, tokens) {
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        parent.append(document.createTextNode(token.text));
        break;
      case "code": {
        const code = document.createElement("code");
        code.textContent = token.text;
        parent.append(code);
        break;
      }
      case "bold": {
        const strong = document.createElement("strong");
        renderInlineTokens(strong, token.children);
        parent.append(strong);
        break;
      }
      case "italic": {
        const em = document.createElement("em");
        renderInlineTokens(em, token.children);
        parent.append(em);
        break;
      }
      case "boldItalic": {
        const strong = document.createElement("strong");
        const em = document.createElement("em");
        renderInlineTokens(em, token.children);
        strong.append(em);
        parent.append(strong);
        break;
      }
      case "strikethrough": {
        const s = document.createElement("s");
        renderInlineTokens(s, token.children);
        parent.append(s);
        break;
      }
      case "link": {
        // Render the link label text inside an <a> element.
        // href is intentionally not set to avoid javascript: URL XSS;
        // the URL is shown as muted text beside the link.
        const a = document.createElement("a");
        renderInlineTokens(a, token.labelTokens);
        const urlSpan = document.createElement("span");
        urlSpan.className = "md-link-url";
        urlSpan.textContent = ` (${token.url})`;
        parent.append(a);
        parent.append(urlSpan);
        break;
      }
      default:
        if (typeof token.text === "string") {
          parent.append(document.createTextNode(token.text));
        }
    }
  }
}

/**
 * Populate a container element with DOM nodes for a classified (non-fence) line.
 * Leading indentation is preserved via text nodes where relevant.
 */
function renderClassifiedLine(container, classification) {
  switch (classification.type) {
    case "heading": {
      const h = document.createElement(`h${classification.level}`);
      renderInlineTokens(h, globalThis.__tlhMdRenderer.tokenizeLine(classification.text));
      container.append(h);
      break;
    }
    case "hr":
      container.append(document.createElement("hr"));
      break;
    case "blockquote": {
      const bq = document.createElement("blockquote");
      renderInlineTokens(bq, globalThis.__tlhMdRenderer.tokenizeLine(classification.text));
      container.append(bq);
      break;
    }
    case "ul":
    case "ol": {
      // Preserve leading indentation as a text node.
      if (classification.indent) {
        container.append(document.createTextNode(classification.indent));
      }
      const bullet = document.createElement("span");
      bullet.style.cssText = "color: var(--mdListBullet)";
      bullet.textContent = classification.bullet;
      container.append(bullet);
      container.append(document.createTextNode(" "));
      renderInlineTokens(container, globalThis.__tlhMdRenderer.tokenizeLine(classification.text));
      break;
    }
    default: {
      // 'plain' and any unrecognised types
      const lineText = typeof classification.text === "string" ? classification.text : "";
      renderInlineTokens(container, globalThis.__tlhMdRenderer.tokenizeLine(lineText));
      break;
    }
  }
}

/**
 * Build the content of a markdown line-text container element.
 * lineType is one of: 'plain' | 'fence-open' | 'fence-body' | 'fence-close'
 */
function renderLineContent(container, rawText, lineType) {
  if (lineType === "fence-body") {
    // Code-block body: raw text, no inline markdown, code-block styling.
    container.style.cssText =
      "border-left: var(--bar-width) solid var(--mdCodeBlockBorder); padding-left: var(--space-2);";
    const code = document.createElement("code");
    code.style.cssText = "display: block; color: var(--mdCodeBlock, var(--text))";
    code.textContent = rawText.length > 0 ? rawText : " ";
    container.append(code);
    return;
  }

  if (lineType === "fence-open" || lineType === "fence-close") {
    // Fence delimiter: visible, styled as block-edge marker.
    const span = document.createElement("span");
    span.style.cssText = "color: var(--mdCodeBlockBorder)";
    span.textContent = rawText;
    container.append(span);
    return;
  }

  // Plain line: classify and render inline markdown.
  if (rawText.trim().length === 0) {
    container.textContent = " ";
    return;
  }

  renderClassifiedLine(container, globalThis.__tlhMdRenderer.classifyLine(rawText));
}

// ---------------------------------------------------------------------------
// Line row and section card builders
// ---------------------------------------------------------------------------

function createLineRow(line, lineType) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-line";
  const row = document.createElement("div");
  row.className = "message-line-row";

  const lineNumber = document.createElement("div");
  lineNumber.className = "line-number";
  lineNumber.textContent = String(line.number);
  row.append(lineNumber);

  // Use a <div> with markdown-content class so heading/blockquote/hr/etc.
  // CSS rules inside .markdown-content apply correctly.
  const lineText = document.createElement("div");
  lineText.className = "line-text markdown-content";
  renderLineContent(lineText, line.text, lineType);
  row.append(lineText);
  wrapper.append(row);

  // Blank lines get no inline-note toggle (current behaviour preserved).
  if (line.text.trim().length === 0) return wrapper;
  const toggle = document.createElement("button");
  toggle.className = "inline-toggle";
  toggle.type = "button";
  row.append(toggle);

  const editor = createInlineEditor(line);
  const syncToggle = () => {
    const hasValue = (state.inlineComments.get(line.number) || "").trim().length > 0;
    const open = !editor.container.hidden;
    toggle.dataset.active = hasValue || open ? "true" : "false";
    toggle.dataset.state = open ? "open" : hasValue ? "note" : "empty";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    const label = hasValue ? `Edit note on line ${line.number}` : `Add note to line ${line.number}`;
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    if (!open && hasValue) toggle.replaceChildren(createPencilIcon());
    else toggle.textContent = open ? "\u2212" : "+";
    wrapper.dataset.hasNote = hasValue ? "true" : "false";
  };

  editor.textarea.addEventListener("input", () => {
    setInlineComment(line.number, editor.textarea.value);
    syncToggle();
  });

  editor.textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Stop the document-level Esc handler from cancelling the whole window.
    event.preventDefault();
    event.stopPropagation();
    editor.container.hidden = true;
    syncToggle();
    toggle.focus();
  });

  toggle.addEventListener("click", () => {
    editor.container.hidden = !editor.container.hidden;
    syncToggle();
    if (!editor.container.hidden) {
      editor.textarea.focus();
      autoGrow(editor.textarea);
    }
  });

  wrapper.append(editor.container);
  syncToggle();
  return wrapper;
}

const SECTION_PREVIEW_MAX_LINES = 4;

function createSectionCard(section) {
  const card = document.createElement("div");
  card.className = "section-card";

  const title = document.createElement("h3");
  const lineRange =
    section.startLine === section.endLine
      ? `line ${section.startLine}`
      : `lines ${section.startLine}-${section.endLine}`;
  title.textContent = `Section ${section.index}`;

  const meta = document.createElement("p");
  meta.className = "section-meta";
  meta.textContent = lineRange;

  const header = document.createElement("div");
  header.className = "section-header";
  header.append(title, meta);
  card.append(header);

  // Render section preview with per-line markdown.
  // Fence state is computed fresh for each section (each section is independent).
  const preview = document.createElement("div");
  preview.className = "section-preview markdown-content";

  const sectionLines = section.text.split("\n");
  const fenceState = globalThis.__tlhMdRenderer.applyFenceState(sectionLines);
  const shownCount = Math.min(sectionLines.length, SECTION_PREVIEW_MAX_LINES);
  for (let idx = 0; idx < shownCount; idx++) {
    const lineDiv = document.createElement("div");
    renderLineContent(lineDiv, sectionLines[idx], fenceState[idx].lineType);
    preview.append(lineDiv);
  }
  const hiddenCount = sectionLines.length - shownCount;
  if (hiddenCount > 0) {
    const more = document.createElement("div");
    more.className = "section-preview-more";
    more.textContent = `+${hiddenCount} more ${hiddenCount === 1 ? "line" : "lines"}`;
    preview.append(more);
  }
  card.append(preview);
  const textarea = document.createElement("textarea");
  textarea.placeholder = "Note on this section…";
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "off");
  textarea.value = state.sectionComments.get(section.id) || "";
  textarea.addEventListener("input", () => {
    setSectionComment(section.id, textarea.value);
  });
  enableAutoGrow(textarea);
  card.append(textarea);

  return card;
}

function renderMessageLines() {
  elements.messageLines.replaceChildren();
  // Pre-compute fence state for all lines so each row knows its context.
  const lineTexts = messageData.lines.map((l) => l.text);
  const fenceState = globalThis.__tlhMdRenderer.applyFenceState(lineTexts);
  for (let i = 0; i < messageData.lines.length; i++) {
    elements.messageLines.append(createLineRow(messageData.lines[i], fenceState[i].lineType));
  }
}

function renderSectionComments() {
  elements.sectionComments.replaceChildren();
  if (messageData.sections.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = "This message does not have any non-empty sections to annotate.";
    elements.sectionComments.append(empty);
    return;
  }
  for (const section of messageData.sections) {
    elements.sectionComments.append(createSectionCard(section));
  }
}

function collectPayload() {
  return {
    type: "submit",
    overallComment: state.overallComment,
    inlineComments: Array.from(state.inlineComments.entries()).map(([line, body]) => ({
      line,
      body,
    })),
    sectionComments: Array.from(state.sectionComments.entries()).map(([sectionId, body]) => ({
      sectionId,
      body,
    })),
  };
}

// Set once a terminal message (submit/cancel) has been sent so the Esc status-reset
// timeout never touches a closing window.
let sent = false;

function sendPayload(payload) {
  sent = true;
  window.glimpse?.send?.(payload);
  window.glimpse?.close?.();
}

function submit() {
  if (feedbackCount() === 0) {
    setStatus("Add at least one comment before submitting.", "error");
    return;
  }
  sendPayload(collectPayload());
}

function cancel() {
  sendPayload({ type: "cancel" });
}

const ESC_CONFIRM_MS = 2000;
let escArmedUntil = 0;

// Two-step Esc instead of window.confirm, which is unreliable in WKWebView.
function escapePressed() {
  const count = feedbackCount();
  if (count === 0) {
    cancel();
    return;
  }
  const now = Date.now();
  if (now <= escArmedUntil) {
    cancel();
    return;
  }
  escArmedUntil = now + ESC_CONFIRM_MS;
  const noun = count === 1 ? "note" : "notes";
  setStatus(`Press Esc again to discard ${count} ${noun}`, "error");
  setTimeout(() => {
    if (Date.now() > escArmedUntil && sent === false) updateSubmitState();
  }, ESC_CONFIRM_MS + 50);
}

function submitShortcutHint() {
  try {
    const platform =
      (typeof navigator !== "undefined" &&
        ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform)) ||
      "";
    if (typeof platform === "string" && platform && !/mac|iphone|ipad/i.test(platform)) {
      return "Ctrl \u21B5";
    }
  } catch {
    // fall through to the default
  }
  return "\u2318 \u21B5";
}

elements.submitHint.textContent = submitShortcutHint();

enableAutoGrow(elements.overallComment);
elements.overallComment.addEventListener("input", () => {
  state.overallComment = elements.overallComment.value;
  updateSubmitState();
});

elements.submitButton.addEventListener("click", submit);

elements.cancelButton.addEventListener("click", cancel);

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    submit();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    // Ignore auto-repeat so holding Esc cannot arm and confirm a discard.
    if (event.repeat) return;
    escapePressed();
  }
});

renderMessageLines();
renderSectionComments();
updateSubmitState();
for (const textarea of autoGrowTextareas) autoGrow(textarea);
