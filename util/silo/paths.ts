/**
 * silo — the `.silo/` location + file layout (Node, oxc-free). Extracted from the prototype's `shared/paths.ts`.
 * Kept dependency-light (only `util/fs` and the pure `./evidence`) so a consumer can keep the run ledger / baseline
 * without pulling the oxc-based analysis kernels — `./audit` (baseline + drift) and `./runs` (the ledger's Node side)
 * both build on this, and so can `util/mcp`.
 */

import * as path from "node:path";

import * as fs from "@brianjenkins94/util/fs";

import { GITATTRIBUTES, GITIGNORE } from "./evidence.js";

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

/** The `.silo/` file layout for a project root. `baseline.json` + `review.json` are the committed contract. The run
 *  ledger (`./evidence`: one envelope per run, a file per user) is `runs/` for shared runs, committed so they travel
 *  with the repo, and `local/runs/` for runs kept on this machine. `registry.json` (per-unit approved scopes/caps) is
 *  local trust state — one person's grant isn't another's — gitignored by `ensureSiloDir`. */
export interface SiloPaths { "root": string; "siloDir": string; "baseline": string; "review": string; "runs": string; "localRuns": string; "registry": string }

export function siloPaths(root: string = findRoot(process.cwd())): SiloPaths {
	const siloDir = path.join(root, ".silo");

	return {
		"root": root,
		"siloDir": siloDir,
		"baseline": path.join(siloDir, "baseline.json"),
		"review": path.join(siloDir, "review.json"),
		"runs": path.join(siloDir, "runs"),
		"localRuns": path.join(siloDir, "local", "runs"),
		"registry": path.join(siloDir, "registry.json")
	};
}

/** Create `.silo/` lazily, with the same two files the editor gives it (`./evidence`): `.gitignore` (`local/` stays on
 *  this machine, and so do the prototype's derived files) and `.gitattributes` (its JSONL merges by line). */
export async function ensureSiloDir(paths: SiloPaths): Promise<void> {
	if (!fs.existsSync(paths.siloDir)) {
		await fs.mkdir(paths.siloDir, { "recursive": true });
		fs.writeFileSync(path.join(paths.siloDir, ".gitignore"), GITIGNORE + "registry.json\nfingerprints.json\neslintcache\npending-review.json\n");
		fs.writeFileSync(path.join(paths.siloDir, ".gitattributes"), GITATTRIBUTES);
	}
}
