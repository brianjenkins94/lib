import { esbuild } from "..";
import { kebabCaseToPascalCase } from "../../text";
import * as fs from "../../fs";
import { importFromString } from "module-from-string"

const components = {};
const scripts = {};

function _precompileComponent(build) {
	build.onLoad({ "filter": /components/u }, async function({ "path": filePath }) {
		const fileName = /(?<=components\/.*?\/).*?(?=\/|\.)/u.exec(filePath.replace(/\\/gu, "/")).pop();
		const packageName = (/(?<=components\/).*?(?=\/|\.)/u.exec(filePath.replace(/\\/gu, "/")) || []).pop();
		const properName = kebabCaseToPascalCase(packageName ?? fileName);

		const { "outputFiles": [outputFile] } = await esbuild({
			"entryPoints": [filePath],
			"external": ["react"]
		});

		const module = await importFromString(outputFile.text);

		const defaultExport = module.default;

		if (fileName.startsWith("index") && defaultExport?.postload !== undefined) {
			const sourceFile = await fs.readFile(filePath);

			const code = sourceFile
				// Comment out non-relative imports
				.replace(/^(import .*? from (?:'|")[^\\.]+(?:'|");)$/gmu, "//$1")
				// Remove default export
				.replace(new RegExp("^export default function " + properName + ".*?^\\};?$", "msu"), "")
				// Remove preload
				.replace(new RegExp("^" + properName + "\\.preload = .*?^\\};$", "msu"), "")
				// Replace postload
				.replace(new RegExp("^" + properName + "\\.postload = .*?^\\};$", "msu"), defaultExport.postload.toString().split("\n").slice(1, -1).join("\n"));

			const { "outputFiles": [compiledOutput] } = await esbuild({
				"stdin": {
					"contents": code,
					"loader": "tsx"
					//"resolveDir": ?
				}
			});

			components[properName] = "function() {\n" + compiledOutput.text + "\n}";

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
