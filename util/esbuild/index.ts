// @ts-expect-error
import type { BuildOptions, Format, Options } from "tsup";
import * as path from "path";
import JSON5 from "json5";
import polyfillNode from "node-stdlib-browser/helpers/esbuild/plugin"; // NOT "esbuild-plugins-node-modules-polyfill" NOR "esbuild-plugin-polyfill-node"
import stdLibBrowser from "node-stdlib-browser";
import { createHash } from "crypto";
import * as url from "url";
import { build } from "esbuild";

import { reduceAsync, mapEntries } from "../array"
import * as fs from "../fs";
import { importMetaUrl, virtualFileSystem } from "./plugins";
import { __root } from "../env";

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

export async function esbuild(config: BuildOptions) {
	config["assetNames"] ??= "assets/[name]";
	config["chunkNames"] ??= "assets/[name]-[hash]";
	config["entryNames"] ??= "[name]";

	const result = await build({
		"bundle": true,
		"format": "esm",
		"write": false,
		...config
	});

	if (result.errors.length > 0) {
		console.error(result.errors);
	}

	return result;
}

export async function tsup(config: Options) {
	// WORKAROUND: `tsup` gives the entry straight to `globby` and `globby` doesn't get along with Windows paths.
	const entry = Array.isArray(config.entry) ? config.entry.map(function(entry) {
		return entry.replace(/\\/gu, "/");
	}) : mapEntries(config.entry, function([entryName, sourceFile]) {
		return [entryName, sourceFile.replace(/\\/gu, "/")]
	});

	return reduceAsync([
		(entry) => new Promise(function(resolve, reject) {
			return esbuild({
				"entryPoints": entry,
				"metafile": true,
				...config.esbuildOptions,
				"inject": [
					url.fileURLToPath(import.meta.resolve("node-stdlib-browser/helpers/esbuild/shim", import.meta.url))
				],
				"plugins": [
					polyfillNode(Object.fromEntries(["buffer", "crypto", "events", "fs", "os", "net", "path", "process", "stream", "util"].map(function(libName) {
						return [libName, stdLibBrowser[libName]];
					}))),
					{
						"name": "discover-entrypoints",
						"setup": function(build) {
							build.onLoad({ "filter": /.*/u }, importMetaUrl(async function(match, args) {
								let filePath = (await build.resolve(match, {
									"kind": "import-statement",
									"resolveDir": path.dirname(args.path),
								})).path;
								let baseName = path.basename(filePath);
								const extension = path.extname(baseName);

								const loaders = {
									// ".json": function() {

									// },
									"default": async function() {
										let file = await fs.readFile(filePath);

										const hash = createHash("sha256").update(file).digest("hex").substring(0, 6);

										baseName = path.basename(baseName, extension);

										baseName = baseName + "-" + hash + extension;

										if (filePath.endsWith(".json")) {
											file = JSON.stringify(JSON5.parse(file || "{}"), undefined, "\t") + "\n"
										}

										if (filePath.endsWith(".ts")) {
											const { "outputFiles": [outputFile] } = await esbuild({
												"entryPoints": [filePath.replace(/\\/gu, "/")],
												"inject": [
													url.fileURLToPath(import.meta.resolve("node-stdlib-browser/helpers/esbuild/shim", import.meta.url))
												],
												"define": {
													"Buffer": "Buffer",
													"import.meta.url": "__dirname"
												},
												...config.esbuildOptions,
												"plugins": [
													polyfillNode(Object.fromEntries(["buffer", "crypto", "events", "os", "net", "path", "process", "stream", "util"].map(function(libName) {
														return [libName, stdLibBrowser[libName]];
													})))
												],
												"external": ["vscode*"],
												"format": "cjs",
												"platform": "browser"
											});

											file = outputFile.text;

											baseName = path.basename(baseName, path.extname(baseName)) + ".js";
										} else {
											if (!fs.existsSync(path.join(config.esbuildOptions["outdir"], "assets"))) {
												await fs.mkdir(path.join(config.esbuildOptions["outdir"], "assets"), {"recursive": true});
											}

											await fs.writeFile(path.join(config.esbuildOptions["outdir"], "assets", baseName), file)
										}

										// FIXME: We need to conditionally prefix with `./assets/`, depending on the entrypoint output location.
										return "\"./assets/" + baseName + "\""
									},
									".mp3": function() {
										return "\"data:audio/mpeg;base64,\"";
									},
									// ".ts": function() {

									// }
								}

								return loaders[loaders[extension] !== undefined ? extension : "default"]();
							}));

							build.onEnd(async function({ "metafile": { outputs }, outputFiles }) {
								resolve(mapEntries(outputFiles, function(outputFile) {
									return [outputs[path.relative(__root, outputFile.path).replace(/\\/gu, "/")]["entryPoint"],  outputFile.text]
								}));
							});
						}
					},
					//...config.esbuildPlugins
				]
			});
		}),
		(files) => new Promise(async function(resolve, reject) {
			(await import("tsup")).build({
				"format": "esm",
				"treeshake": true,
				...config,
				"esbuildOptions": esbuildOptions(config.esbuildOptions),
				"esbuildPlugins": [
					virtualFileSystem(files),
					...config.esbuildPlugins
				]
			});
		})
	], entry)
}
