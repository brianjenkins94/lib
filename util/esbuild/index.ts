// @ts-expect-error
import type { BuildOptions, Format, Options, Entry } from "tsup";
import * as path from "path";
import JSON5 from "json5";

import { reduceAsync, mapEntries } from "../array"
import * as fs from "../fs";
import { importMetaUrl, virtualFileSystem } from "./plugins";

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
	// WORKAROUND: `tsup` gives the entry straight to `globby` and `globby` doesn't get along with Windows paths.
	const entry = Array.isArray(config.entry) ? config.entry.map(function(entry) {
		return entry.replace(/\\/gu, "/");
	}) : mapEntries(config.entry, function([entryName, sourceFile]) {
		return [entryName, sourceFile.replace(/\\/gu, "/")]
	});

	return reduceAsync([
		(entry) => new Promise<Entry>(async function(resolve, reject) {
			(await import("tsup")).build({
				"format": "esm",
				"treeshake": true,
				...config,
				"entry": entry,
				"esbuildOptions": esbuildOptions({
					...(config.esbuildOptions ?? {}),
					"write": false
				}),
				"esbuildPlugins": [
					{
						"name": "discover-entrypoints",
						"setup": function(build) {
							const files = {};

							build.onLoad({ "filter": /.*/u }, importMetaUrl(async function(match, args) {
								let filePath = (await build.resolve(match, {
									"kind": "import-statement",
									"resolveDir": path.dirname(args.path),
								})).path;
								let baseName = path.basename(filePath);

								const loaders = {
									".ts": function() {
										throw new Error("Not yet implemented.");
									},
									"default": function() {
										if (files["./assets/" + baseName] !== undefined) {
											console.warn(baseName + " already exists!");
										}

										files["./assets/" + baseName] = filePath

										return "\"./assets/" + baseName + "\""
									},
									".json": async function() {
										if (files["./assets/" + baseName] !== undefined) {
											console.warn(baseName + " already exists!");
										}

										files["./assets/" + baseName] = filePath

										JSON.stringify(JSON5.parse(await fs.readFile(filePath) || "{}"), undefined, "\t") + "\n"

										return "\"./assets/" + baseName+ "\""
									},
									".mp3": function() {
										return "\"data:audio/mpeg;base64,\"";
									}
								}

								const extension = path.extname(baseName);

								return loaders[loaders[extension] !== undefined ? extension : "default"]();
							}));

							build.onEnd(async function(results) {
								config.esbuildPlugins.unshift(virtualFileSystem(await mapEntries(files, async function([fakePath, realPath]) {
									return [fakePath, await fs.readFile(realPath)]
								}), path.join(config.esbuildOptions["outdir"], "..")))

								resolve(files);
							});
						}
					},
					...config["esbuildPlugins"]
				]
			});
		}),
		(entry) => new Promise(async function(resolve, reject) {
			(await import("tsup")).build({
				"format": "esm",
				"treeshake": true,
				...config,
				"entry": entry,
				"esbuildOptions": esbuildOptions(config.esbuildOptions),
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
		})
	], entry)
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
