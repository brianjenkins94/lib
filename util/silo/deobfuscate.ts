/**
 * silo — `deobfuscate`: recover analyzable code from a package that ships BUNDLED/minified dist. Extracted
 * from the `silo` prototype's `detect/deobfuscate.ts`.
 *
 * Many packages publish a pre-bundled `dist/` — esbuild's `__commonJS` lazy thunks (and minification) defeat
 * static reachability, so `./packages`' DCE silently DROPS caps (e.g. esbuild's own `exec`). This stage
 * un-thunks the ACTUAL shipped bundle so detection works. Two engines, UNION the result — they fail on
 * orthogonal axes: webcrack (de-obfuscation depth) and wakaru `--unpack=strict` (module-format breadth).
 * Source = the installed package (local-first). Sourcemaps are NOT used (forgeable; analyze what runs).
 */

import { createRequire } from "node:module";
import * as path from "node:path";

import { exec } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";
import { webcrack } from "webcrack";

// Resolve the wakaru CLI via real node resolution (walks up node_modules, so it works hoisted/published) —
// undefined when @wakaru/cli isn't installed, in which case deobfuscation degrades to webcrack alone.
let WAKARU: string | undefined;

try { WAKARU = createRequire(import.meta.url).resolve("@wakaru/cli/bin/wakaru"); } catch { WAKARU = undefined; }

/** Heuristic: does this look like a bundler artifact rather than authored source? */
export function isLikelyBundled(code: string): boolean {
	if (/__commonJS|__toESM|__require\b|__webpack_require__|System\.register\(|\bdefine\(\[/.test(code)) { return true; }
	const nl = (code.match(/\n/g) || []).length;

	return code.length > 2000 && code.length / (nl + 1) > 200;   // long average line = minified
}

/** Resolve a package's primary entry file, walking node_modules up from `fromDir` to `stopRoot`
 *  (workspace-local install wins over the hoisted root one). */
export async function resolveEntry(pkg: string, fromDir: string, stopRoot: string = fromDir): Promise<string | null> {
	for (let d = path.resolve(fromDir), stop = path.resolve(stopRoot); ; d = path.dirname(d)) {
		const dir = path.join(d, "node_modules", pkg);

		try {
			const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json")));
			const exp = pj.exports?.["."] ?? pj.exports;
			const ent = pj.module ?? (typeof exp === "object" ? exp.import ?? exp.default ?? exp.node : exp) ?? pj.main ?? "index.js";
			const f = path.join(dir, typeof ent === "string" ? ent : "index.js");

			if ((await fs.stat(f)).isFile()) { return f; }
		} catch { /* not here — keep walking up */ }

		if (d === stop || d === path.dirname(d)) { return null; }
	}
}

async function readAll(dir: string): Promise<string> {
	const parts = await Promise.all((await fs.readdir(dir, { "withFileTypes": true })).map(async (e) => {
		const p = path.join(dir, e.name);

		return e.isDirectory() ? await readAll(p) : e.name.endsWith(".js") ? fs.readFileSync(p) : "";
	}));

	return parts.join("\n");
}

/** Deobfuscate `entry` with both engines; return the recovered-code variants (caller detects + unions). */
export async function deobfuscate(entry: string, _root: string): Promise<string[]> {
	const code = fs.readFileSync(entry);
	const out: string[] = [];

	try { out.push((await webcrack(code)).code); } catch {}                       // webcrack: single un-thunked file
	if (WAKARU !== undefined) {
		const tmp = await fs.mkdtemp(path.join(fs.tmpdir(), "deob-wk-"));

		try {
			if ((await exec("node", [WAKARU, entry, "--unpack=strict", "-o", tmp])).ok) { out.push(await readAll(tmp)); }   // wakaru: structural unpack
		} catch {} finally { await fs.rm(tmp, { "recursive": true, "force": true }); }
	}

	return out.filter(Boolean);
}
