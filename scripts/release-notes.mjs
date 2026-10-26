#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function usage() {
  return `Usage: node scripts/release-notes.mjs [options]

Build the GitHub Release body from release-notes/v<version>.md.

Options:
  --tag <tag>          Release tag or version (default: GITHUB_REF_NAME)
  --notes-dir <path>   Directory containing v<version>.md files (default: release-notes)
  --check              Validate the structure of existing release notes files and exit
  --output <path>      File to write; omit to print to stdout
  --repository <repo>  GitHub repository for the full changelog link (default: GITHUB_REPOSITORY)
  --ref <ref>          Git ref for the full changelog link (default: tag)
  -h, --help           Show this help
`;
}

function parseArgs(argv) {
  const args = {
    tag: process.env.GITHUB_REF_NAME,
    notesDir: "release-notes",
    check: false,
    outputPath: undefined,
    repository: process.env.GITHUB_REPOSITORY,
    ref: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--tag") {
      args.tag = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--notes-dir") {
      args.notesDir = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--output") {
      args.outputPath = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--repository") {
      args.repository = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--ref") {
      args.ref = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg.startsWith("--tag=")) {
      args.tag = requireOptionValue(arg.slice("--tag=".length), "--tag");
      continue;
    }
    if (arg.startsWith("--notes-dir=")) {
      args.notesDir = requireOptionValue(arg.slice("--notes-dir=".length), "--notes-dir");
      continue;
    }
    if (arg.startsWith("--output=")) {
      args.outputPath = requireOptionValue(arg.slice("--output=".length), "--output");
      continue;
    }
    if (arg.startsWith("--repository=")) {
      args.repository = requireOptionValue(arg.slice("--repository=".length), "--repository");
      continue;
    }
    if (arg.startsWith("--ref=")) {
      args.ref = requireOptionValue(arg.slice("--ref=".length), "--ref");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function requireOptionValue(value, flag) {
  if (value === "") {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function versionFromTag(tag) {
  const rawTag = String(tag ?? "");
  if (rawTag.trim() === "") {
    throw new Error("Missing release tag. Pass --tag or set GITHUB_REF_NAME.");
  }
  const version = rawTag.startsWith("v") ? rawTag.slice(1) : rawTag;
  if (version.trim() === "") {
    throw new Error("Release tag must include a version after any leading v.");
  }
  return version;
}

function readNotesFile(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Missing release notes file ${label}. Create it before releasing.`, {
        cause: error,
      });
    }
    throw error;
  }
  const notes = raw.replace(/\r\n/g, "\n").trim();
  if (!notes) {
    throw new Error(`Release notes file ${label} is empty.`);
  }
  return notes;
}

function buildNotes(args) {
  const tag = args.tag;
  const version = versionFromTag(tag);
  const label = `${args.notesDir}/v${version}.md`;
  const notes = readNotesFile(join(args.notesDir, `v${version}.md`), label);
  const ref = args.ref ?? tag;
  const suffix =
    args.repository && ref
      ? `\n\n---\n\nFull changelog: https://github.com/${args.repository}/blob/${ref}/CHANGELOG.md\n`
      : "\n";
  return `${notes}${suffix}`;
}

function structureProblems(notes) {
  const problems = [];
  const lines = notes.split("\n");
  if (
    !lines.some(
      (line) => /^\s{0,3}#{1,6}\s+\S/.test(line) || /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line),
    )
  ) {
    problems.push("contains no markdown heading or list item");
  }
  const last = lines[lines.length - 1].trim();
  const isHeading = /^#{1,6}\s+\S/.test(last);
  const isFence = last.startsWith("```");
  const explicitEnd = /[`)]$/.test(last);
  const stripped = last.replace(/[*_"'\u201d\u2019\]]+$/, "");
  if (!isHeading && !isFence && !explicitEnd && !/[.!?:;\u2026]$/.test(stripped)) {
    problems.push(`ends mid-sentence: "${last}"`);
  }
  return problems;
}

function checkNotes(notesDir) {
  let names = [];
  try {
    names = readdirSync(notesDir);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const files = names.filter((name) => /^v.+\.md$/.test(name)).sort();
  const failures = [];
  for (const name of files) {
    const label = `${notesDir}/${name}`;
    const notes = readFileSync(join(notesDir, name), "utf8").replace(/\r\n/g, "\n").trim();
    if (!notes) {
      failures.push(`${label} is empty`);
      continue;
    }
    for (const problem of structureProblems(notes)) failures.push(`${label} ${problem}`);
  }
  if (failures.length > 0) {
    throw new Error(`Invalid release notes:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  }
  return files.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  if (args.check) {
    const count = checkNotes(args.notesDir);
    process.stdout.write(`release-notes: ${count} release notes file(s) OK\n`);
    return;
  }

  const notes = buildNotes(args);
  if (args.outputPath) {
    writeFileSync(args.outputPath, notes, "utf8");
    return;
  }
  process.stdout.write(notes);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`release-notes: ${message}\n`);
  process.exitCode = 1;
}
