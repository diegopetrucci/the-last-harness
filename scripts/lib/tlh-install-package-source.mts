import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SplitGitRefResult {
	repo: string;
	ref?: string;
}

export interface ParsedGitSource {
	repo: string;
	host: string;
	path: string;
	ref?: string;
}

export interface CriticalGitSourceSpec {
	targetDir: string;
	repo: string;
	ref: string;
}

export interface PackageSourceOptions {
	agentDir?: string;
	homeDir?: string;
}

export function splitGitRef(url: string): SplitGitRefResult {
	const hashSeparator = url.lastIndexOf("#");
	if (hashSeparator >= 0) {
		const repo = url.slice(0, hashSeparator);
		const ref = url.slice(hashSeparator + 1);
		if (repo && ref) return { repo, ref };
	}

	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] || "";
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };
		return { repo: `git@${scpLikeMatch[1] || ""}:${repoPath}`, ref };
	}

	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const refSeparator = pathWithMaybeRef.indexOf("@");
			if (refSeparator < 0) return { repo: url };
			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			if (!repoPath || !ref) return { repo: url };
			parsed.pathname = `/${repoPath}`;
			return { repo: parsed.toString().replace(/\/$/, ""), ref };
		} catch {
			return { repo: url };
		}
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) return { repo: url };
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) return { repo: url };
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) return { repo: url };
	return { repo: `${host}/${repoPath}`, ref };
}

export function parseGitSource(source: unknown): ParsedGitSource | undefined {
	const trimmed = String(source ?? "").trim();
	if (!trimmed) return undefined;

	const hasPiGitPrefix = trimmed.startsWith("git:") && !/^git:\/\//i.test(trimmed);
	const url = hasPiGitPrefix ? trimmed.slice(4).trim() : trimmed;
	if (!hasPiGitPrefix && !/^(https?|ssh|git):\/\//i.test(url) && !url.startsWith("git@")) return undefined;

	const { repo: repoWithoutRef, ref } = splitGitRef(url);
	let repo = repoWithoutRef;
	let host: string;
	let repoPath: string;
	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] || "";
		repoPath = scpLikeMatch[2] || "";
	} else if (/^(https?|ssh|git):\/\//i.test(repoWithoutRef)) {
		try {
			const parsed = new URL(repoWithoutRef);
			host = parsed.hostname;
			repoPath = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	} else {
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) return undefined;
		host = repoWithoutRef.slice(0, slashIndex);
		repoPath = repoWithoutRef.slice(slashIndex + 1);
		if (!host.includes(".") && host !== "localhost") return undefined;
		repo = `https://${repoWithoutRef}`;
	}

	const normalizedPath = repoPath.replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !normalizedPath || normalizedPath.split("/").length < 2) return undefined;
	return { repo, host, path: normalizedPath, ref };
}

export function criticalGitSourceSpec(
	source: unknown,
	{ agentDir = "" }: PackageSourceOptions = {},
): CriticalGitSourceSpec | undefined {
	const parsed = parseGitSource(source);
	if (!parsed) return undefined;
	return {
		targetDir: join(agentDir, "git", parsed.host, parsed.path),
		repo: parsed.repo,
		ref: parsed.ref || "",
	};
}

export function formatCriticalGitSourceSpec(spec?: CriticalGitSourceSpec): string {
	if (!spec) return "";
	return `${spec.targetDir}\t${spec.repo}\t${spec.ref || ""}`;
}

export function gitSourceInstallSource(source: unknown, options: PackageSourceOptions = {}): string {
	const text = String(source ?? "");
	const spec = criticalGitSourceSpec(text, options);
	if (spec && text.includes("#") && spec.repo && spec.ref) return `git:${spec.repo}@${spec.ref}`;
	return text;
}

export function isLocalPackageSource(source: unknown): boolean {
	const trimmed = String(source ?? "").trim();
	return (
		!trimmed.startsWith("npm:") &&
		!trimmed.startsWith("git:") &&
		!trimmed.startsWith("github:") &&
		!trimmed.startsWith("http:") &&
		!trimmed.startsWith("https:") &&
		!trimmed.startsWith("ssh:")
	);
}

function resolveSupportedFilePackageSource(source: string): string {
	if (!source.startsWith("file:")) return "";
	const filePath = source.slice(5);
	if (!filePath) return "";
	if (filePath.startsWith("//")) {
		try {
			const parsed = new URL(source);
			if (parsed.protocol !== "file:" || (parsed.host && parsed.host !== "localhost")) return "";
			return fileURLToPath(parsed);
		} catch {
			return "";
		}
	}
	if (isAbsolute(filePath)) return filePath;
	return "";
}

export function packageSourcePiSource(source: unknown, options: PackageSourceOptions = {}): string {
	const text = String(source ?? "");
	const supportedFilePath = resolveSupportedFilePackageSource(text);
	if (supportedFilePath) return supportedFilePath;
	return gitSourceInstallSource(text, options);
}

export function resolveLocalPackageSource(
	source: unknown,
	{ agentDir = "", homeDir = homedir() }: PackageSourceOptions = {},
): string {
	const text = String(source ?? "");
	const supportedFilePath = resolveSupportedFilePackageSource(text);
	if (supportedFilePath) return supportedFilePath;
	if (text === "~") return homeDir;
	if (text.startsWith("~/")) return join(homeDir, text.slice(2));
	if (text.startsWith("~")) return join(homeDir, text.slice(1));
	return resolve(agentDir, text);
}

export function packageSourceInstallDir(source: unknown, options: PackageSourceOptions = {}): string {
	const spec = criticalGitSourceSpec(source, options);
	if (spec) return spec.targetDir;
	const trimmed = String(source ?? "").trim();
	if (trimmed && isLocalPackageSource(trimmed)) return resolveLocalPackageSource(trimmed, options);
	return "";
}
