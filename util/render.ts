import * as ejs from "ejs";
import * as fs from "./fs";
import { mapEntries } from "./array";
import * as path from "path";
import { polyfillNode } from "./vite/plugins/polyfillNode";
import { virtualFileSystem } from "./vite/plugins/virtualFileSystem";
import { jsxToString } from "jsx-async-runtime";
import { transform } from "./router";

let vite;

function isJsxAsyncRuntimeNode(object) {
	return (object.type === "tag" && "tag" in object && object.props && typeof object.props === "object") || (object.type === "textNode" && "text" in object);
}

export async function render(template, data = {}, { useVite = false, root = undefined, route = undefined, ...options } = {}) {
	// Convert the object values to strings
	data = await mapEntries(data, async function([key, value]) {
		if (typeof value !== "function" && typeof value === "object") {
			if (isJsxAsyncRuntimeNode(value)) {
				value = await jsxToString(value);
			} else {
				value = JSON.stringify(value);
			}
		}

		return [key, value];
	});

	// Convert the function values to strings
	data = await mapEntries(data, async function([key, value]) {
		if (typeof value === "function") {
			value = ejs.render(value.toString().substring(value.toString().indexOf("{") + 1, value.toString().lastIndexOf("}")), data, { "openDelimiter": "\"<", "closeDelimiter": ">\"" }).trim();

			if (useVite) {
				vite ??= await import("vite");

				const routeHandler = await fs.readFile(await transform(root, route));

				const result = await vite.build({
					"mode": "production",
					"root": path.join(root, route),
					"build": {
						"rollupOptions": {
							"input": "index.tsx",
							"preserveEntrySignatures": "allow-extension"
						},
						"minify": false,
						"modulePreload": { "polyfill": false },
						"write": false
					},
					"plugins": [
						polyfillNode(),
						virtualFileSystem({
							"index.tsx": [
								routeHandler,
								value
							].join("\n")
						})
					]
				});

				value = result.output[0].code
					// TODO: Is this still needed?
					// Undo import_
					.replace(/import_.+?\./gu, "")
					// Remove remaining non-relative imports
					.replace(/^(import .*? from (?:'|")[^\\.]+?(?:'|");)$/gmu, "");
			}
		}

		return [key, value];
	});

	template = await fs.readFile(template, { "encoding": "utf8" });

	while (true) {
		let html;

		try {
			html = ejs.render(template, data, options);
		} catch (error) {
			const message = error.toString().split("\n").pop();

			console.error(message);

			const match = (/(.+) is not defined/ui.exec(message) ?? []).pop();

			if (match !== undefined) {
				data[match] = "";

				continue;
			}

			throw error;
		}

		if (useVite) {
			const result = await vite.build({
				"mode": "production",
				"root": root,
				"base": "/otto-parts/", // TODO: Make this customizable.
				"build": {
					"emptyOutDir": false,
					"rollupOptions": {
						"input": "index.html"
					},
					"minify": false,
					"modulePreload": { "polyfill": false }
				},
				"define": {
					"import.meta.url": "location.pathname",
					"process": "{ \"env\": {} }"
				},
				"plugins": [
					polyfillNode(),
					virtualFileSystem({
						"index.html": html
					}),
					(function transform() {
						let __root;

						let external;

						return {
							"name": "transform",
							"enforce": "post",
							"configResolved": async function(config) {
								__root = config.root;

								// TODO: Improve
								external = config.build.rollupOptions.external ?? Object.keys(JSON.parse(await fs.readFile(path.join(__root, "package.json")))["devDependencies"])
							},
							"transform": async function(code, id) {
								if (id.endsWith(".html")) {
									return;
								}

								const result = code.replace(new RegExp(`(?!['"])(?!['"]$).*?(?<!\\/\\* @__PURE__ \\*\\/ )\\b(${external.join("|")})\\b(?!['"])`, "gu"), function(line, match) {
									return line.startsWith("import") ? line : line.replace(match, "/* @__PURE__ */ " + match)
								});

								return result;
							}
						}
					})()
				],
				"publicDir": false
			});

			html = result.output.find(({ fileName }) => fileName === "index.html").source;
		}

		return html;
	}
}
