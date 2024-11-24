import { esbuild, fromString } from "..";
import { kebabCaseToPascalCase } from "../../text";
import * as path from "path";
import * as fs from "../../fs";

const components = {};
const scripts = {};

function _precompileComponent(build) {
	build.onLoad({ "filter": /components/u }, async function({ "path": filePath }) {
		const fileName = /(?<=components\/.*?\/).*?(?=\/|\.)/u.exec(filePath.replace(/\\/gu, "/")).pop();
		const packageName = (/(?<=components\/).*?(?=\/|\.)/u.exec(filePath.replace(/\\/gu, "/")) || []).pop();
		const properName = kebabCaseToPascalCase(packageName ?? fileName);

		const { "outputFiles": [outputFile] } = await esbuild({
			"entryPoints": filePath,
			/*
			...config.esbuildOptions,
			"plugins": [

			],
			"tsconfig": config.tsconfig
			*/
		});

		const defaultExport = (await import(URL.createObjectURL(new Blob([outputFile.text], { "type": "text/javascript" })) + "?ts=" + Date.now())).default;

		if (fileName.startsWith("index") && defaultExport?.postload !== undefined) {
			// <monkey-patch>
			const sourceFile = await fs.readFile(filePath);

			const code = sourceFile
				// Comment out non-relative imports
				.replace(/^(import .*? from (?:'|")[^\\.]+(?:'|");)$/gmu, "//$1")
				// Remove default export
				.replace(new RegExp("^export default function " + properName + ".*?^\\};$", "msu"), "")
				// Remove preload
				.replace(new RegExp("^" + properName + "\\.preload = .*?^\\};$", "msu"), "")
				// Replace postload
				.replace(new RegExp("^" + properName + "\\.postload = .*?^\\};$", "msu"), defaultExport.postload.toString().split("\n").slice(1, -1).join("\n"));
			// </monkey-patch>

			const { "outputFiles": [compiledOutput] } = await esbuild({
				"entryPoints": filePath,
				"stdin": {
					"contents": code
				},
				"plugins": [
					{
						"name": "import-relative",
						"setup": function(build) {
							build.onResolve({ "filter": /\.\/.*/u }, function({ "path": importPath }) {
								return {
									"path": path.join(path.dirname(filePath), importPath + ".ts")
								};
							});
						}
					}
				]
			});

			components[properName] = "function() {\n" + compiledOutput + "\n}";

			scripts[properName] = defaultExport?.preload?.();
		}
	});
}

export function precompileComponent() {
    return {
        "name": "precompile-component",
        "setup": _precompileComponent
    };
}
