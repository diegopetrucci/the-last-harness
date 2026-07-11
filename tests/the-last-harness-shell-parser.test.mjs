import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	tokenizeShellWords,
	isShellVariableAssignmentToken,
	stripLeadingShellCommandPrefixes,
	readHereDocSpec,
	readHereDocBodies,
	extractHereDocBodies,
	readProcessSubstitutionBody,
	splitShellCommandSegments,
	renderPrintfOutput,
	renderEchoOutput,
	getObviousShellSegmentOutput,
	getProcessSubstitutionOutput,
	unwrapLeadingEnvCommandTokens,
	getEnvSplitStringEffectiveTokens,
	buildEnvSplitStringEffectiveTokens,
	getWrappedShellCommand,
	normalizeShellCommandTokens,
} = await jiti.import("../extensions/the-last-harness/shell-parser.ts");

// ---------------------------------------------------------------------------
// tokenizeShellWords
// ---------------------------------------------------------------------------

test("tokenizeShellWords splits simple words on whitespace", () => {
	assert.deepEqual(tokenizeShellWords("git commit -m hello"), ["git", "commit", "-m", "hello"]);
	assert.deepEqual(tokenizeShellWords("  a  b  "), ["a", "b"]);
	assert.deepEqual(tokenizeShellWords(""), []);
});

test("tokenizeShellWords handles single-quoted strings (no escaping inside)", () => {
	assert.deepEqual(tokenizeShellWords("echo 'hello world'"), ["echo", "hello world"]);
	// Inside single quotes the backslash is literal; 'it\' ends the quoted span,
	// then bare 's' is immediately concatenated (no space), then 'fine' is a separate token.
	assert.deepEqual(tokenizeShellWords("echo 'it\\'s fine'"), ["echo", "it\\s", "fine"]);
	assert.deepEqual(tokenizeShellWords("echo 'a b' c"), ["echo", "a b", "c"]);
});

test("tokenizeShellWords handles double-quoted strings with backslash escaping", () => {
	assert.deepEqual(tokenizeShellWords('echo "hello world"'), ["echo", "hello world"]);
	// Backslash-escaped double-quote inside double quotes produces a literal quote.
	assert.deepEqual(tokenizeShellWords('echo "a\\"b"'), ["echo", 'a"b']);
	// The tokenizer absorbs any backslash inside double quotes; \n becomes n.
	assert.deepEqual(tokenizeShellWords('echo "a\\nb"'), ["echo", "anb"]);
});

test("tokenizeShellWords handles backslash escapes outside quotes", () => {
	assert.deepEqual(tokenizeShellWords("echo a\\ b"), ["echo", "a b"]);
	assert.deepEqual(tokenizeShellWords("echo a\\tb"), ["echo", "atb"]);
});

test("tokenizeShellWords treats process substitution as a single opaque token", () => {
	const tokens = tokenizeShellWords("git commit -F <(printf '%s' msg)");
	assert.deepEqual(tokens, ["git", "commit", "-F", "<(printf '%s' msg)"]);
});

test("tokenizeShellWords handles adjacent quoted and unquoted segments as one token", () => {
	assert.deepEqual(tokenizeShellWords("echo foo'bar'baz"), ["echo", "foobarbaz"]);
	assert.deepEqual(tokenizeShellWords(`echo "a"'b'"c"`), ["echo", "abc"]);
});

// ---------------------------------------------------------------------------
// isShellVariableAssignmentToken
// ---------------------------------------------------------------------------

test("isShellVariableAssignmentToken identifies valid assignment prefixes", () => {
	assert.equal(isShellVariableAssignmentToken("FOO=bar"), true);
	assert.equal(isShellVariableAssignmentToken("_VAR=1"), true);
	assert.equal(isShellVariableAssignmentToken("A="), true);
	assert.equal(isShellVariableAssignmentToken("FOO_BAR=baz"), true);
});

test("isShellVariableAssignmentToken rejects non-assignments", () => {
	assert.equal(isShellVariableAssignmentToken("git"), false);
	assert.equal(isShellVariableAssignmentToken("1FOO=bar"), false);
	assert.equal(isShellVariableAssignmentToken("=bar"), false);
	assert.equal(isShellVariableAssignmentToken(""), false);
	assert.equal(isShellVariableAssignmentToken("-FOO=bar"), false);
});

// ---------------------------------------------------------------------------
// stripLeadingShellCommandPrefixes
// ---------------------------------------------------------------------------

test("stripLeadingShellCommandPrefixes removes shell control words and assignment tokens", () => {
	assert.deepEqual(stripLeadingShellCommandPrefixes(["if", "git", "commit"]), ["git", "commit"]);
	assert.deepEqual(stripLeadingShellCommandPrefixes(["!", "command", "git", "commit"]), ["git", "commit"]);
	assert.deepEqual(stripLeadingShellCommandPrefixes(["FOO=bar", "git", "commit"]), ["git", "commit"]);
	assert.deepEqual(stripLeadingShellCommandPrefixes(["do", "FOO=bar", "git", "commit"]), ["git", "commit"]);
});

test("stripLeadingShellCommandPrefixes passes through non-prefix tokens unchanged", () => {
	assert.deepEqual(stripLeadingShellCommandPrefixes(["git", "commit"]), ["git", "commit"]);
	assert.deepEqual(stripLeadingShellCommandPrefixes([]), []);
});

// ---------------------------------------------------------------------------
// readHereDocSpec
// ---------------------------------------------------------------------------

test("readHereDocSpec parses unquoted delimiter", () => {
	const result = readHereDocSpec("<<EOF", 0);
	assert.ok(result);
	assert.equal(result.spec.delimiter, "EOF");
	assert.equal(result.spec.allowIndent, false);
});

test("readHereDocSpec parses single-quoted delimiter (no variable expansion)", () => {
	const result = readHereDocSpec("<<'EOF'", 0);
	assert.ok(result);
	assert.equal(result.spec.delimiter, "EOF");
	assert.equal(result.spec.allowIndent, false);
});

test("readHereDocSpec parses double-quoted delimiter", () => {
	const result = readHereDocSpec('<<"EOF"', 0);
	assert.ok(result);
	assert.equal(result.spec.delimiter, "EOF");
});

test("readHereDocSpec recognises <<- allow-indent form", () => {
	const result = readHereDocSpec("<<-EOF", 0);
	assert.ok(result);
	assert.equal(result.spec.delimiter, "EOF");
	assert.equal(result.spec.allowIndent, true);
});

test("readHereDocSpec returns undefined for non-heredoc inputs", () => {
	assert.equal(readHereDocSpec("<<<word", 0), undefined);
	assert.equal(readHereDocSpec(">EOF", 0), undefined);
	assert.equal(readHereDocSpec("<<", 0), undefined);
});

test("readHereDocSpec stops delimiter at whitespace and shell metacharacters", () => {
	const result = readHereDocSpec("<<EOF rest", 0);
	assert.ok(result);
	assert.equal(result.spec.delimiter, "EOF");
	// endIndex should be just past "EOF"
	assert.equal(result.endIndex, 5);
});

// ---------------------------------------------------------------------------
// readHereDocBodies
// ---------------------------------------------------------------------------

test("readHereDocBodies reads a single heredoc body", () => {
	const body = "line1\nline2\n";
	const full = `${body}EOF\n`;
	const { bodies, nextIndex } = readHereDocBodies(full, 0, [{ delimiter: "EOF", allowIndent: false }]);
	assert.deepEqual(bodies, ["line1\nline2\n"]);
	assert.equal(nextIndex, full.length);
});

test("readHereDocBodies strips leading tabs when allowIndent is true", () => {
	const full = "\t\tline\n\t\tEOF\n";
	const { bodies } = readHereDocBodies(full, 0, [{ delimiter: "EOF", allowIndent: true }]);
	assert.deepEqual(bodies, ["\t\tline\n"]);
});

test("readHereDocBodies reads multiple sequential heredoc bodies", () => {
	const full = "body1\nEND1\nbody2\nEND2\n";
	const { bodies } = readHereDocBodies(full, 0, [
		{ delimiter: "END1", allowIndent: false },
		{ delimiter: "END2", allowIndent: false },
	]);
	assert.deepEqual(bodies, ["body1\n", "body2\n"]);
});

test("readHereDocBodies handles missing closing delimiter gracefully", () => {
	const full = "no closing line here";
	const { bodies } = readHereDocBodies(full, 0, [{ delimiter: "EOF", allowIndent: false }]);
	assert.deepEqual(bodies, [full]);
});

// ---------------------------------------------------------------------------
// extractHereDocBodies
// ---------------------------------------------------------------------------

test("extractHereDocBodies extracts body from a segment containing a heredoc", () => {
	const segment = "cat <<EOF\nhello\nworld\nEOF";
	const bodies = extractHereDocBodies(segment);
	assert.deepEqual(bodies, ["hello\nworld\n"]);
});

test("extractHereDocBodies returns empty array when no heredoc present", () => {
	assert.deepEqual(extractHereDocBodies("echo hello"), []);
	assert.deepEqual(extractHereDocBodies(""), []);
});

test("extractHereDocBodies ignores heredoc markers inside quoted strings", () => {
	const segment = "echo '<<EOF'";
	assert.deepEqual(extractHereDocBodies(segment), []);
});

// ---------------------------------------------------------------------------
// readProcessSubstitutionBody
// ---------------------------------------------------------------------------

test("readProcessSubstitutionBody extracts simple body", () => {
	const command = "printf '%s' hello)rest";
	const result = readProcessSubstitutionBody(command, 0);
	assert.ok(result);
	assert.equal(result.body, "printf '%s' hello");
	assert.equal(result.endIndex, command.indexOf(")") + 1);
});

test("readProcessSubstitutionBody handles nested parentheses", () => {
	const inner = "echo (foo)";
	const command = `${inner})rest`;
	const result = readProcessSubstitutionBody(command, 0);
	assert.ok(result);
	assert.equal(result.body, inner);
});

test("readProcessSubstitutionBody returns undefined when unbalanced", () => {
	assert.equal(readProcessSubstitutionBody("printf hello", 0), undefined);
});

// ---------------------------------------------------------------------------
// splitShellCommandSegments
// ---------------------------------------------------------------------------

test("splitShellCommandSegments splits on semicolons", () => {
	const segments = splitShellCommandSegments("echo a; echo b");
	assert.equal(segments.length, 2);
	assert.equal(segments[0].segment, "echo a");
	assert.equal(segments[0].separator, ";");
	assert.equal(segments[1].segment, " echo b");
});

test("splitShellCommandSegments splits on && and ||", () => {
	const andSegments = splitShellCommandSegments("true && false");
	assert.equal(andSegments.length, 2);
	assert.equal(andSegments[0].separator, "&&");

	const orSegments = splitShellCommandSegments("true || false");
	assert.equal(orSegments.length, 2);
	assert.equal(orSegments[0].separator, "||");
});

test("splitShellCommandSegments does not split inside quoted strings", () => {
	const segments = splitShellCommandSegments("echo 'a;b'");
	assert.equal(segments.length, 1);
	assert.equal(segments[0].segment, "echo 'a;b'");
});

test("splitShellCommandSegments returns one segment for a command with no separators", () => {
	const segments = splitShellCommandSegments("git commit -m msg");
	assert.equal(segments.length, 1);
	assert.equal(segments[0].segment, "git commit -m msg");
	assert.equal(segments[0].separator, "");
});

test("splitShellCommandSegments returns one empty segment for empty input", () => {
	const segments = splitShellCommandSegments("");
	assert.equal(segments.length, 1);
	assert.equal(segments[0].segment, "");
});

// ---------------------------------------------------------------------------
// renderPrintfOutput
// ---------------------------------------------------------------------------

test("renderPrintfOutput renders %s substitution", () => {
	assert.equal(renderPrintfOutput(["%s", "hello"]), "hello");
	assert.equal(renderPrintfOutput(["%s %s", "a", "b"]), "a b");
});

test("renderPrintfOutput renders %% as literal percent", () => {
	assert.equal(renderPrintfOutput(["100%%"]), "100%");
});

test("renderPrintfOutput renders \\n escape as newline", () => {
	assert.equal(renderPrintfOutput(["%s\\n", "hello"]), "hello\n");
});

test("renderPrintfOutput returns empty string for no arguments", () => {
	assert.equal(renderPrintfOutput([]), "");
});

test("renderPrintfOutput skips leading -- argument terminator", () => {
	assert.equal(renderPrintfOutput(["--", "%s", "hello"]), "hello");
});

test("renderPrintfOutput returns undefined for unsupported format specifiers", () => {
	assert.equal(renderPrintfOutput(["%d", "42"]), undefined);
	assert.equal(renderPrintfOutput(["\\x41"]), undefined);
});

test("renderPrintfOutput repeats format cycle when there are excess args", () => {
	assert.equal(renderPrintfOutput(["%s\n", "a", "b"]), "a\nb\n");
});

// ---------------------------------------------------------------------------
// renderEchoOutput
// ---------------------------------------------------------------------------

test("renderEchoOutput joins args with spaces and appends newline", () => {
	assert.equal(renderEchoOutput(["hello", "world"]), "hello world\n");
});

test("renderEchoOutput -n suppresses trailing newline", () => {
	assert.equal(renderEchoOutput(["-n", "hello"]), "hello");
	assert.equal(renderEchoOutput(["-nn", "hello"]), "hello");
});

test("renderEchoOutput returns bare newline for no-arg call", () => {
	assert.equal(renderEchoOutput([]), "\n");
});

test("renderEchoOutput -- terminates option processing", () => {
	assert.equal(renderEchoOutput(["-n", "--", "hello"]), "hello");
	assert.equal(renderEchoOutput(["--", "hello"]), "hello\n");
});

// ---------------------------------------------------------------------------
// getObviousShellSegmentOutput
// ---------------------------------------------------------------------------

test("getObviousShellSegmentOutput renders printf segments", () => {
	assert.equal(getObviousShellSegmentOutput("printf '%s' hello"), "hello");
});

test("getObviousShellSegmentOutput renders echo segments", () => {
	assert.equal(getObviousShellSegmentOutput("echo hello"), "hello\n");
});

test("getObviousShellSegmentOutput renders cat heredoc segments", () => {
	const segment = "cat <<EOF\nhello\nEOF";
	assert.equal(getObviousShellSegmentOutput(segment), "hello\n");
});

test("getObviousShellSegmentOutput returns undefined for unknown commands", () => {
	assert.equal(getObviousShellSegmentOutput("tee /dev/null"), undefined);
});

test("getObviousShellSegmentOutput returns empty string for empty segment", () => {
	assert.equal(getObviousShellSegmentOutput(""), "");
});

// ---------------------------------------------------------------------------
// getProcessSubstitutionOutput
// ---------------------------------------------------------------------------

test("getProcessSubstitutionOutput renders a single printf command", () => {
	assert.equal(getProcessSubstitutionOutput("printf '%s' hello"), "hello");
});

test("getProcessSubstitutionOutput renders sequential segments joined by semicolons", () => {
	assert.equal(getProcessSubstitutionOutput("printf '%s' a; printf '%s' b"), "ab");
});

test("getProcessSubstitutionOutput returns undefined when any segment is non-obvious", () => {
	assert.equal(getProcessSubstitutionOutput("printf '%s' a || printf '%s' b"), undefined);
	assert.equal(getProcessSubstitutionOutput("cat file.txt"), undefined);
});

// ---------------------------------------------------------------------------
// unwrapLeadingEnvCommandTokens
// ---------------------------------------------------------------------------

test("unwrapLeadingEnvCommandTokens unwraps simple env invocations", () => {
	assert.deepEqual(unwrapLeadingEnvCommandTokens(["env", "git", "commit"]), ["git", "commit"]);
	// Variable assignments are consumed by env's leading-option parse loop.
	assert.deepEqual(unwrapLeadingEnvCommandTokens(["env", "FOO=bar", "git", "commit"]), ["git", "commit"]);
	assert.deepEqual(unwrapLeadingEnvCommandTokens(["env", "-i", "git", "commit"]), ["git", "commit"]);
});

test("unwrapLeadingEnvCommandTokens skips to after -- option terminator", () => {
	assert.deepEqual(unwrapLeadingEnvCommandTokens(["env", "--", "git", "commit"]), ["git", "commit"]);
});

test("unwrapLeadingEnvCommandTokens returns undefined for non-env first token", () => {
	assert.equal(unwrapLeadingEnvCommandTokens(["bash", "-c", "git commit"]), undefined);
	assert.equal(unwrapLeadingEnvCommandTokens(["git", "commit"]), undefined);
});

test("unwrapLeadingEnvCommandTokens returns undefined for split-string / unknown options", () => {
	assert.equal(unwrapLeadingEnvCommandTokens(["env", "-S", "git commit"]), undefined);
	assert.equal(unwrapLeadingEnvCommandTokens(["env", "-x", "git", "commit"]), undefined);
});

test("unwrapLeadingEnvCommandTokens returns empty array when a required value is missing", () => {
	assert.deepEqual(unwrapLeadingEnvCommandTokens(["env", "-C"]), []);
});

// ---------------------------------------------------------------------------
// buildEnvSplitStringEffectiveTokens / getEnvSplitStringEffectiveTokens
// ---------------------------------------------------------------------------

test("buildEnvSplitStringEffectiveTokens tokenizes payload and merges remaining tokens", () => {
	const result = buildEnvSplitStringEffectiveTokens("git commit", ["-m", "msg"]);
	assert.deepEqual(result, ["git", "commit", "-m", "msg"]);
});

test("buildEnvSplitStringEffectiveTokens strips a leading -- terminator from payload tokens", () => {
	const result = buildEnvSplitStringEffectiveTokens("-- git commit", []);
	assert.deepEqual(result, ["git", "commit"]);
});

test("getEnvSplitStringEffectiveTokens handles separated form: env -S 'payload' rest", () => {
	const tokens = ["env", "-S", "git commit", "-m", "msg"];
	const result = getEnvSplitStringEffectiveTokens(tokens, 1);
	assert.deepEqual(result, ["git", "commit", "-m", "msg"]);
});

test("getEnvSplitStringEffectiveTokens handles attached form: env -Sgit rest", () => {
	const tokens = ["env", "-Sgit", "commit", "-m", "msg"];
	const result = getEnvSplitStringEffectiveTokens(tokens, 1);
	assert.deepEqual(result, ["git", "commit", "-m", "msg"]);
});

test("getEnvSplitStringEffectiveTokens handles long attached form: env --split-string=payload rest", () => {
	const tokens = ["env", "--split-string=git commit", "-m", "msg"];
	const result = getEnvSplitStringEffectiveTokens(tokens, 1);
	assert.deepEqual(result, ["git", "commit", "-m", "msg"]);
});

// ---------------------------------------------------------------------------
// getWrappedShellCommand / getWrappedShellCommandFromTokens
// ---------------------------------------------------------------------------

test("getWrappedShellCommand extracts the -c argument from bash/sh", () => {
	assert.equal(getWrappedShellCommand("bash -c 'git commit'"), "git commit");
	assert.equal(getWrappedShellCommand("sh -c 'git commit'"), "git commit");
});

test("getWrappedShellCommand handles -lc combined flag", () => {
	assert.equal(getWrappedShellCommand("bash -lc 'git commit'"), "git commit");
});

test("getWrappedShellCommand handles -- terminator before command string", () => {
	assert.equal(getWrappedShellCommand("bash -c -- 'git commit'"), "git commit");
});

test("getWrappedShellCommand handles -o/-O options with values before -c", () => {
	assert.equal(getWrappedShellCommand("bash -o pipefail -lc 'git commit'"), "git commit");
	assert.equal(getWrappedShellCommand("bash -O extglob -lc 'git commit'"), "git commit");
});

test("getWrappedShellCommand handles +o/+e/+x option forms", () => {
	assert.equal(getWrappedShellCommand("bash +o pipefail -lc 'git commit'"), "git commit");
	assert.equal(getWrappedShellCommand("bash +e -lc 'git commit'"), "git commit");
});

test("getWrappedShellCommand returns undefined for non-shell or missing -c", () => {
	assert.equal(getWrappedShellCommand("git commit"), undefined);
	assert.equal(getWrappedShellCommand("bash -l"), undefined);
	// env is transparently unwrapped before shell detection, so env bash -c ... IS resolved.
	assert.equal(getWrappedShellCommand("env bash -c 'git commit'"), "git commit");
});

// ---------------------------------------------------------------------------
// normalizeShellCommandTokens (env + shell unwrapping combined)
// ---------------------------------------------------------------------------

test("normalizeShellCommandTokens passes through plain commands unchanged", () => {
	assert.deepEqual(normalizeShellCommandTokens("git commit -m msg"), ["git", "commit", "-m", "msg"]);
});

test("normalizeShellCommandTokens strips leading shell control-word prefix", () => {
	// tokenizeShellWords does not split on semicolons; stripLeadingShellCommandPrefixes
	// only removes the leading 'if' keyword, leaving the rest of the token list intact.
	assert.deepEqual(
		normalizeShellCommandTokens("if git commit -m msg; then :; fi"),
		["git", "commit", "-m", "msg;", "then", ":;", "fi"],
	);
});

test("normalizeShellCommandTokens strips variable-assignment prefixes", () => {
	assert.deepEqual(normalizeShellCommandTokens("FOO=bar git commit"), ["git", "commit"]);
});

test("normalizeShellCommandTokens unwraps env and strips variable assignments from remainder", () => {
	assert.deepEqual(normalizeShellCommandTokens("env FOO=bar git commit"), ["git", "commit"]);
	assert.deepEqual(normalizeShellCommandTokens("/usr/bin/env FOO=bar git commit"), ["git", "commit"]);
});
