#!/usr/bin/env node
/**
 * Node test-runner reporter used only by the opt-in CI timing collector.
 *
 * It emits one bounded JSONL record per file summary.  The ordinary reporter
 * remains responsible for stdout, so enabling timings does not hide TAP or
 * dot diagnostics.
 */

const MAX_EVENT_BYTES = 1024 * 1024;

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function relativeFile(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const root = process.env.TLH_CI_TIMINGS_REPO_ROOT;
  if (!root) return "";
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedFile = value.replaceAll("\\", "/");
  if (normalizedFile === normalizedRoot) return "";
  const prefix = `${normalizedRoot}/`;
  if (!normalizedFile.startsWith(prefix)) return "";
  const result = normalizedFile.slice(prefix.length);
  if (!result || result.split("/").includes("..")) return "";
  return result;
}

/**
 * @param {AsyncIterable<{ type?: string; data?: Record<string, unknown> }>} source
 */
export default async function* timingReporter(source) {
  let bytes = 0;
  let truncated = false;
  const suite = process.env.TLH_CI_TIMINGS_SUITE ?? "unknown";
  const marker = `${JSON.stringify({ type: "truncated", suite, maxBytes: MAX_EVENT_BYTES })}\n`;
  const markerBytes = Buffer.byteLength(marker);
  const dataLimit = MAX_EVENT_BYTES - markerBytes;

  for await (const event of source) {
    if (event.type !== "test:summary") continue;
    const data = event.data;
    if (!data) continue;
    const file = relativeFile(data.file);
    const durationMs = finiteNonNegative(data.duration_ms);
    if (!file || durationMs === null) continue;

    const counts = data.counts;
    const record = {
      type: "file",
      suite,
      file,
      durationMs,
      status: data.success === true ? "passed" : "not-passed",
      ...(counts && typeof counts === "object" ? { counts } : {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (bytes + lineBytes <= dataLimit) {
      bytes += lineBytes;
      yield line;
    } else if (!truncated) {
      truncated = true;
      yield marker;
    }
  }
}
