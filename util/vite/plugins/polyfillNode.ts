import type { PluginOption } from "vite";
import { builtinModules } from "node:module";
import stdlib from "node-stdlib-browser";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const NAMESPACE = "\0external-global:";

function isFunctional(builtin: string): boolean {
	return stdlib[builtin] !== undefined && !/mock[/\\]empty/u.test(stdlib[builtin]);
}

export function polyfillNode(builtins = builtinModules): PluginOption {
	const polyfill = builtins.filter(isFunctional);
	const stub = builtins.filter((builtin) => !isFunctional(builtin));

	const filter = new RegExp(`^(?:${NAMESPACE})?(${stub.join("|")})(/.*)?$`, "u");

	return [
		...(polyfill.length > 0 ? nodePolyfills({ "include": polyfill, "protocolImports": true }) : []),
		...(stub.length > 0 ? [{
			"name": "node-stdlib-browser-alias",
			"enforce": "pre",
			"resolveId": function(id) {
				const [_, match] = filter.exec(id) ?? [];

				if (match !== undefined && stub.some((builtin) => id.startsWith(builtin))) {
					return NAMESPACE + id;
				}
			},
			"load": async function(id) {
				const [_, match] = filter.exec(id) ?? [];

				if (match !== undefined) {
					return Object.entries(await import(match)).map(function([key, value]) {
						return `export ${key === "default" ? "default" : `const ${key} =`} ${typeof value === "function" ? "() => {}" : undefined};`;
					}).join("\n");
				}
			}
		} as PluginOption] : [])
	];
}
