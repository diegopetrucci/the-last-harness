import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const targetFiles = ["scripts/**/*.{js,mjs,ts,mts}", "tests/**/*.{js,mjs,ts,mts}", "extensions/**/*.{js,mjs,ts,mts}"];
const typescriptFiles = ["scripts/**/*.{ts,mts}", "tests/**/*.{ts,mts}", "extensions/**/*.{ts,mts}"];
const importedSubagentTestFiles = ["extensions/subagents/test/**/*.{ts,mts}"];
const generatedExtensionJavaScriptFiles = [
	"extensions/*.js",
	"extensions/annotate-git-diff/*.js",
	"extensions/shared/*.js",
	"extensions/the-last-harness/*.js",
	"extensions/the-last-harness/annotate-last-message/*.js",
	"extensions/subagents/src/**/*.js",
];

const unusedArgsOptions = { argsIgnorePattern: "^_" };

const withFiles = (config) => ({
	...config,
	files: typescriptFiles,
});

export default tseslint.config(
	{
		ignores: ["node_modules/**"],
	},
	{
		files: targetFiles,
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: globals.node,
		},
	},
	{
		name: "tlh/javascript-recommended",
		files: targetFiles,
		rules: {
			...js.configs.recommended.rules,
			"no-unused-vars": ["error", unusedArgsOptions],
		},
	},
	...tseslint.configs.recommended.map(withFiles),
	{
		name: "tlh/generated-extension-javascript-empty-catch",
		files: generatedExtensionJavaScriptFiles,
		rules: {
			"no-empty": ["error", { allowEmptyCatch: true }],
		},
	},
	{
		name: "tlh/typescript-unused-args",
		files: typescriptFiles,
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", unusedArgsOptions],
		},
	},
	{
		// Imported fixtures intentionally use broad mock values and escaped
		// transcript patterns. Keep only the high-count compatibility rules broad.
		name: "tlh/imported-subagent-test-compatibility",
		files: importedSubagentTestFiles,
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"no-regex-spaces": "off",
			"no-useless-escape": "off",
		},
	},
	{
		name: "tlh/imported-subagent-async-optional-chain-fixtures",
		files: ["extensions/subagents/test/integration/async-execution.test.ts"],
		rules: {
			"@typescript-eslint/no-non-null-asserted-optional-chain": "off",
		},
	},
	{
		name: "tlh/imported-subagent-terminal-render-fixture",
		files: ["extensions/subagents/test/integration/render-widget.test.ts"],
		rules: {
			"no-control-regex": "off",
		},
	},
);
