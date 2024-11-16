// @ts-expect-error
import type { BuildResult, BuildOptions, Format, Options, Entry } from "tsup";
import * as path from "path";
import JSON5 from "json5";
import polyfillNode from "node-stdlib-browser/helpers/esbuild/plugin"; // NOT "esbuild-plugins-node-modules-polyfill" NOR "esbuild-plugin-polyfill-node"
import stdLibBrowser from "node-stdlib-browser";
import { createHash } from "crypto";
import * as url from "url";

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
				"clean": true,
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

							// @ts-expect-error
							build.onLoad({ "filter": /.*/u }, importMetaUrl(async function(match, args) {
								let filePath = (await build.resolve(match, {
									"kind": "import-statement",
									"resolveDir": path.dirname(args.path),
								})).path;
								let baseName = path.basename(filePath);
								const extension = path.extname(baseName);

								const loaders = {
									"default": async function() {
										const file = await fs.readFile(filePath);

										const hash = createHash("sha256").update(file).digest("hex").substring(0, 6);

										baseName = path.basename(baseName, extension);

										baseName = baseName + "-" + hash + extension;

										files["./assets/" + baseName] = filePath

										return "\"./assets/" + baseName + "\""
									},
									".mp3": function() {
										return "\"data:audio/mpeg;base64,\"";
									}
								}

								return loaders[loaders[extension] !== undefined ? extension : "default"]();
							}));

							build.onEnd(async function(result) {
								resolve(await mapEntries(files, async function([fakePath, realPath]) {
									if (fakePath.endsWith(".json")) {
										return [fakePath, JSON.stringify(JSON5.parse(await fs.readFile(realPath) || "{}"), undefined, "\t") + "\n"]
									}

									if (fakePath.endsWith(".ts")) {
										const { "outputFiles": [outputFile] } = await new Promise<BuildResult<BuildOptions>>(async function(resolve, reject) {
											(await import("tsup")).build({
												"config": false,
												// WORKAROUND: `tsup` gives the entry straight to `globby` and `globby` doesn't get along with Windows paths.
												"entry": [realPath.replace(/\\/gu, "/")],
												"inject": [
													url.fileURLToPath(import.meta.resolve("node-stdlib-browser/helpers/esbuild/shim", import.meta.url))
												],
												"define": {
													"Buffer": "Buffer",
													"import.meta.url": "__dirname"
												},
												"esbuildOptions": esbuildOptions({
													"outdir": config.esbuildOptions["outdir"],
													"write": false
												}),
												"esbuildPlugins": [
													polyfillNode(Object.fromEntries(["buffer", "crypto", "events", "os", "net", "path", "process", "stream", "util"].map(function(libName) {
														return [libName, stdLibBrowser[libName]];
													}))),
													{
														"name": "build-write-false",
														"setup": function(build) {
															build.onEnd(function(result) {
																resolve(result);
															})
														}
													},
												],
												"external": [/^vscode.*/u],
												"format": "cjs",
												"platform": "browser"
											});
										});

										return [fakePath, outputFile.text];
									}

									return [
										fakePath,
										await fs.readFile(realPath)
									];
								}));
							});
						}
					},
					//...config["esbuildPlugins"]
				]
			});
		}),
		(files) => new Promise(async function(resolve, reject) {
			(await import("tsup")).build({
				"clean": true,
				"format": "esm",
				"treeshake": true,
				...config,
				"entry": {
					...entry,
					...mapEntries(files, function([filePath]) {
						if (!filePath.endsWith(".js")) {
							return;
						}

						return [path.basename(filePath, path.extname(filePath)), filePath];
					}, Boolean)
				},
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
					importMetaUrl(files, path.join(config.esbuildOptions["outdir"], "..")),
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
