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
	overrides["entryNames"] ??= "[dir]/[name]";

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
						"setup": async function(build) {
							const files = {};

							if (!fs.existsSync(path.join(config.esbuildOptions["outdir"], "assets"))) {
								await fs.mkdir(path.join(config.esbuildOptions["outdir"], "assets"), {"recursive": true});
							}

							build.onLoad({ "filter": /.*/u }, importMetaUrl(async function(match, args) {
								const filePath = (await build.resolve(match, {
									"kind": "import-statement",
									"resolveDir": path.dirname(args.path)
								})).path;

								let file = await fs.readFile(filePath);

								const loaders = {
									".js": function(baseName) {
										if (path.basename(baseName, path.extname(baseName)).endsWith("worker")) {
											file = file.replace(/^import.*((?:'|").*(?:'|")).*/gmu, "export default await import($1);");
										}

										const hash = createHash("sha256").update(file).digest("hex").substring(0, 6);

										baseName = path.basename(baseName, path.extname(baseName)) + "-" + hash + ".js";

										files[path.relative(__root, filePath).replace(/\\/gu, "/")] = file.replace(/(?<=^import .*?(?:'|"))\..*\.js(?=(?:'|");?$)/gmu, function([_, match]) {
											return "./" + path.relative(__root, path.join(path.dirname(filePath), baseName)).replace(/\\/gu, "/");
										});

										return "\"./" + path.join("assets", baseName).replace(/\\/gu, "/") + "\"";
									},
									".json": function(baseName) {
										file = JSON.stringify(JSON5.parse(file || "{}"), undefined, "\t") + "\n"

										return loaders["default"](baseName);
									},
									"default": async function(baseName) {
										await fs.writeFile(path.join(config.esbuildOptions["outdir"], "assets", baseName), file)

										return "\"./" + path.join("assets", baseName).replace(/\\/gu, "/") + "\"";
									},
									".mp3": function(baseName) {
										return "\"data:audio/mpeg;base64,\"";
									},
									".ts": async function(baseName) {
										const hash = createHash("sha256").update(file).digest("hex").substring(0, 6);

										const { "outputFiles": [outputFile] } = await esbuild({
											"entryPoints": [filePath.replace(/\\/gu, "/")],
											"inject": [
												url.fileURLToPath(import.meta.resolve("node-stdlib-browser/helpers/esbuild/shim", import.meta.url))
											],
											"define": {
												"Buffer": "Buffer",
												"import.meta.url": "location.origin"
											},
											...config.esbuildOptions,
											"plugins": [
												polyfillNode(Object.fromEntries(["buffer", "crypto", "events", "os", "net", "path", "process", "stream", "util"].map(function(libName) {
													return [libName, stdLibBrowser[libName]];
												}))),
												{
													"name": "import-meta-url",
													"setup": function(build) {
														build.onLoad({ "filter": /.*/u }, importMetaUrl(async function(match, args) {
															const filePath = (await build.resolve(match, {
																"kind": "import-statement",
																"resolveDir": path.dirname(args.path)
															})).path;

															let file = await fs.readFile(filePath);

															let baseName = path.basename(filePath);

															if (path.basename(baseName, path.extname(baseName)).endsWith("worker")) {
																file = file.replace(/^import.*((?:'|").*(?:'|")).*/gmu, "export default await import($1);");
															}

															const hash = createHash("sha256").update(file).digest("hex").substring(0, 6);

															baseName = path.basename(baseName, path.extname(baseName)) + "-" + hash + ".js";

															filePath

															files[path.relative(__root, filePath).replace(/\\/gu, "/")] = file.replace(/(?<=^import .*?(?:'|"))\..*\.js(?=(?:'|");?$)/gmu, function([_, match]) {
																return "./" + path.relative(__root, path.join(path.dirname(filePath), baseName)).replace(/\\/gu, "/");
															});

															return "\"./" + path.join("assets", baseName).replace(/\\/gu, "/") + "\"";
														}));
													}
												}
											],
											"external": ["vscode"],
											"format": "cjs",
											"platform": "browser",
											"tsconfig": config.tsconfig
										});

										file = outputFile.text;

										return loaders["default"](path.basename(baseName, path.extname(baseName)) + "-" + hash + ".js");
									}
								}

								const extension = path.extname(filePath);

								return loaders[loaders[extension] !== undefined ? extension : "default"](path.basename(filePath));
							}));

							build.onEnd(async function({ "metafile": { outputs }, outputFiles }) {
								resolve({
									...mapEntries(outputFiles, function(outputFile) {
										return [outputs[path.relative(__root, outputFile.path).replace(/\\/gu, "/")]["entryPoint"],  outputFile.text]
									}),
									...files
								});
							});
						}
					},
					//...config.esbuildPlugins
				],
				"tsconfig": config.tsconfig
			});
		}),
		(files) => (async function(files) {
			return (await import("tsup")).build({
				"format": "esm",
				"treeshake": true,
				...config,
				"entry": {
					...config.entry,
					...mapEntries(files, function([filePath]) {
						if (!(filePath.endsWith(".js") || filePath.endsWith(".ts"))) {
							return;
						}

						const hash = createHash("sha256").update(files[filePath]).digest("hex").substring(0, 6);

						return [path.join("assets", path.basename(filePath, path.extname(filePath)) + "-" + hash).replace(/\\/gu, "/"), filePath];
					}, Boolean)
				},
				"esbuildOptions": esbuildOptions(config.esbuildOptions),
				"esbuildPlugins": [
					virtualFileSystem(files),
					...config.esbuildPlugins
				]
			});
		})(files)
	], entry)
}
