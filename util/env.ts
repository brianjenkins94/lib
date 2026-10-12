import * as path from "node:path";
import * as url from "node:url";

const __filename = import.meta.url.startsWith("file:") ? url.fileURLToPath(import.meta.url) : import.meta.url;
const __dirname = path.dirname(__filename);

export const __root = path.join(__dirname, "..");

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
 */
export function isEntry(meta: { "url": string }): boolean {
	const entry = process.argv[1];

	if (isBrowser || entry === undefined) {
		return false;
	}

	const fs = process.getBuiltinModule("node:fs");

	let real: string;

	try {
		real = fs.realpathSync(entry);
	} catch {
		return false;
	}

	return meta.url === url.pathToFileURL(real).href;
}
