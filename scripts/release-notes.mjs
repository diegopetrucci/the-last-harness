#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

function usage() {
	return `Usage: node scripts/release-notes.mjs [options]

Extract the current release notes from CHANGELOG.md.

Options:
  --tag <tag>          Release tag or version (default: GITHUB_REF_NAME)
  --changelog <path>   Changelog file to read (default: CHANGELOG.md)
  --output <path>      File to write; omit to print to stdout
  --repository <repo>  GitHub repository for the full changelog link (default: GITHUB_REPOSITORY)
  --ref <ref>          Git ref for the full changelog link (default: tag)
  -h, --help           Show this help
`;
}

function parseArgs(argv) {
	const args = {
		tag: process.env.GITHUB_REF_NAME,
		changelogPath: "CHANGELOG.md",
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
		if (arg === "--changelog") {
			args.changelogPath = requiredValue(argv, ++i, arg);
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
			args.tag = arg.slice("--tag=".length);
			continue;
		}
		if (arg.startsWith("--changelog=")) {
			args.changelogPath = arg.slice("--changelog=".length);
			continue;
		}
		if (arg.startsWith("--output=")) {
			args.outputPath = arg.slice("--output=".length);
			continue;
		}
		if (arg.startsWith("--repository=")) {
			args.repository = arg.slice("--repository=".length);
			continue;
		}
		if (arg.startsWith("--ref=")) {
			args.ref = arg.slice("--ref=".length);
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

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function versionFromTag(tag) {
	if (!tag) {
		throw new Error("Missing release tag. Pass --tag or set GITHUB_REF_NAME.");
	}
	return tag.startsWith("v") ? tag.slice(1) : tag;
}

function extractChangelogSection(changelog, version) {
	const normalized = changelog.replace(/\r\n/g, "\n");
	const escapedVersion = escapeRegExp(version);
	const headingPattern = new RegExp(`^##\\s+\\[?${escapedVersion}\\]?(?:\\s+-\\s+[^\\n]+)?\\s*$`, "m");
	const match = headingPattern.exec(normalized);
	if (!match) {
		throw new Error(`CHANGELOG.md is missing a section for ${version}. Expected a heading like "## [${version}] - YYYY-MM-DD".`);
	}

	const sectionStart = match.index + match[0].length;
	const remaining = normalized.slice(sectionStart);
	const nextSectionOffset = remaining.search(/^##\s+/m);
	const section = (nextSectionOffset === -1 ? remaining : remaining.slice(0, nextSectionOffset)).trim();
	if (!section) {
		throw new Error(`CHANGELOG.md section for ${version} is empty.`);
	}
	return section;
}

function buildNotes(args) {
	const tag = args.tag;
	const version = versionFromTag(tag);
	const changelog = readFileSync(args.changelogPath, "utf8");
	const section = extractChangelogSection(changelog, version);
	const ref = args.ref ?? tag;
	const suffix = args.repository && ref
		? `\n\n---\n\nFull changelog: https://github.com/${args.repository}/blob/${ref}/CHANGELOG.md\n`
		: "\n";
	return `${section}${suffix}`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(usage());
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
