#!/usr/bin/env node
/**
 * Verify relative Markdown links, images, and #anchors in git-tracked docs.
 *
 * Skips external links (any URI scheme), links inside fenced code blocks or
 * inline code spans, and vendored closures (skills/, node_modules/, .tickets/).
 * Anchors are matched against GitHub-style heading slugs (including `-1`
 * suffixes for duplicate headings) and explicit HTML id/name attributes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXCLUDED_PREFIXES = ["skills/", "node_modules/", ".tickets/"];
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Remove fenced code blocks and inline code spans, keeping line numbers. */
function stripCode(text, keepInline = false) {
  const lines = text.split(/\r?\n/);
  let fence = null;
  return lines.map((line) => {
    const match = FENCE_RE.exec(line);
    if (fence !== null) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      return "";
    }
    if (match) {
      fence = match[1];
      return "";
    }
    if (keepInline) return line;
    return line.replace(/(`+)[^`]*?\1/g, (span) => " ".repeat(span.length));
  });
}

function slugify(heading) {
  const plain = heading
    .replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .trim()
    .toLowerCase();
  return plain.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/ /g, "-");
}

/** Collect the set of valid anchors for a Markdown document. */
export function collectAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  const lines = stripCode(text, true);
  const add = (heading) => {
    const base = slugify(heading);
    let seen = counts.get(base) ?? 0;
    let slug = seen === 0 ? base : `${base}-${seen}`;
    // GitHub keeps incrementing until the generated slug is unused, so a
    // literal "Foo-1" heading collides with the suffix of a duplicate "Foo".
    while (anchors.has(slug)) {
      seen += 1;
      slug = `${base}-${seen}`;
    }
    counts.set(base, seen + 1);
    anchors.add(slug);
  };
  lines.forEach((line, index) => {
    const atx = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) add(atx[1]);
    else if (
      index > 0 &&
      /^ {0,3}(=+|-+)[ \t]*$/.test(line) &&
      /\S/.test(lines[index - 1]) &&
      !/^ {0,3}(#|>|[-*+] |\d+[.)] )/.test(lines[index - 1])
    ) {
      add(lines[index - 1].trim());
    }
    for (const match of line.matchAll(/<[a-z][^>]*\s(?:id|name)=["']([^"']+)["']/gi)) {
      anchors.add(match[1]);
    }
  });
  return anchors;
}

/** Read an inline link destination: <angle> form, or bare with balanced/escaped parens. */
function readDestination(line, start) {
  if (line[start] === "<") {
    const end = line.indexOf(">", start);
    return end === -1 ? null : line.slice(start + 1, end);
  }
  let depth = 0;
  let out = "";
  for (let i = start; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length && /[()\\]/.test(line[i + 1])) {
      out += line[(i += 1)];
    } else if (ch === "(") {
      depth += 1;
      out += ch;
    } else if (ch === ")") {
      if (depth === 0) return out;
      depth -= 1;
      out += ch;
    } else if (/\s/.test(ch)) {
      return out;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Extract { line, target } link destinations from Markdown text. */
export function extractLinks(text) {
  const links = [];
  stripCode(text).forEach((line, index) => {
    for (const match of line.matchAll(/!?\[(?:[^\][]|\[[^\]]*\])*\]\(\s*/g)) {
      const target = readDestination(line, match.index + match[0].length);
      if (target !== null) links.push({ line: index + 1, target });
    }
    const ref = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (ref) links.push({ line: index + 1, target: ref[1].replace(/^<|>$/g, "") });
  });
  return links;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * @param {string} root
 * @param {string[]} files repo-relative Markdown paths
 * @returns {string[]} human-readable problems
 */
export function checkDocLinks(root, files) {
  const problems = [];
  const anchorCache = new Map();
  const anchorsFor = (absolute) => {
    if (!anchorCache.has(absolute)) {
      anchorCache.set(absolute, collectAnchors(readFileSync(absolute, "utf8")));
    }
    return anchorCache.get(absolute);
  };

  for (const file of files) {
    const absoluteFile = resolve(root, file);
    for (const { line, target } of extractLinks(readFileSync(absoluteFile, "utf8"))) {
      if (target === "" || SCHEME_RE.test(target) || target.startsWith("//")) continue;
      const hashIndex = target.indexOf("#");
      const rawPath = (hashIndex === -1 ? target : target.slice(0, hashIndex)).split("?")[0];
      const anchor = hashIndex === -1 ? "" : decode(target.slice(hashIndex + 1));
      const where = `${file}:${line}`;

      const absoluteTarget =
        rawPath === ""
          ? absoluteFile
          : rawPath.startsWith("/")
            ? resolve(root, `.${decode(rawPath)}`)
            : resolve(dirname(absoluteFile), decode(rawPath));
      const inRoot = !relative(root, absoluteTarget).startsWith("..");
      if (!inRoot || !existsSync(absoluteTarget)) {
        problems.push(`${where}: missing file for link "${target}"`);
        continue;
      }
      if (
        anchor === "" ||
        !absoluteTarget.endsWith(".md") ||
        statSync(absoluteTarget).isDirectory()
      ) {
        continue;
      }
      if (
        !anchorsFor(absoluteTarget).has(anchor.toLowerCase()) &&
        !anchorsFor(absoluteTarget).has(anchor)
      ) {
        problems.push(
          `${where}: missing anchor "#${anchor}" in ${relative(root, absoluteTarget).split(sep).join("/")}`,
        );
      }
    }
  }
  return problems;
}

export function listMarkdownFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: root,
    encoding: "utf8",
  });
  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .filter((file) => existsSync(resolve(root, file)));
}

function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const files = listMarkdownFiles(root);
  const problems = checkDocLinks(root, files);
  if (problems.length > 0) {
    console.error("Broken Markdown links:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Doc links OK (${files.length} Markdown files checked).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
