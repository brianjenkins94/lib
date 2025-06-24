import * as path from "path";
import * as url from "url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const __root = path.join(__dirname, "..");

export const isWindows = process.platform === "win32";

export const isCI = Boolean(process.env["CI"]) === true;

// SOURCE: https://github.com/sinclairzx81/carbon/blob/main/src/runtime/runtime.mts

const isBun = ('self' in globalThis && 'Bun' in globalThis.self) || 'Bun' in globalThis

const isDeno = ('self' in globalThis && 'Deno' in globalThis.self) || 'Deno' in globalThis

const isNode = !isBun && ('self' in globalThis && 'process' in globalThis.self) || 'process' in globalThis

export const isBrowser = !isBun && !isDeno && ('self' in globalThis && 'addEventListener' in globalThis.self) || 'window' in globalThis

export function getRuntime() {
    return isBrowser ? 'browser' : isBun ? 'bun' : isDeno ? 'deno' : isNode ? 'node' : 'unknown'
}
