import js from "@eslint/js";
import globals from "globals";
import { registerHooks } from "node:module";

// typescript-eslint 8 needs the TypeScript 6 API; project typechecks still use root TypeScript 7.
registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier === "typescript" ? "@typescript/typescript6" : specifier, context);
	},
});
const { default: tseslint } = await import("typescript-eslint");

const targetFiles = ["scripts/**/*.{js,mjs,ts,mts}", "tests/**/*.{js,mjs,ts,mts}", "extensions/**/*.{js,mjs,ts,mts}"];
const typescriptFiles = ["scripts/**/*.{ts,mts}", "tests/**/*.{ts,mts}", "extensions/**/*.{ts,mts}"];
const generatedExtensionJavaScriptFiles = [
	"extensions/*.js",
	"extensions/annotate-git-diff/*.js",
	"extensions/shared/*.js",
	"extensions/the-last-harness/*.js",
	"extensions/the-last-harness/annotate-last-message/*.js",
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
);
