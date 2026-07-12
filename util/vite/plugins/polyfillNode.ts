import type { PluginOption } from "vite";
import { builtinModules } from "node:module";

const NAMESPACE = "\0external-global:";

export function polyfillNode(builtins = builtinModules) {
	const filter = new RegExp(`^(?:${NAMESPACE})?(${builtins.join("|")})(/.*)?$`);

	return {
		"name": "node-stdlib-browser-alias",
		"enforce": "pre",
		"resolveId": function(id) {
			const [_, match] = filter.exec(id) ?? [];

			if (match !== undefined && builtins.some((builtin) => id.startsWith(builtin))) {
				return NAMESPACE + id;
			}
		},
		"load": async function(id) {
			const [_, match] = filter.exec(id) ?? [];

			if (match !== undefined) {
				const matches = Object.entries(await import(match)).map(function([key, value]) {
					return `export ${key === "default" ? "default" : `const ${key} =`} ${(typeof value === "function" ? "() => {}" : undefined)};`;
				}).join("\n");

				return matches;
			}
		}
	} as PluginOption;
}
