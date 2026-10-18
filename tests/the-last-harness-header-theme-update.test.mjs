/**
 * Tests that the TLH header logo is computed at render time from the live
 * theme object, not captured once at construction.
 *
 * Pi's exported `theme` is a Proxy over globalThis that reads from the current
 * global theme on every property access (see node_modules/@earendil-works/
 * pi-coding-agent/dist/modes/interactive/theme/theme.js ~515-525). A theme
 * switch replaces what the same proxy object resolves to; the proxy reference
 * itself does not change. The real fix is therefore simply computing the logo
 * inside the render function, not storing a separate currentTheme variable or
 * exposing setTheme().
 *
 * These tests model that mechanism: the header receives a single proxy-like
 * theme object whose fg/bold methods delegate to a swappable backing theme.
 * Swapping the backing simulates what Pi does when the user changes themes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhHeader } = await jiti.import("../extensions/the-last-harness/header.ts");

/**
 * Build a proxy-like theme object backed by a mutable reference.
 * Swapping `ref.current` simulates Pi's globalThis-backed Proxy: the same
 * object reference is passed to createTlhHeader, but subsequent property reads
 * return values from the new backing.
 */
function makeProxyTheme() {
  const ref = { current: null };
  const proxy = {
    fg: (color, text) => ref.current.fg(color, text),
    bold: (text) => ref.current.bold(text),
    setBackingTheme(t) {
      ref.current = t;
    },
  };
  return proxy;
}

function makeTaggedTheme(tag) {
  return {
    fg: (_color, text) => `[${tag}:${text}]`,
    bold: (text) => `<bold-${tag}:${text}>`,
  };
}

function createEmptyResources() {
  return {
    context: [],
    skills: [],
    prompts: [],
    extensions: [],
    themes: [],
  };
}

// ---------------------------------------------------------------------------
// Collapsed header
// ---------------------------------------------------------------------------

test("collapsed header logo uses theme A at construction time", () => {
  const proxy = makeProxyTheme();
  proxy.setBackingTheme(makeTaggedTheme("A"));

  const header = createTlhHeader(proxy, createEmptyResources(), undefined);
  const lines = header.render(120);

  assert.ok(
    lines[0].includes("[A:") || lines[0].includes("bold-A"),
    `first render must use theme A colors; got: ${JSON.stringify(lines[0])}`,
  );
});

test("collapsed header logo reflects swapped backing theme after proxy update", () => {
  const proxy = makeProxyTheme();
  proxy.setBackingTheme(makeTaggedTheme("A"));

  const header = createTlhHeader(proxy, createEmptyResources(), undefined);

  // Verify theme A initially.
  const before = header.render(120)[0];
  assert.ok(
    before.includes("[A:") || before.includes("bold-A"),
    `initial render must use theme A; got: ${JSON.stringify(before)}`,
  );

  // Swap the backing — same proxy reference, new resolution.
  proxy.setBackingTheme(makeTaggedTheme("B"));

  const after = header.render(120)[0];
  assert.ok(
    after.includes("[B:") || after.includes("bold-B"),
    `re-render after backing swap must use theme B colors; got: ${JSON.stringify(after)}`,
  );
  assert.ok(
    !after.includes("[A:") && !after.includes("bold-A"),
    `re-render after backing swap must not contain stale theme A colors; got: ${JSON.stringify(after)}`,
  );
});

// ---------------------------------------------------------------------------
// Expanded header
// ---------------------------------------------------------------------------

test("expanded header logo reflects swapped backing theme after proxy update", () => {
  const proxy = makeProxyTheme();
  proxy.setBackingTheme(makeTaggedTheme("A"));

  const header = createTlhHeader(proxy, createEmptyResources(), undefined);
  header.setExpanded(true);

  proxy.setBackingTheme(makeTaggedTheme("B"));

  const after = header.render(120)[0];
  assert.ok(
    after.includes("[B:") || after.includes("bold-B"),
    `expanded re-render after swap must use theme B; got: ${JSON.stringify(after)}`,
  );
  assert.ok(
    !after.includes("[A:") && !after.includes("bold-A"),
    `expanded re-render must not contain stale theme A; got: ${JSON.stringify(after)}`,
  );
});

// ---------------------------------------------------------------------------
// Header with headerUpdate (version / releasesUrl)
// ---------------------------------------------------------------------------

test("logo with headerUpdate reflects swapped backing theme after proxy update", () => {
  const proxy = makeProxyTheme();
  proxy.setBackingTheme(makeTaggedTheme("A"));

  const headerUpdate = { version: "1.0.0", releasesUrl: "https://example.com" };
  const header = createTlhHeader(proxy, createEmptyResources(), headerUpdate);

  proxy.setBackingTheme(makeTaggedTheme("B"));

  const after = header.render(120)[0];
  assert.ok(
    after.includes("[B:") || after.includes("bold-B"),
    `logo with headerUpdate must use theme B after swap; got: ${JSON.stringify(after)}`,
  );
  assert.ok(
    !after.includes("[A:") && !after.includes("bold-A"),
    `logo with headerUpdate must not contain stale theme A after swap; got: ${JSON.stringify(after)}`,
  );
});

// ---------------------------------------------------------------------------
// Regression guard: old precomputed-logo behaviour would have failed this
// ---------------------------------------------------------------------------

test("demonstrates that a precomputed logo would fail the backing-swap test", () => {
  // The OLD code did: const logo = theme.bold(color.accent(TLH_NAME));
  // and then every render returned [logo, ...]. Simulating that here shows it
  // would serve stale theme-A colors even after the backing switches to B.
  const proxy = makeProxyTheme();
  proxy.setBackingTheme(makeTaggedTheme("A"));

  // Capture the logo at construction time (old behaviour).
  const capturedLogo = proxy.bold(proxy.fg("accent", "tlh"));

  // Switch the backing to B.
  proxy.setBackingTheme(makeTaggedTheme("B"));

  // The captured value still has A tags — proof the old approach was broken.
  assert.ok(
    capturedLogo.includes("[A:") || capturedLogo.includes("bold-A"),
    `captured logo must still contain theme A after backing switch (demonstrates old bug)`,
  );
  assert.ok(
    !capturedLogo.includes("[B:") && !capturedLogo.includes("bold-B"),
    `captured logo must not have theme B colors (confirms old code was stale)`,
  );

  // The current createTlhHeader renders correctly because it calls
  // theme.bold(color.accent(...)) inside renderLogo() at render time.
  const header = createTlhHeader(proxy, createEmptyResources(), undefined);
  const after = header.render(120)[0];
  assert.ok(
    after.includes("[B:") || after.includes("bold-B"),
    `createTlhHeader render-time logo must use current (B) theme; got: ${JSON.stringify(after)}`,
  );
});
