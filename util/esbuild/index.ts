// @ts-expect-error
import type { BuildOptions, Format, Options } from "tsup";
import { defineConfig } from "tsup";

export function esbuildOptions(overrides: BuildOptions = {}) {
	overrides["assetNames"] ??= "assets/[name]";
	overrides["chunkNames"] ??= "assets/[name]-[hash]";
	overrides["entryNames"] ??= "[name]";

	return function(options: BuildOptions, context: { "format": Format }) {
		for (const [key, value] of Object.entries(overrides)) {
			options[key] = value;
		}
	};
}

export async function tsup(config: Options[] | Options) {
	if (!Array.isArray(config)) {
		config = [config];
	}

	config = config.map(function(options) {
		return {
			"esbuildOptions": esbuildOptions(options.esbuildOptions as BuildOptions),
			"esbuildPlugins": [],
			"format": "esm",
			"treeshake": true,
			...options,
			// WORKAROUND: `tsup` gives the entry straight to `globby` and `globby` doesn't get along with Windows paths.
			"entry": Array.isArray(options.entry) ? options.entry.map(function(entry) {
				return entry.replace(/\\/gu, "/");
			}) : Object.fromEntries(Object.entries(options.entry).map(function([entryName, sourceFile]) {
				return [entryName, sourceFile.replace(/\\/gu, "/")]
			}))
		}
	})

	console.log(defineConfig(config))

	console.log(process.cwd())

	// @ts-expect-error
	return (await import("tsup")).build(defineConfig(config)[0]);
}
