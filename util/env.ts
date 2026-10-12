import * as path from "node:path";
import * as url from "node:url";

// SOURCE: https://github.com/sinclairzx81/carbon/blob/main/src/runtime/runtime.mts

const isBun = ("self" in globalThis && "Bun" in globalThis.self) || "Bun" in globalThis;

const isDeno = ("self" in globalThis && "Deno" in globalThis.self) || "Deno" in globalThis;

const isNode = !isBun && ("self" in globalThis && "process" in globalThis.self) || "process" in globalThis;

export const isBrowser = !isBun && !isDeno && ("self" in globalThis && "addEventListener" in globalThis.self) || "window" in globalThis;

/**
 * This module's own file, however it's loaded: from `import.meta.url` as an ES module, from CommonJS's `__filename` as a
 * Node CommonJS module. A browser bundle (ES module or CommonJS — the editor's extensions) has no file of its own, and
 * this module must still load there: nothing here may assume `import.meta.url`, a file system or `process`.
 */
function moduleFile(): string | undefined {
	if (isBrowser) {
		return undefined;
	}

	const meta = (import.meta as Partial<ImportMeta>).url; // undefined once bundled as CommonJS

	if (typeof meta === "string") {
		return meta.startsWith("file:") ? url.fileURLToPath(meta) : meta;
	}

	return typeof __filename === "string" ? __filename : undefined;
}

const ownFile = moduleFile();

/** util's root folder (the one holding `util/`) — `/` where there's no file system (a browser bundle). */
export const __root = ownFile === undefined ? "/" : path.join(path.dirname(ownFile), "..");

export const isWindows = globalThis.process?.platform === "win32";

export const isCI = Boolean(globalThis.process?.env?.["CI"]) === true;

export function getRuntime() {
	return isBrowser ? "browser" : isBun ? "bun" : isDeno ? "deno" : isNode ? "node" : "unknown";
}

/**
 * Is `meta` (pass `import.meta`) the module Node was started with? The run-guard for a file that is both
 * importable and a CLI: `if (isEntry(import.meta)) { … }`. argv[1] is realpath'd so a bin symlink
 * (`node_modules/.bin/util-serve`) matches its target; a non-file entry (`node -e`, a REPL) is never the
 * entry. `node:fs` comes via `getBuiltinModule` rather than a static import so this module stays
 * bundleable for the browser (fido pulls `isBrowser` from here).
 *
 * Bundled as CommonJS, `import.meta` arrives empty or undefined. Then the module's file is the bundle's — every module in
 * a bundle shares it, as they share `import.meta.url` in an ES module bundle — which is this module's own: so it asks
 * whether the bundle is what Node was started with. In a browser, nothing is.
 */
export function isEntry(meta?: { "url"?: string }): boolean {
	const entry = isBrowser ? undefined : globalThis.process?.argv?.[1];
	const file = meta?.url ?? (ownFile === undefined ? undefined : url.pathToFileURL(ownFile).href);

	if (entry === undefined || file === undefined) {
		return false;
	}

	const fs = globalThis.process.getBuiltinModule("node:fs");

	let real: string;

	try {
		real = fs.realpathSync(entry);
	} catch {
		return false;
	}

	return file === url.pathToFileURL(real).href;
}
