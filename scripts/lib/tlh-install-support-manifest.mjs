const REQUIRED = "required";
const OPTIONAL = "optional";

const BASE_SUPPORT_FILES = Object.freeze([
	{
		variable: "TLH_INSTALL_SCRIPT",
		requirement: REQUIRED,
		relativePath: "scripts/tlh-install.mjs",
		tempPath: "tlh-install.mjs",
		installName: "",
	},
	{
		variable: "TLH_INSTALL_SUPPORT_MANIFEST_SCRIPT",
		requirement: REQUIRED,
		relativePath: "scripts/lib/tlh-install-support-manifest.mjs",
		tempPath: "lib/tlh-install-support-manifest.mjs",
		installName: "",
	},
	{
		variable: "TLH_INSTALL_PACKAGE_SOURCE_LIB",
		requirement: REQUIRED,
		relativePath: "scripts/lib/tlh-install-package-source.mjs",
		tempPath: "lib/tlh-install-package-source.mjs",
		installName: "",
	},
	{
		variable: "TLH_INSTALL_PATHS_LIB",
		requirement: REQUIRED,
		relativePath: "scripts/lib/tlh-install-paths.mjs",
		tempPath: "lib/tlh-install-paths.mjs",
		installName: "",
	},
	{
		variable: "TLH_INSTALL_GIT_LIB",
		requirement: REQUIRED,
		relativePath: "scripts/lib/tlh-install-git.mjs",
		tempPath: "lib/tlh-install-git.mjs",
		installName: "",
	},
	{
		variable: "TLH_INSTALL_SUBAGENTS_LIB",
		requirement: REQUIRED,
		relativePath: "scripts/lib/tlh-install-subagents.mjs",
		tempPath: "lib/tlh-install-subagents.mjs",
		installName: "",
	},
	{
		variable: "TLH_INSTALL_SUPPORT_FILES_LIB",
		requirement: REQUIRED,
		relativePath: "scripts/lib/tlh-install-support-files.mjs",
		tempPath: "lib/tlh-install-support-files.mjs",
		installName: "",
	},
	{
		variable: "TLH_INSTALL_QUERY_SCRIPT",
		requirement: REQUIRED,
		relativePath: "scripts/tlh-install-query.mjs",
		tempPath: "tlh-install-query.mjs",
		installName: "",
	},
	{
		variable: "MERGE_SCRIPT",
		requirement: REQUIRED,
		relativePath: "scripts/merge-settings.mjs",
		tempPath: "merge-settings.mjs",
		installName: "",
	},
	{
		variable: "TLH_DEFAULTS_SCRIPT",
		requirement: REQUIRED,
		relativePath: "scripts/tlh-defaults.mjs",
		tempPath: "tlh-defaults.mjs",
		installName: "tlh-defaults.mjs",
	},
	{
		variable: "TLH_GNOSIS_SCRIPT",
		requirement: REQUIRED,
		relativePath: "scripts/tlh-gnosis.mjs",
		tempPath: "tlh-gnosis.mjs",
		installName: "tlh-gnosis.mjs",
	},
	{
		variable: "TLH_TICKETS_SCRIPT",
		requirement: REQUIRED,
		relativePath: "scripts/tlh-tickets.mjs",
		tempPath: "tlh-tickets.mjs",
		installName: "tlh-tickets.mjs",
	},
	{
		variable: "TLH_UPDATE_SCRIPT",
		requirement: OPTIONAL,
		relativePath: "scripts/tlh-update.mjs",
		tempPath: "tlh-update.mjs",
		installName: "tlh-update.mjs",
	},
	{
		variable: "TLH_WRAPPER_SCRIPT",
		requirement: OPTIONAL,
		relativePath: "scripts/tlh-wrapper.mjs",
		tempPath: "tlh-wrapper.mjs",
		installName: "tlh-wrapper.mjs",
	},
	{
		variable: "TLH_INSTALL_STATE_SCRIPT",
		requirement: OPTIONAL,
		relativePath: "scripts/tlh-install-state.mjs",
		tempPath: "tlh-install-state.mjs",
		installName: "tlh-install-state.mjs",
	},
	{
		variable: "DEFAULTS_FILE",
		requirement: REQUIRED,
		relativePath: "config/settings.defaults.json",
		tempPath: "settings.defaults.json",
		installName: "",
	},
	{
		variable: "DEFAULT_EXTENSIONS_FILE",
		requirement: REQUIRED,
		relativePath: "config/default-extensions.json",
		tempPath: "default-extensions.json",
		installName: "default-extensions.json",
	},
]);

const SETTINGS_SUPPORT_FILES = Object.freeze([
	{
		variable: "KEYBINDINGS_MERGE_SCRIPT",
		requirement: REQUIRED,
		relativePath: "scripts/merge-keybindings.mjs",
		tempPath: "merge-keybindings.mjs",
		installName: "",
	},
	{
		variable: "KEYBINDINGS_DEFAULTS_FILE",
		requirement: REQUIRED,
		relativePath: "config/keybindings.defaults.json",
		tempPath: "keybindings.defaults.json",
		installName: "",
	},
]);

function cloneSupportFile(file) {
	return { ...file };
}

export function supportFileManifest({ noSettings = false } = {}) {
	const files = noSettings ? BASE_SUPPORT_FILES : [...BASE_SUPPORT_FILES, ...SETTINGS_SUPPORT_FILES];
	return files.map(cloneSupportFile);
}

export function formatSupportFileManifestRow(file) {
	return [
		file.variable,
		file.requirement,
		file.relativePath,
		file.tempPath,
		file.installName || "",
	].join("|");
}

export function formatSupportFileManifest(options = {}) {
	return supportFileManifest(options).map(formatSupportFileManifestRow).join("\n");
}

export function requiredSupportFiles(options = {}) {
	return supportFileManifest(options).filter((file) => file.requirement === REQUIRED);
}

export function optionalSupportFiles(options = {}) {
	return supportFileManifest(options).filter((file) => file.requirement === OPTIONAL);
}

export function installableSupportFiles(options = {}) {
	return supportFileManifest(options).filter((file) => Boolean(file.installName));
}

export const SUPPORT_FILE_REQUIREMENTS = Object.freeze({
	REQUIRED,
	OPTIONAL,
});
