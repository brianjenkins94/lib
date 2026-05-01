import stdLibBrowser from "node-stdlib-browser";
import { PluginOption } from "vite";

const NAMESPACE = "\0external-global:";

export function polyfillNode(builtins = Object.keys(stdLibBrowser)) {
    const filter = new RegExp(`^(?:${NAMESPACE})?(${builtins.join("|")})(/.*)?$`);

    const builtinsMap = Object.fromEntries(Object.keys(stdLibBrowser).map(function(libName) { return [libName, stdLibBrowser[libName]]; }))

    return {
        "name": "node-stdlib-browser-alias",
        "enforce": "pre",
        "resolveId": function(id) {
            const [_, match] = filter.exec(id) ?? [];

            if (match !== undefined && (builtins ?? Object.keys(builtinsMap)).some((builtin) => id.startsWith(builtin))) {
                return NAMESPACE + id
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
