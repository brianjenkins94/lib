/**
 * silo — the `.silo/` location + file layout (Node, parser-free). Extracted from the prototype's `shared/paths.ts`.
 * Kept dependency-light (only `util/fs` and the pure `./layout`) so a consumer can keep the run ledger / baseline
 * without pulling the analysis (TypeScript's) — `./audit` (baseline + drift) and `./runs` (the ledger's Node side)
 * both build on this, and so can `util/mcp`.
 */

import * as path from "node:path";

import * as fs from "@brianjenkins94/util/fs";

import { baselinePath, GITATTRIBUTES, GITIGNORE, LOCAL_DIR, runsPath, withLines } from "./layout.js";

/** Resolve the silo root, git-`.git`-style. The nearest ancestor holding a `.silo/` is authoritative — you
 *  pick the scope by where you commit it (monorepo root → one baseline; sub-package → its own). If none
 *  exists yet, choose where to init: nearest workspace root (package.json `workspaces` / pnpm-workspace.yaml),
 *  else nearest package.json, else `start`. */
export function findRoot(start: string): string {
	const has = (name: string) => (d: string) => fs.existsSync(path.join(d, name));
	const isWorkspaceRoot = (d: string) => {
		if (fs.existsSync(path.join(d, "pnpm-workspace.yaml"))) { return true; }
		try { return Boolean(JSON.parse(fs.readFileSync(path.join(d, "package.json"))).workspaces); } catch { return false; }
	};

	return fs.closest(start, has(".silo")) ?? fs.closest(start, isWorkspaceRoot) ?? fs.closest(start, has("package.json")) ?? start;
}

/** The `.silo/` files a Node process uses, as absolute paths under `root` — what each is, and whether it's shared, is
 *  `./layout`'s. */
export interface SiloPaths { "root": string; "siloDir": string; "baseline": string; "runs": string; "localRuns": string }

export function siloPaths(root: string = findRoot(process.cwd())): SiloPaths {
	const at = (relative: string): string => path.join(root, ...relative.split("/"));

	return {
		"root": root,
		"siloDir": at(".silo"),
		"baseline": at(baselinePath()),
		"runs": path.dirname(at(runsPath("local"))),
		"localRuns": path.dirname(at(runsPath("local", "local")))
	};
}

/** `.silo/`'s two files, as the layout says them, made sure of once per process: `.gitignore` (`/local/` stays on this
 *  machine) and `.gitattributes` (line files merge by line). A person's own lines are kept; only what's missing is
 *  added, the same way the editor does it. */
const seeded = new Set<string>();

export async function ensureSiloDir(paths: SiloPaths): Promise<void> {
	if (seeded.has(paths.siloDir)) {
		return;
	}

	await fs.mkdir(path.join(paths.root, ...LOCAL_DIR.split("/")), { "recursive": true });

	for (const [name, wanted] of [[".gitignore", GITIGNORE], [".gitattributes", GITATTRIBUTES]] as const) {
		const file = path.join(paths.siloDir, name);
		const updated = withLines(fs.existsSync(file) ? fs.readFileSync(file) : "", wanted);

		if (updated !== undefined) {
			fs.writeFileSync(file, updated);
		}
	}

	seeded.add(paths.siloDir);
}
