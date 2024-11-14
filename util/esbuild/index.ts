// @ts-expect-error
import type { BuildOptions, Format, Options, Entry } from "tsup";
import { reduceAsync, mapEntries } from "../array"

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
				"esbuildOptions": config.esbuildOptions ?? esbuildOptions(),
				"esbuildPlugins": [
					{
						"name": "discover-entrypoints",
						"setup": function(build) {
							const entrypoints = config.entry;

							build.onLoad({ "filter": /.*/u }, async function({ "path": importer }) {
								let contents = await fs.readFile(importer);

								const newUrlRegEx = /new URL\((?:"|')(.*?)(?:"|'), \w+(?:\.\w+)*\)(?:\.\w+(?:\(\))?)?/gu;

								if (newUrlRegEx.test(contents)) {
									// TODO: This whole function could use a review.
									contents = await replaceAsync(newUrlRegEx, contents, async function([_, match]) {
										let filePath = (await build.resolve(match, {
											"kind": "import-statement",
											"resolveDir": path.dirname(importer),
										})).path;
										let baseName = path.basename(filePath);

										if (filePath.endsWith(".ts")) {
											await handleTypeScript();
										}

										switch (true) {
											case filePath.endsWith(".json"):
												await fs.writeFile(filePath, JSON.stringify(JSON5.parse(await fs.readFile(filePath) || "{}"), undefined, "\t") + "\n");
												break;
											case filePath.endsWith(".mp3"):
												return "\"data:audio/mpeg;base64,\"";
											default:
										}

										console.log("new entrypoint?: " + path.relative(__dirname, filePath))

										// Caching opportunity here:
										const file = await fs.readFile(filePath);

										const hash = createHash("sha256").update(file).digest("hex").substring(0, 6);

										const extension = path.extname(baseName);
										baseName = path.basename(baseName, extension);

										baseName = baseName + "-" + hash + extension;

										// Copy it to the assets directory
										await fs.mkdir(assetsDirectory, { "recursive": true })
										await fs.copyFile(filePath, path.join(assetsDirectory, baseName));

										if (importer.endsWith(".ts")) {
											return "\"./assets/" + baseName + "\"";
										}

										// So that we can refer to it by its unique name.
										return "\"./" + baseName + "\"";
									});

									return {
										"contents": contents,
										"loader": path.extname(importer).substring(1)
									};
								}
							});

							build.onEnd(function(results) {
								resolve(entrypoints);
							})
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
				"esbuildOptions": config.esbuildOptions ?? esbuildOptions(),
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
