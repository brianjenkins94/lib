import * as path from "node:path";
import * as url from "node:url";

/** This module's own file: from `import.meta.url` as an ES module, from `__filename` as CommonJS (a CommonJS bundle leaves
 *  `import.meta` empty). A bundle served over http has neither — its URL is no file — and nothing here touches `path`. */
const meta = (import.meta as Partial<ImportMeta> | undefined)?.url;
const ownFile = meta === undefined ? (typeof __filename === "string" ? __filename : undefined) : meta.startsWith("file:") ? url.fileURLToPath(meta) : undefined;

export const __root = ownFile === undefined ? "/" : path.join(path.dirname(ownFile), "..");

export const isWindows = process.platform === "win32";

export const isCI = Boolean(process.env["CI"]) === true;

// SOURCE: https://github.com/sinclairzx81/carbon/blob/main/src/runtime/runtime.mts

const isBun = ("self" in globalThis && "Bun" in globalThis.self) || "Bun" in globalThis;

const isDeno = ("self" in globalThis && "Deno" in globalThis.self) || "Deno" in globalThis;

const isNode = !isBun && ("self" in globalThis && "process" in globalThis.self) || "process" in globalThis;

export const isBrowser = !isBun && !isDeno && ("self" in globalThis && "addEventListener" in globalThis.self) || "window" in globalThis;

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
 * Bundled as CommonJS, `import.meta` arrives empty or undefined; then the module's file is the bundle's, which is this
 * module's own — so it says whether Node started the bundle, as it does for an ES module bundle.
 */
export function isEntry(meta?: { "url"?: string }): boolean {
	const entry = process.argv[1];
	const file = meta?.url ?? (ownFile === undefined ? undefined : url.pathToFileURL(ownFile).href);

	if (isBrowser || entry === undefined || file === undefined) {
		return false;
	}

	const fs = process.getBuiltinModule("node:fs");

	let real: string;

	try {
		real = fs.realpathSync(entry);
	} catch {
		return false;
	}

	return file === url.pathToFileURL(real).href;
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

		// As an ES module: util's root is the folder holding util/.
		assert.equal(__root, path.join(path.dirname(url.fileURLToPath(import.meta.url)), ".."));

		// This module is what Node started: by its import.meta, and — as a CommonJS bundle passes it — by an empty one.
		assert.equal(isEntry(import.meta), true);
		assert.equal(isEntry({}), true);
		assert.equal(isEntry(undefined), true);
		assert.equal(isEntry({ "url": "file:///x.js" }), false, "another module isn't the entry");
	})();
}
