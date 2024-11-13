// @ts-expect-error
import type { BuildOptions, Format, Options } from "tsup";

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

export async function tsup(config: Options) {
	console.log(config);

	return new Promise(async function(resolve, reject) {
		(await import("tsup")).build({
			"format": "esm",
			"treeshake": true,
			...config,
			// WORKAROUND: `tsup` gives the entry straight to `globby` and `globby` doesn't get along with Windows paths.
			"entry": Array.isArray(config.entry) ? config.entry.map(function(entry) {
				return entry.replace(/\\/gu, "/");
			}) : Object.fromEntries(Object.entries(config.entry).map(function([entryName, sourceFile]) {
				return [entryName, sourceFile.replace(/\\/gu, "/")]
			})),
			"esbuildOptions": config.esbuildOptions as BuildOptions ?? esbuildOptions(),
			"esbuildPlugins": [
				{
					"name": "build-write-false",
					"setup": function(build) {
						build.onEnd(function(result) {
							resolve(result);
						})
					}
				},
				...config["esbuildPlugins"]
			]
		});
	});
}

/*
export async function esbuildWriteFalse(options: Options) {
	return (await build({
		"bundle": true,
		"format": "esm",
		"stdin": {
			"resolveDir": __root,
			"sourcefile": "fetch.ts",
			"contents": ``
		},
		"write": false,
		"define": {
			"process": "{}",
			"process.env": "{}",
			"process.env.NODE_ENV": "\"production\""
		}
	})).outputFiles[0].text;
}
*/
