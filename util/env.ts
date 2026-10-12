import * as path from "node:path";
import * as url from "node:url";

// Import-safe in a browser with no polyfills (juvy and fido import this): node:path and node:url are used only when the
// module is loaded from a file, and `process` is read through globalThis.
const fromFile = import.meta.url.startsWith("file:");

export const __root = fromFile ? path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..") : new URL("..", import.meta.url).href;

export const isWindows = (globalThis as { "process"?: { "platform"?: string } }).process?.platform === "win32";

export const isCI = Boolean((globalThis as { "process"?: { "env"?: Record<string, string | undefined> } }).process?.env?.["CI"]);

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
	// (In a browser there's no entry — and no `process` to ask; modules ask this at load.)
	const entry = isBrowser ? undefined : (globalThis as { "process"?: { "argv"?: string[] } }).process?.argv?.[1];

	if (entry === undefined) {
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
