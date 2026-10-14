/**
 * silo — the join: what the part of a package that a workspace's code uses can reach. The bundler tree-shakes the
 * package's own files from just the members the code imports (`import { members } from spec`, `import D from spec`, or
 * the whole namespace when the use is dynamic), and `./detect` reads what's left. Other packages and builtins stay
 * outside (each package is its own baseline entry), so a slice is a package's own code only.
 *
 * Narrower than the whole package where the package is modular (ES modules, side-effect-free): a namespace of backends
 * of which the code uses one, a library whose command-line tool the code never reaches. A CommonJS package that exports
 * one object, or a pre-bundled one, comes out whole — and a slice that can't be built (a CommonJS re-export chain, say)
 * is undefined: the caller keeps the whole package's capabilities, the safe side.
 *
 * The bundler is passed in — rolldown's (Node) or `@rolldown/browser`'s (a worker) — and the files are the package's,
 * however they were read (node_modules, a tarball): pure apart from the bundler. Two traps it avoids: the platform is
 * `neutral` (a browser target replaces `process.env.NODE_ENV`, so env reads would vanish), and side effects are kept
 * (code a module runs as it loads still counts).
 */

import { isEntry } from "@brianjenkins94/util/env";
import { detect } from "./detect.js";

/** rolldown's `rolldown(options)`, loosely typed: the few calls below. */
// eslint-disable-next-line ts/no-explicit-any
export type Rolldown = (options: any) => Promise<{ "generate": (options: { "format": "es" }) => Promise<{ "output": { "code"?: string }[] }>; "close": () => Promise<void> }>;

/** A package manifest's entry for `subpath` (its exports' import / node / require / default, else module / main), as a
 *  path within the package. Undefined when its exports don't name the subpath. */
function entryOf(manifest: { "exports"?: unknown; "module"?: string; "main"?: string }, subpath = "."): string | undefined {
	const pick = (target: unknown): string | undefined => {
		if (typeof target === "string") {
			return target;
		}

		if (target === null || typeof target !== "object") {
			return undefined;
		}

		const conditions = target as Record<string, unknown>;

		return pick(conditions["import"]) ?? pick(conditions["node"]) ?? pick(conditions["require"]) ?? pick(conditions["default"]);
	};
	const { exports } = manifest;

	if (exports !== undefined && exports !== null) {
		const keyed = typeof exports === "object" && Object.keys(exports).some((key) => key.startsWith("."));
		const found = pick(keyed ? (exports as Record<string, unknown>)[subpath] : subpath === "." ? exports : undefined);

		if (found !== undefined || keyed) {
			return found?.replace(/^\.\//u, "");
		}
	}

	return subpath === "." ? (manifest.module ?? manifest.main ?? "index.js").replace(/^\.\//u, "") : undefined;
}

/** The file a relative specifier names within the package (with node's extension and index guesses). */
function within(files: ReadonlyMap<string, string>, from: string, specifier: string): string | undefined {
	const parts: string[] = [];

	for (const part of (from.slice(0, from.lastIndexOf("/") + 1) + specifier).split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "." && part !== "") {
			parts.push(part);
		}
	}

	const path = parts.join("/");

	return [path, path + ".js", path + ".mjs", path + ".cjs", path + "/index.js", path + "/index.mjs", path + "/index.cjs"].find((candidate) => files.has(candidate));
}

/**
 * What the slice of package `name` (its `files`, by path within the package) that `members` of `spec` reach can do —
 * `spec` is `name` or a subpath of it, `members` the names imported (`default` for a default import, `*` for the whole
 * namespace). Undefined when the slice can't be built: the whole package stands.
 */
export async function sliceCaps(rolldown: Rolldown, name: string, files: ReadonlyMap<string, string>, spec: string, members: readonly string[]): Promise<string[] | undefined> {
	let manifest: { "exports"?: unknown; "module"?: string; "main"?: string };

	try {
		manifest = JSON.parse(files.get("package.json") ?? "{}");
	} catch {
		return undefined;
	}

	const subpath = spec === name ? "." : "./" + spec.slice(name.length + 1);
	// (an exports map's subpath, else the file the subpath names, as node resolves it without one)
	const entry = entryOf(manifest, subpath) ?? (subpath === "." ? undefined : within(files, "", subpath));

	if (entry === undefined || !files.has(entry)) {
		return undefined;
	}

	const named = members.filter((member) => member !== "default" && member !== "*");
	const source = members.includes("*") || members.length === 0 ? `import * as M from ${JSON.stringify(spec)};\nconsole.log(M);` : [
		members.includes("default") ? `import D from ${JSON.stringify(spec)};\nconsole.log(D);` : "",
		named.length > 0 ? `import { ${named.join(", ")} } from ${JSON.stringify(spec)};\nconsole.log(${named.join(", ")});` : ""
	].join("\n");

	try {
		const bundle = await rolldown({
			"input": "\0entry",
			"cwd": "/",
			"platform": "neutral",
			"logLevel": "silent",
			"plugins": [{
				"name": "silo-slice",
				"resolveId": (specifier: string, importer?: string) => {
					if (specifier === "\0entry") {
						return specifier;
					}

					if (specifier === spec) {
						return "pkg:" + entry;
					}

					if ((specifier.startsWith("./") || specifier.startsWith("../")) && importer?.startsWith("pkg:") === true) {
						const found = within(files, importer.slice(4), specifier);

						return found === undefined ? { "id": specifier, "external": true } : "pkg:" + found;
					}

					return { "id": specifier, "external": true }; // a builtin, or another package (its own entry)
				},
				"load": (id: string) => {
					if (id === "\0entry") {
						return source;
					}

					return id.startsWith("pkg:") ? files.get(id.slice(4)) ?? "" : null;
				}
			}]
		});

		try {
			const { output } = await bundle.generate({ "format": "es" });

			return [...new Set(output.flatMap((chunk) => detect(chunk.code ?? "")))].sort();
		} finally {
			await bundle.close();
		}
	} catch {
		return undefined;
	}
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// rolldown (util's peer), in Node: the same API as `@rolldown/browser`'s. (A specifier made at run time, so a
		// bundler of this module doesn't follow it.)
		const { rolldown } = await import(/* @vite-ignore */ ["rolldown"].join("")) as { "rolldown": Rolldown };

		// A modular package: each member reaches only its own module's capability.
		const files = new Map([
			["package.json", JSON.stringify({ "name": "probe", "type": "module", "exports": { ".": "./index.js", "./ping": "./ping.js" } })],
			["index.js", "export { save } from \"./save.js\";\nexport { load } from \"./load.js\";\nexport { ping } from \"./ping.js\";\nexport default function env() { return process.env.HOME; }\n"],
			["save.js", "import { writeFileSync } from \"node:fs\";\nexport const save = (p, d) => writeFileSync(p, d);\n"],
			["load.js", "import { readFileSync } from \"node:fs\";\nexport const load = (p) => readFileSync(p, \"utf8\");\n"],
			["ping.js", "export const ping = (u) => fetch(u);\n"],
			["cli.js", "require(\"child_process\").execSync(\"rm -rf /\");\n"]
		]);
		const slice = async (spec: string, members: string[]): Promise<string[] | undefined> => sliceCaps(rolldown, "probe", files, spec, members);

		assert.deepEqual(await slice("probe", ["load"]), ["fs:read"]);
		assert.deepEqual(await slice("probe", ["save", "ping"]), ["fs:write", "net"]);
		assert.deepEqual(await slice("probe", ["default"]), ["env"], "a default import; process.env kept (a neutral platform)");
		assert.deepEqual(await slice("probe/ping", ["ping"]), ["net"], "a subpath, from its own entry");
		assert.deepEqual(await slice("probe", ["*"]), ["env", "fs:read", "fs:write", "net"], "the whole namespace — never the CLI no entry reaches");
		assert.equal(await slice("probe/missing", ["x"]), undefined, "a subpath the package doesn't have: no slice");
	})();
}
