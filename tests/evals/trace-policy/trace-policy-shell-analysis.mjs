import { posix as pathPosix } from "node:path";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toolName(step) {
  if (!isRecord(step) || step.type !== "tool") {
    return undefined;
  }
  return normalizeText(step.tool || step.name);
}

function commandText(step) {
  if (!isRecord(step) || step.type !== "tool") {
    return "";
  }
  if (Array.isArray(step.argv)) {
    return step.argv.map((part) => String(part)).join(" ");
  }
  return typeof step.command === "string" ? step.command : "";
}

const MUTATING_SHELL_COMMANDS = new Set([
  "chmod",
  "chown",
  "cp",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "touch",
  "truncate",
]);
const MUTATING_GIT_SUBCOMMANDS = new Set([
  "add",
  "apply",
  "checkout",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
]);
const TK_MUTATING_SUBCOMMANDS = new Set([
  "assign",
  "close",
  "create",
  "delete",
  "dep",
  "edit",
  "open",
  "reopen",
  "update",
]);
const MUTATING_PACKAGE_SUBCOMMANDS = new Map([
  ["apt", new Set(["install", "purge", "remove"])],
  ["apt-get", new Set(["install", "purge", "remove"])],
  ["brew", new Set(["install", "reinstall", "remove", "uninstall", "upgrade"])],
  ["bun", new Set(["add", "install", "remove", "rm", "uninstall", "update"])],
  ["cargo", new Set(["install", "uninstall"])],
  ["dnf", new Set(["install", "remove"])],
  ["npm", new Set(["add", "ci", "i", "install", "remove", "rm", "uninstall", "up", "update"])],
  ["pacman", new Set(["-r", "-s", "-u"])],
  ["pip", new Set(["install", "uninstall"])],
  ["pip3", new Set(["install", "uninstall"])],
  ["pnpm", new Set(["add", "i", "install", "remove", "rm", "uninstall", "update"])],
  ["uv", new Set(["add", "remove", "sync"])],
  ["yarn", new Set(["add", "install", "remove", "up", "upgrade"])],
  ["yum", new Set(["install", "remove"])],
]);
const SHELL_COMMAND_PREFIXES = new Set([
  "builtin",
  "command",
  "env",
  "exec",
  "noglob",
  "sudo",
  "time",
]);
const SHELL_CONTROL_COMMAND_PREFIXES = new Set([
  "!",
  "do",
  "elif",
  "else",
  "if",
  "then",
  "until",
  "while",
]);
const ENV_SHORT_OPTIONS_WITH_VALUES = new Set(["C", "P", "S", "u"]);
const SHELL_PREFIX_OPTIONS_WITH_VALUES = new Map([
  ["builtin", new Set()],
  ["command", new Set()],
  ["env", new Set(["-C", "-P", "-S", "-u", "--chdir", "--path", "--split-string", "--unset"])],
  ["exec", new Set(["-a"])],
  ["noglob", new Set()],
  [
    "sudo",
    new Set([
      "-C",
      "-D",
      "-g",
      "-h",
      "-p",
      "-R",
      "-T",
      "-U",
      "-u",
      "--chdir",
      "--close-from",
      "--group",
      "--host",
      "--other-user",
      "--prompt",
      "--user",
    ]),
  ],
  ["time", new Set()],
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const GIT_CONFIG_MUTATING_OPTIONS = new Set([
  "--add",
  "--edit",
  "--remove-section",
  "--rename-section",
  "--replace-all",
  "--unset",
  "--unset-all",
]);
const GIT_CONFIG_READ_OPTIONS = new Set([
  "--get",
  "--get-all",
  "--get-color",
  "--get-colorbool",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
]);
const GIT_CONFIG_MODERN_MUTATING_ACTIONS = new Set([
  "edit",
  "remove-section",
  "rename-section",
  "set",
  "unset",
]);
const GIT_CONFIG_MODERN_READ_ACTIONS = new Set(["get", "list"]);
const GIT_CONFIG_OPTIONS_WITH_VALUES = new Set([
  "--blob",
  "--default",
  "--file",
  "--type",
  "--url",
  "--value",
  "-f",
]);
const GIT_CONFIG_SHORT_OPTIONS_WITH_VALUES = new Set(["f", "t"]);
const PACKAGE_GLOBAL_OPTIONS_WITH_VALUES = new Map([
  ["apt", new Set()],
  ["apt-get", new Set()],
  ["brew", new Set(["--cache", "--env", "--prefix", "--repository"])],
  ["bun", new Set(["--cwd"])],
  ["cargo", new Set(["--config"])],
  ["dnf", new Set(["--config"])],
  ["npm", new Set(["-C", "--cache", "--prefix", "--userconfig"])],
  ["pacman", new Set(["--config", "--root"])],
  ["pip", new Set(["--cache-dir", "--config-file"])],
  ["pip3", new Set(["--cache-dir", "--config-file"])],
  ["pnpm", new Set(["-C", "--dir", "--prefix", "--store-dir"])],
  ["uv", new Set(["--cache-dir", "--config-file", "--directory", "--project"])],
  ["yarn", new Set(["--cache-folder", "--cwd"])],
  ["yum", new Set(["--config"])],
]);

function isShellBackgroundOperator(command, index) {
  return command[index - 1] !== ">" && command[index + 1] !== ">";
}

function shellCommandSegments(command) {
  const segments = [];
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let segmentStart = 0;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && !singleQuoted) {
      escaped = true;
      continue;
    }
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (char === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (singleQuoted || doubleQuoted) {
      continue;
    }
    if ((char === "&" || char === "|") && command[index + 1] === char) {
      segments.push(command.slice(segmentStart, index));
      segmentStart = index + 2;
      index += 1;
      continue;
    }
    if (char === "&") {
      if (isShellBackgroundOperator(command, index)) {
        segments.push(command.slice(segmentStart, index));
        segmentStart = index + 1;
      }
      continue;
    }
    if (char === ";" || char === "\n" || char === "|") {
      segments.push(command.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }

  segments.push(command.slice(segmentStart));
  return segments;
}

function shellWords(segment) {
  return shellWordsWithQuoteMetadata(segment).map(({ value }) => value);
}

function shellWordsWithQuoteMetadata(segment) {
  const words = [];
  let current = "";
  let currentQuoted = [];
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let quoted = false;

  const pushWord = () => {
    if (!current) {
      quoted = false;
      currentQuoted = [];
      return;
    }
    const redirection = current.match(SHELL_REDIRECTION_TOKEN_PATTERN);
    const operatorLength = redirection ? redirection[0].length - redirection[2].length : 0;
    const operatorStart = redirection ? operatorLength - redirection[1].length : 0;
    words.push({
      value: current,
      quoted,
      operatorQuoted: currentQuoted.slice(operatorStart, operatorLength).some(Boolean),
    });
    current = "";
    currentQuoted = [];
    quoted = false;
  };

  for (const char of segment) {
    if (escaped) {
      current += char;
      currentQuoted.push(true);
      escaped = false;
      quoted = true;
      continue;
    }
    if (char === "\\" && !singleQuoted) {
      escaped = true;
      quoted = true;
      continue;
    }
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      quoted = true;
      continue;
    }
    if (char === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      quoted = true;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && /\s/.test(char)) {
      pushWord();
      continue;
    }
    current += char;
    currentQuoted.push(singleQuoted || doubleQuoted);
  }

  pushWord();
  return words;
}

function isShellEnvironmentAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function parseEnvShortOptionToken(token) {
  if (
    typeof token !== "string" ||
    !token.startsWith("-") ||
    token.startsWith("--") ||
    token === "-"
  ) {
    return undefined;
  }

  for (let index = 1; index < token.length; index += 1) {
    const option = token[index];
    if (!ENV_SHORT_OPTIONS_WITH_VALUES.has(option)) {
      continue;
    }
    return {
      option: `-${option}`,
      value: index + 1 < token.length ? token.slice(index + 1) : undefined,
      consumesNextToken: index + 1 >= token.length,
    };
  }

  return undefined;
}

function shellPrefixOptionName(prefix, token) {
  if (prefix === "env") {
    const envShortOption = parseEnvShortOptionToken(token);
    if (envShortOption) {
      return envShortOption.option;
    }
  }
  return token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
}

function shellPrefixConsumesNextToken(prefix, token, optionsWithValues) {
  if (!token) {
    return false;
  }
  if (prefix === "env") {
    const envShortOption = parseEnvShortOptionToken(token);
    if (envShortOption) {
      return envShortOption.consumesNextToken;
    }
  }
  return optionsWithValues.has(shellPrefixOptionName(prefix, token)) && !token.includes("=");
}

function envSplitStringValue(token, nextToken) {
  if (!token) {
    return undefined;
  }
  const envShortOption = parseEnvShortOptionToken(token);
  if (envShortOption?.option === "-S") {
    return envShortOption.value ?? nextToken;
  }
  if (token === "--split-string") {
    return nextToken;
  }
  if (!token.includes("=")) {
    return undefined;
  }
  const optionName = token.slice(0, token.indexOf("="));
  return optionName === "-S" || optionName === "--split-string"
    ? token.slice(token.indexOf("=") + 1)
    : undefined;
}

function envSplitStringValues(words, startIndex) {
  const splitStringValues = [];
  const optionsWithValues = SHELL_PREFIX_OPTIONS_WITH_VALUES.get("env") || new Set();
  let index = startIndex + 1;
  let remainderStart = words.length;

  while (index < words.length) {
    const token = words[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === "--") {
      remainderStart = index + 1;
      break;
    }
    if (isShellEnvironmentAssignment(token)) {
      index += 1;
      continue;
    }
    const splitStringValue = envSplitStringValue(token, words[index + 1]);
    if (splitStringValue !== undefined) {
      splitStringValues.push(splitStringValue);
    }
    if (!token.startsWith("-")) {
      remainderStart = index;
      break;
    }
    index += shellPrefixConsumesNextToken("env", token, optionsWithValues) ? 2 : 1;
  }

  if (splitStringValues.length === 0) {
    return [];
  }
  const effectiveCommand = [...splitStringValues, ...words.slice(remainderStart).filter(Boolean)]
    .join(" ")
    .trim();
  return effectiveCommand ? [effectiveCommand] : [];
}

function skipShellCommandPrefix(words, startIndex) {
  const prefix = words[startIndex];
  const optionsWithValues = SHELL_PREFIX_OPTIONS_WITH_VALUES.get(prefix) || new Set();
  let index = startIndex + 1;

  while (index < words.length) {
    const token = words[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === "--") {
      return index + 1;
    }
    if (prefix === "env" && isShellEnvironmentAssignment(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      return index;
    }
    index += shellPrefixConsumesNextToken(prefix, token, optionsWithValues) ? 2 : 1;
  }

  return index;
}

function readShellCommandSubstitution(command, startIndex) {
  const frames = [{ escaped: false, parenDepth: 0, quoteMode: null }];
  let current = "";

  for (let index = startIndex; index < command.length; index += 1) {
    const frame = frames[frames.length - 1];
    const char = command[index];
    if (frame.escaped) {
      current += char;
      frame.escaped = false;
      continue;
    }
    if (char === "\\" && frame.quoteMode !== "single") {
      current += char;
      frame.escaped = true;
      continue;
    }
    if (char === "'" && frame.quoteMode !== "double") {
      current += char;
      frame.quoteMode = frame.quoteMode === "single" ? null : "single";
      continue;
    }
    if (char === '"' && frame.quoteMode !== "single") {
      current += char;
      frame.quoteMode = frame.quoteMode === "double" ? null : "double";
      continue;
    }
    if (
      frame.quoteMode !== "single" &&
      char === "$" &&
      command[index + 1] === "(" &&
      command[index + 2] !== "("
    ) {
      current += "$(";
      frames.push({ escaped: false, parenDepth: 0, quoteMode: null });
      index += 1;
      continue;
    }
    if (frame.quoteMode === null && char === "(") {
      current += char;
      frame.parenDepth += 1;
      continue;
    }
    if (frame.quoteMode === null && char === ")") {
      if (frame.parenDepth > 0) {
        current += char;
        frame.parenDepth -= 1;
        continue;
      }
      frames.pop();
      if (frames.length === 0) {
        return { command: current, endIndex: index };
      }
      current += char;
      continue;
    }
    current += char;
  }

  return undefined;
}

function readLegacyShellCommandSubstitution(command, startIndex) {
  let current = "";
  let escaped = false;

  for (let index = startIndex; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && command[index + 1] === "`") {
      current += "`";
      index += 1;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "`") {
      return { command: current, endIndex: index };
    }
    current += char;
  }

  return undefined;
}

function shellCommandSubstitutions(command) {
  const substitutions = [];
  let escaped = false;
  let quoteMode = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoteMode !== "single") {
      escaped = true;
      continue;
    }
    if (char === "'" && quoteMode !== "double") {
      quoteMode = quoteMode === "single" ? null : "single";
      continue;
    }
    if (char === '"' && quoteMode !== "single") {
      quoteMode = quoteMode === "double" ? null : "double";
      continue;
    }
    if (quoteMode === "single") {
      continue;
    }
    if (char === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
      const substitution = readShellCommandSubstitution(command, index + 2);
      if (!substitution) {
        continue;
      }
      substitutions.push(substitution.command);
      index = substitution.endIndex;
      continue;
    }
    if (char === "`") {
      const substitution = readLegacyShellCommandSubstitution(command, index + 1);
      if (!substitution) {
        continue;
      }
      substitutions.push(substitution.command);
      index = substitution.endIndex;
    }
  }

  return substitutions;
}

function shellSegmentEnvSplitStringCommands(segment) {
  const commands = [];
  const words = shellWords(segment);

  for (let index = 0; index < words.length; index += 1) {
    const token = words[index];
    if (!token) {
      continue;
    }
    if (isShellEnvironmentAssignment(token)) {
      continue;
    }
    if (SHELL_COMMAND_PREFIXES.has(token)) {
      if (token === "env") {
        commands.push(...envSplitStringValues(words, index));
      }
      index = skipShellCommandPrefix(words, index) - 1;
      continue;
    }
    if (SHELL_CONTROL_COMMAND_PREFIXES.has(token)) {
      continue;
    }
    if (token === "--" || token.startsWith("-")) {
      continue;
    }
    return commands;
  }

  return commands;
}

function shellEnvSplitStringCommands(command) {
  const commands = [];
  for (const segment of shellCommandSegments(command)) {
    commands.push(...shellSegmentEnvSplitStringCommands(segment));
  }
  return commands;
}

function shellCommandTexts(command) {
  const pending = [command];
  const texts = [];
  const seen = new Set();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    texts.push(current);
    pending.push(...shellCommandSubstitutions(current));
    pending.push(...shellEnvSplitStringCommands(current));
  }

  return texts;
}

function shellLeafCommandSegments(command) {
  const pending = [command];
  const segments = [];
  const seen = new Set();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    pending.push(...shellCommandSubstitutions(current));

    for (const segment of shellCommandSegments(current)) {
      const splitStringCommands = shellSegmentEnvSplitStringCommands(segment);
      if (splitStringCommands.length > 0) {
        pending.push(...splitStringCommands);
        continue;
      }
      const normalized = normalizeText(segment);
      if (normalized) {
        segments.push(normalized);
      }
    }
  }

  return segments;
}

function firstShellCommand(words) {
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index];
    if (!token) {
      continue;
    }
    if (isShellEnvironmentAssignment(token)) {
      continue;
    }
    if (SHELL_COMMAND_PREFIXES.has(token)) {
      index = skipShellCommandPrefix(words, index) - 1;
      continue;
    }
    if (SHELL_CONTROL_COMMAND_PREFIXES.has(token)) {
      continue;
    }
    if (token === "--" || token.startsWith("-")) {
      continue;
    }
    return { index, word: token };
  }
  return undefined;
}

function shellCommandInvocation(words) {
  const shellCommand = firstShellCommand(words);
  if (!shellCommand) {
    return undefined;
  }
  return {
    commandWord: normalizeText(shellCommand.word).toLowerCase(),
    args: words.slice(shellCommand.index + 1),
  };
}

function shellCommandInvocations(command) {
  const invocations = [];
  for (const segment of shellLeafCommandSegments(command)) {
    const invocation = shellCommandInvocation(shellWords(segment));
    if (invocation) {
      invocations.push(invocation);
    }
  }
  return invocations;
}

function toolCommandInvocations(step) {
  if (toolName(step) !== "bash") {
    return [];
  }
  if (Array.isArray(step.argv)) {
    const invocation = shellCommandInvocation(step.argv.map((part) => String(part)));
    return invocation ? [invocation] : [];
  }
  const command = commandText(step);
  return command ? shellCommandInvocations(command) : [];
}

function firstPositionalArgument(args, optionsWithValues = new Set()) {
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return undefined;
    }
    if (optionsWithValues.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }

  return undefined;
}

function hasSedInPlaceFlag(args) {
  return args.some(
    (arg) =>
      arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="),
  );
}

const SHELL_REDIRECTION_TOKEN_PATTERN = /^(?:\d+)?(&>>|&>|>>|>\||>|<<<|<<-|<<|<>|>&|<&|<)(.*)$/;

function shellWordsWithoutRedirections(args, wordMetadata = []) {
  const words = [];
  let skipNext = false;

  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const redirection = wordMetadata[index]?.operatorQuoted
      ? undefined
      : normalizeText(arg).match(SHELL_REDIRECTION_TOKEN_PATTERN);
    if (redirection) {
      if (!redirection[2]) {
        skipNext = true;
      }
      continue;
    }
    words.push({
      value: arg,
      quoted: wordMetadata[index]?.quoted === true,
      operatorQuoted: wordMetadata[index]?.operatorQuoted === true,
    });
  }

  return words;
}

function shellArgumentsWithoutRedirections(args, wordMetadata = []) {
  return shellWordsWithoutRedirections(args, wordMetadata).map(({ value }) => value);
}

function isMutatingGitConfig(args, wordMetadata = []) {
  const configArguments = shellArgumentsWithoutRedirections(args, wordMetadata);
  const positionalArguments = [];
  let hasMutatingOption = false;
  let hasReadOption = false;
  let skipNext = false;
  let optionsEnded = false;

  for (let index = 0; index < configArguments.length; index += 1) {
    const arg = configArguments[index];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg) {
      continue;
    }
    if (optionsEnded) {
      positionalArguments.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const optionName = arg.split("=", 1)[0];
      if (GIT_CONFIG_MUTATING_OPTIONS.has(optionName)) {
        hasMutatingOption = true;
      }
      if (GIT_CONFIG_READ_OPTIONS.has(optionName)) {
        hasReadOption = true;
      }
      if (GIT_CONFIG_OPTIONS_WITH_VALUES.has(optionName) && !arg.includes("=")) {
        skipNext = true;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      for (let optionIndex = 1; optionIndex < arg.length; optionIndex += 1) {
        const option = arg[optionIndex];
        if (option === "e") {
          hasMutatingOption = true;
        }
        if (option === "l") {
          hasReadOption = true;
        }
        if (GIT_CONFIG_SHORT_OPTIONS_WITH_VALUES.has(option)) {
          if (optionIndex === arg.length - 1) {
            skipNext = true;
          }
          break;
        }
      }
      continue;
    }
    positionalArguments.push(arg);
  }

  if (hasMutatingOption) {
    return true;
  }
  if (hasReadOption) {
    return false;
  }

  const action = normalizeText(positionalArguments[0]).toLowerCase();
  if (GIT_CONFIG_MODERN_MUTATING_ACTIONS.has(action)) {
    return true;
  }
  if (GIT_CONFIG_MODERN_READ_ACTIONS.has(action)) {
    return false;
  }

  // Before the modern `set`/`unset` actions, a second positional argument
  // was the value in `git config <name> <value>` and therefore wrote config.
  // Unknown option forms remain outside this bounded classifier.
  return positionalArguments.length >= 2;
}

function isMutatingGitCommand(args, wordMetadata = []) {
  const {
    subcommand,
    subcommandArgs = [],
    subcommandMetadata = [],
  } = gitSubcommandAndArgs(args, wordMetadata);
  if (subcommand === "config") {
    return isMutatingGitConfig(subcommandArgs, subcommandMetadata);
  }
  return Boolean(subcommand) && MUTATING_GIT_SUBCOMMANDS.has(subcommand);
}

function isMutatingPackageCommand(commandWord, args) {
  const mutatingSubcommands = MUTATING_PACKAGE_SUBCOMMANDS.get(commandWord);
  if (!mutatingSubcommands) {
    return false;
  }
  const subcommand = firstPositionalArgument(
    args,
    PACKAGE_GLOBAL_OPTIONS_WITH_VALUES.get(commandWord),
  );
  return Boolean(subcommand) && mutatingSubcommands.has(subcommand);
}

function hasTeeFileTarget(args, wordMetadata = []) {
  let optionsEnded = false;

  for (const arg of shellArgumentsWithoutRedirections(args, wordMetadata)) {
    if (!arg) {
      continue;
    }
    if (optionsEnded) {
      if (!isSafeShellSink(arg)) {
        return true;
      }
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      continue;
    }
    if (!isSafeShellSink(arg)) {
      return true;
    }
  }

  return false;
}

function isMutatingShellInvocation(commandWord, args, wordMetadata = []) {
  return (
    MUTATING_SHELL_COMMANDS.has(commandWord) ||
    (commandWord === "sed" && hasSedInPlaceFlag(args)) ||
    (commandWord === "git" && isMutatingGitCommand(args, wordMetadata)) ||
    (commandWord === "tee" && hasTeeFileTarget(args, wordMetadata)) ||
    isMutatingPackageCommand(commandWord, args)
  );
}

function firstPositionalArgumentIndex(args, optionsWithValues = new Set()) {
  let skipNext = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return -1;
    }
    if (optionsWithValues.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return index;
  }

  return -1;
}

function gitSubcommandAndArgs(args, wordMetadata) {
  const words = Array.isArray(wordMetadata)
    ? shellWordsWithoutRedirections(args, wordMetadata)
    : args.map((value) => ({ value, quoted: false }));
  const commandArgs = words.map(({ value }) => value);
  const subcommandIndex = firstPositionalArgumentIndex(commandArgs, GIT_GLOBAL_OPTIONS_WITH_VALUES);
  if (subcommandIndex < 0) {
    return {};
  }
  return {
    subcommand: normalizeText(commandArgs[subcommandIndex]).toLowerCase(),
    subcommandArgs: commandArgs.slice(subcommandIndex + 1),
    subcommandMetadata: words.slice(subcommandIndex + 1),
  };
}

function gitShortOptionConsumesNextToken(arg, shortOptionsWithValues = new Set()) {
  if (!arg?.startsWith("-") || arg.startsWith("--") || arg === "-") {
    return false;
  }

  for (let index = 1; index < arg.length; index += 1) {
    if (!shortOptionsWithValues.has(arg[index])) {
      continue;
    }
    return index + 1 >= arg.length;
  }

  return false;
}

function gitArgsContainLongFlag(
  args,
  flagName,
  shortOptionsWithValues = new Set(),
  longOptionsWithValues = new Set(),
) {
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg) {
      continue;
    }
    if (arg === flagName || arg.startsWith(`${flagName}=`)) {
      return true;
    }
    if (
      longOptionsWithValues.has(arg) ||
      gitShortOptionConsumesNextToken(arg, shortOptionsWithValues)
    ) {
      skipNext = true;
    }
  }

  return false;
}

function gitArgsContainShortFlag(
  args,
  shortFlag,
  shortOptionsWithValues = new Set(),
  longOptionsWithValues = new Set(),
) {
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg) {
      continue;
    }
    if (longOptionsWithValues.has(arg)) {
      skipNext = true;
      continue;
    }
    if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") {
      continue;
    }

    for (let index = 1; index < arg.length; index += 1) {
      const option = arg[index];
      if (option === shortFlag) {
        return true;
      }
      if (shortOptionsWithValues.has(option)) {
        break;
      }
    }

    skipNext = gitShortOptionConsumesNextToken(arg, shortOptionsWithValues);
  }
  return false;
}

function gitArgsContainFlag(
  args,
  shortFlag,
  longFlag,
  shortOptionsWithValues = new Set(),
  longOptionsWithValues = new Set(),
) {
  return (
    gitArgsContainShortFlag(args, shortFlag, shortOptionsWithValues, longOptionsWithValues) ||
    gitArgsContainLongFlag(args, longFlag, shortOptionsWithValues, longOptionsWithValues)
  );
}

function firstGitPositionalArgument(
  args,
  shortOptionsWithValues = new Set(),
  longOptionsWithValues = new Set(),
) {
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return undefined;
    }
    if (longOptionsWithValues.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    if (arg.startsWith("-")) {
      skipNext = gitShortOptionConsumesNextToken(arg, shortOptionsWithValues);
      continue;
    }
    return arg;
  }

  return undefined;
}

function gitCheckoutHasPathspec(args) {
  const separatorIndex = args.indexOf("--");
  return (
    separatorIndex >= 0 && args.slice(separatorIndex + 1).some((arg) => normalizeText(arg) !== "")
  );
}

function gitCheckoutPositionalArguments(
  args,
  shortOptionsWithValues = new Set(),
  longOptionsWithValues = new Set(),
) {
  const positionalArgs = [];
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (longOptionsWithValues.has(arg)) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    if (arg.startsWith("-")) {
      skipNext = gitShortOptionConsumesNextToken(arg, shortOptionsWithValues);
      continue;
    }
    positionalArgs.push(arg);
  }

  return positionalArgs;
}

function gitCheckoutHasDestructivePathMode(args) {
  const branchOptionsWithValues = new Set(["b", "B"]);
  const positionals = gitCheckoutPositionalArguments(args, branchOptionsWithValues);
  // '.' and '..' are unambiguous path operands — they cannot be branch names.
  // Classify a checkout destructive when any positional is exactly '.' or '..'.
  // Generic single bare operands (e.g. 'main', 'my-branch') remain ambiguous
  // and are NOT classified destructive; only the >= 2-positional rule covers them.
  const hasDotPath = positionals.some((p) => p === "." || p === "..");
  return (
    gitCheckoutHasPathspec(args) ||
    hasDotPath ||
    positionals.length >= 2 ||
    gitArgsContainFlag(args, "p", "--patch", branchOptionsWithValues) ||
    ["--ours", "--theirs", "--pathspec-from-file"].some((flag) =>
      gitArgsContainLongFlag(args, flag, branchOptionsWithValues),
    )
  );
}

function isGitExecutableForExistingChangesBoundary(commandWord) {
  return pathPosix.basename(commandWord.replaceAll("\\", "/")) === "git";
}

function isRiskyExistingChangesGitInvocation(commandWord, args) {
  if (!isGitExecutableForExistingChangesBoundary(commandWord)) {
    return false;
  }

  const { subcommand, subcommandArgs = [] } = gitSubcommandAndArgs(args);
  if (!subcommand) {
    return false;
  }

  switch (subcommand) {
    case "stash": {
      const stashSubcommand = firstGitPositionalArgument(
        subcommandArgs,
        new Set(["m"]),
        new Set(["--message", "--pathspec-from-file"]),
      )?.toLowerCase();
      return !["list", "show"].includes(stashSubcommand || "push");
    }
    case "restore":
    case "reset":
      return true;
    case "clean":
      return !gitArgsContainFlag(
        subcommandArgs,
        "n",
        "--dry-run",
        new Set(["e"]),
        new Set(["--exclude"]),
      );
    case "checkout":
      return (
        gitArgsContainFlag(subcommandArgs, "f", "--force", new Set(["b", "B"])) ||
        gitCheckoutHasDestructivePathMode(subcommandArgs)
      );
    case "switch":
      return (
        gitArgsContainFlag(subcommandArgs, "f", "--force", new Set(["c", "C"])) ||
        gitArgsContainLongFlag(subcommandArgs, "--discard-changes")
      );
    default:
      return false;
  }
}

function hasRiskyExistingChangesGitCommand(step) {
  return toolCommandInvocations(step).some(({ commandWord, args }) =>
    isRiskyExistingChangesGitInvocation(commandWord, args),
  );
}

function hasMutatingShellWords(words, wordMetadata = []) {
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index];
    if (!token) {
      continue;
    }
    const redirection = wordMetadata[index]?.operatorQuoted
      ? undefined
      : normalizeText(token).match(SHELL_REDIRECTION_TOKEN_PATTERN);
    if (redirection) {
      if (!redirection[2]) {
        index += 1;
      }
      continue;
    }
    if (isShellEnvironmentAssignment(token)) {
      continue;
    }
    if (SHELL_COMMAND_PREFIXES.has(token)) {
      index = skipShellCommandPrefix(words, index) - 1;
      continue;
    }
    if (SHELL_CONTROL_COMMAND_PREFIXES.has(token)) {
      continue;
    }
    if (token === "--" || token.startsWith("-")) {
      continue;
    }
    return isMutatingShellInvocation(token, words.slice(index + 1), wordMetadata.slice(index + 1));
  }
  return false;
}

function hasMutatingShellCommand(command) {
  for (const candidate of shellCommandTexts(command)) {
    for (const segment of shellCommandSegments(candidate)) {
      const wordMetadata = shellWordsWithQuoteMetadata(segment);
      if (
        hasMutatingShellWords(
          wordMetadata.map(({ value }) => value),
          wordMetadata,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasMutatingArgvPrefix(words) {
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index];
    if (!token || isShellEnvironmentAssignment(token)) {
      continue;
    }
    if (!SHELL_COMMAND_PREFIXES.has(token)) {
      return false;
    }

    if (
      token === "env" &&
      envSplitStringValues(words, index).some((command) =>
        hasMutatingShellArgv(shellWords(command)),
      )
    ) {
      return true;
    }

    const nestedIndex = skipShellCommandPrefix(words, index);
    return nestedIndex < words.length && hasMutatingShellArgv(words.slice(nestedIndex));
  }
  return false;
}

function hasMutatingShellArgv(argv) {
  const words = argv.map((part) => String(part));
  const wordMetadata = words.map((value) => ({ value, quoted: true, operatorQuoted: true }));
  return (
    isTkMutatingArgv(words) ||
    hasMutatingShellWords(words, wordMetadata) ||
    hasMutatingArgvPrefix(words)
  );
}

function isSafeShellSink(target) {
  return (
    ["/dev/null", "/dev/stderr", "/dev/stdout"].includes(target) || /^\/dev\/fd\/\d+$/.test(target)
  );
}

function extractShellRedirectionTarget(command) {
  for (const candidate of shellCommandTexts(command)) {
    let singleQuoted = false;
    let doubleQuoted = false;
    let escaped = false;
    let doubleBracketDepth = 0;
    let doubleParenDepth = 0;

    for (let index = 0; index < candidate.length; index += 1) {
      const char = candidate[index];
      const nextChar = candidate[index + 1];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\" && !singleQuoted) {
        escaped = true;
        continue;
      }
      if (char === "'" && !doubleQuoted) {
        singleQuoted = !singleQuoted;
        continue;
      }
      if (char === '"' && !singleQuoted) {
        doubleQuoted = !doubleQuoted;
        continue;
      }
      if (singleQuoted || doubleQuoted) {
        continue;
      }
      if (doubleBracketDepth > 0) {
        if (char === "[" && nextChar === "[") {
          doubleBracketDepth += 1;
          index += 1;
          continue;
        }
        if (char === "]" && nextChar === "]") {
          doubleBracketDepth -= 1;
          index += 1;
        }
        continue;
      }
      if (doubleParenDepth > 0) {
        if (char === "(" && nextChar === "(") {
          doubleParenDepth += 1;
          index += 1;
          continue;
        }
        if (char === ")" && nextChar === ")") {
          doubleParenDepth -= 1;
          index += 1;
        }
        continue;
      }
      if (char === "[" && nextChar === "[") {
        doubleBracketDepth += 1;
        index += 1;
        continue;
      }
      if (char === "(" && nextChar === "(") {
        doubleParenDepth += 1;
        index += 1;
        continue;
      }
      if (char !== ">") {
        continue;
      }

      let cursor = index + 1;
      while (candidate[cursor] === ">") {
        cursor += 1;
      }
      while (/\s/.test(candidate[cursor] || "")) {
        cursor += 1;
      }
      if (!candidate[cursor] || candidate[cursor] === "&") {
        continue;
      }

      const target = (() => {
        if (candidate[cursor] === "'" || candidate[cursor] === '"') {
          const quote = candidate[cursor];
          cursor += 1;
          const start = cursor;
          while (cursor < candidate.length && candidate[cursor] !== quote) {
            cursor += 1;
          }
          return candidate.slice(start, cursor);
        }
        const start = cursor;
        while (cursor < candidate.length && !/[\s;&|]/.test(candidate[cursor])) {
          cursor += 1;
        }
        return candidate.slice(start, cursor);
      })();

      const normalizedTarget = normalizeText(target);
      if (!normalizedTarget || isSafeShellSink(normalizedTarget)) {
        continue;
      }
      return normalizedTarget;
    }
  }

  return undefined;
}

function extractSedInPlaceTarget(command) {
  for (const candidate of shellCommandTexts(command)) {
    for (const segment of shellCommandSegments(candidate)) {
      const words = shellWords(segment);
      const shellCommand = firstShellCommand(words);
      if (!shellCommand || shellCommand.word !== "sed") {
        continue;
      }
      const args = words.slice(shellCommand.index + 1);
      if (!hasSedInPlaceFlag(args)) {
        continue;
      }
      for (let index = args.length - 1; index >= 0; index -= 1) {
        const candidatePath = normalizeText(args[index]);
        if (candidatePath && !candidatePath.startsWith("-")) {
          return candidatePath;
        }
      }
    }
  }
  return undefined;
}

function extractSedInPlaceArgvTarget(argv) {
  const words = argv.map((part) => String(part));
  if (words[0] !== "sed" || !hasSedInPlaceFlag(words.slice(1))) {
    return undefined;
  }
  for (let index = words.length - 1; index >= 1; index -= 1) {
    const candidatePath = normalizeText(words[index]);
    if (candidatePath && !candidatePath.startsWith("-")) {
      return candidatePath;
    }
  }
  return undefined;
}

function bashMutationPath(step) {
  if (toolName(step) !== "bash") {
    return undefined;
  }
  if (Array.isArray(step.argv)) {
    return extractSedInPlaceArgvTarget(step.argv);
  }
  const command = commandText(step);
  return extractShellRedirectionTarget(command) || extractSedInPlaceTarget(command);
}

function tkWordsForShellSegment(segment) {
  const words = shellWords(segment);
  const shellCommand = firstShellCommand(words);
  if (!shellCommand || shellCommand.word.toLowerCase() !== "tk") {
    return undefined;
  }
  return { words, shellCommandIndex: shellCommand.index };
}

function tkSubcommandForShellSegment(segment) {
  const tkCommand = tkWordsForShellSegment(segment);
  if (!tkCommand) {
    return undefined;
  }
  return normalizeText(tkCommand.words[tkCommand.shellCommandIndex + 1]).toLowerCase() || undefined;
}

function tkShowTicketIdForShellSegment(segment) {
  const tkCommand = tkWordsForShellSegment(segment);
  if (!tkCommand) {
    return undefined;
  }
  const subcommand = normalizeText(tkCommand.words[tkCommand.shellCommandIndex + 1]).toLowerCase();
  if (subcommand !== "show") {
    return undefined;
  }
  return normalizeText(
    firstPositionalArgument(tkCommand.words.slice(tkCommand.shellCommandIndex + 2)),
  );
}

function isTkMutatingShellSegment(segment) {
  const subcommand = tkSubcommandForShellSegment(segment);
  return Boolean(subcommand) && TK_MUTATING_SUBCOMMANDS.has(subcommand);
}

function isTkMutatingArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 2) {
    return false;
  }
  const words = argv.map((part) => String(part));
  if (
    normalizeText(words[0]).toLowerCase() === "tk" &&
    TK_MUTATING_SUBCOMMANDS.has(normalizeText(words[1]).toLowerCase())
  ) {
    return true;
  }

  for (let index = 0; index < words.length; index += 1) {
    const token = words[index];
    if (!token || isShellEnvironmentAssignment(token)) {
      continue;
    }
    if (!SHELL_COMMAND_PREFIXES.has(token)) {
      return false;
    }
    if (
      token === "env" &&
      envSplitStringValues(words, index).some((command) => isTkMutatingArgv(shellWords(command)))
    ) {
      return true;
    }
    const nestedIndex = skipShellCommandPrefix(words, index);
    return nestedIndex < words.length && isTkMutatingArgv(words.slice(nestedIndex));
  }
  return false;
}

function isPureTkShowArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 3) {
    return false;
  }
  const words = argv.map((part) => String(part));
  if (
    normalizeText(words[0]).toLowerCase() === "tk" &&
    normalizeText(words[1]).toLowerCase() === "show"
  ) {
    return Boolean(firstPositionalArgument(words.slice(2)));
  }

  for (let index = 0; index < words.length; index += 1) {
    const token = words[index];
    if (!token || isShellEnvironmentAssignment(token)) {
      continue;
    }
    if (!SHELL_COMMAND_PREFIXES.has(token)) {
      return false;
    }
    if (
      token === "env" &&
      envSplitStringValues(words, index).some((command) => isPureTkShowArgv(shellWords(command)))
    ) {
      return true;
    }
    const nestedIndex = skipShellCommandPrefix(words, index);
    return nestedIndex < words.length && isPureTkShowArgv(words.slice(nestedIndex));
  }
  return false;
}

function isPureTkMutatingCommand(step) {
  if (toolName(step) !== "bash") {
    return false;
  }
  if (Array.isArray(step.argv)) {
    return isTkMutatingArgv(step.argv);
  }
  const command = commandText(step);
  if (!command || hasMutatingShellCommand(command) || extractShellRedirectionTarget(command)) {
    return false;
  }
  const segments = shellLeafCommandSegments(command);
  return segments.length > 0 && segments.every(isTkMutatingShellSegment);
}

function isTkMutatingCommand(step) {
  if (toolName(step) !== "bash") {
    return false;
  }
  if (Array.isArray(step.argv)) {
    return isTkMutatingArgv(step.argv);
  }
  const command = commandText(step);
  if (!command) {
    return false;
  }
  return shellLeafCommandSegments(command).some(isTkMutatingShellSegment);
}

function isPureTkShowCommand(step) {
  if (toolName(step) !== "bash") {
    return false;
  }
  if (Array.isArray(step.argv)) {
    return isPureTkShowArgv(step.argv);
  }
  const command = commandText(step);
  if (!command || hasMutatingShellCommand(command) || extractShellRedirectionTarget(command)) {
    return false;
  }
  const segments = shellLeafCommandSegments(command);
  return (
    segments.length > 0 &&
    segments.every((segment) => Boolean(tkShowTicketIdForShellSegment(segment)))
  );
}

function readOnlyBashMutation(step) {
  if (toolName(step) !== "bash") {
    return false;
  }
  if (step.mutates === true) {
    return true;
  }
  const command = commandText(step);
  if (!command) {
    return false;
  }
  const hasArgv = Array.isArray(step.argv);
  const hasMutatingCommand = hasArgv
    ? hasMutatingShellArgv(step.argv)
    : hasMutatingShellCommand(command);
  return (
    hasMutatingCommand ||
    isTkMutatingCommand(step) ||
    (!hasArgv && Boolean(extractShellRedirectionTarget(command)))
  );
}

export {
  GIT_GLOBAL_OPTIONS_WITH_VALUES,
  SHELL_COMMAND_PREFIXES,
  SHELL_CONTROL_COMMAND_PREFIXES,
  bashMutationPath,
  commandText,
  firstPositionalArgument,
  firstPositionalArgumentIndex,
  hasRiskyExistingChangesGitCommand,
  isPureTkMutatingCommand,
  isPureTkShowCommand,
  isRecord,
  isShellEnvironmentAssignment,
  isTkMutatingCommand,
  normalizeText,
  readOnlyBashMutation,
  shellCommandInvocation,
  shellLeafCommandSegments,
  shellWords,
  skipShellCommandPrefix,
  toolCommandInvocations,
  toolName,
};
