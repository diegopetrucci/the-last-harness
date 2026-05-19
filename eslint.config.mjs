import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const targetFiles = ["scripts/**/*.{js,mjs,ts}", "tests/**/*.{js,mjs,ts}", "extensions/**/*.{js,mjs,ts}"];
const typescriptFiles = ["scripts/**/*.ts", "tests/**/*.ts", "extensions/**/*.ts"];

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
		name: "tlh/typescript-unused-args",
		files: typescriptFiles,
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", unusedArgsOptions],
		},
	},
);
