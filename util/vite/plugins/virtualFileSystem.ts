import type { PluginOption } from "vite";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";

export function virtualFileSystem(files = {}) {
	let root;

	let input;

	let external;

	return {
		"name": "virtual-file-system",
		"enforce": "pre",
		"configResolved": async function(config) {
			({ root } = config);

			files = Object.entries(files).reduce((files, [fileName, value]) => {
				files[path.join(root, fileName)] = value;

				return files;
			}, {});

			input = files[path.join(root, config.build.rollupOptions.input)];

			// TODO: Improve
			external = config.build.rollupOptions.external ?? Object.keys(JSON.parse(await fs.readFile(fs.closest(root, "package.json")))["devDependencies"]);
		},
		"resolveId": async function(id, importer, { isEntry }) {
			if (id.includes("?")) {
				return;
			}

			if (Object.keys(files).includes(path.join(root, id))) {
				return path.join(root, id);
			}

			if (typeof external === "function") {
				return {
					"id": id.startsWith(".") ? (await this.resolve(id, importer, { "skipSelf": true }))["id"] : id,
					"external": id.startsWith(".") ? false : external(id),
					"moduleSideEffects": false
				};
			} else if (Array.isArray(external)) {
				function shouldBeExternal() {
					if (id.startsWith("/")) {
						return true;
					}

					return external.length > 0 ? new RegExp(`^(${external.join("|")})(/.*)?$`).test(id) : true;
				}

				return {
					"id": id.startsWith(".") || !shouldBeExternal() ? (await this.resolve(id, importer, { "skipSelf": true }))["id"] : id,
					"external": shouldBeExternal(),
					"moduleSideEffects": false
				};
			}
		},
		"load": async function(id) {
			if (id.includes("?")) {
				return;
			}

			if (files[id] !== undefined) {
				let result = files[id];

				if (!path.extname(id).endsWith(".html") && Array.isArray(external)) {
					result = result.replace(new RegExp(`(?!['"])(?!['"]$).*?(?<!\\/\\* @__PURE__ \\*\\/ )\\b(${external.join("|")})\\b(?!['"])`, "gu"), function(line, match) {
						return line.startsWith("import") ? line : line.replace(match, "/* @__PURE__ */ " + match);
					});
				}

				return result;
			}
		}
	} as PluginOption;
}
