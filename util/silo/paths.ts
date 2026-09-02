/**
 * silo — the `.silo/` location + file layout (Node, oxc-free). Extracted from the prototype's `shared/paths.ts`.
 * Kept dependency-light (only `util/fs`) so a consumer can maintain the run ledger / baseline without pulling
 * the oxc-based analysis kernels — `./audit` (baseline + drift) and `./runs` (ledger + confidence) both build
 * on this, and so can `util/mcp`.
 */

import * as path from "node:path";

import * as fs from "@brianjenkins94/util/fs";

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

/** The `.silo/` file layout for a project root. `baseline.json` + `review.json` are the COMMITTED contract;
 *  `runs.jsonl` (the run ledger) + `registry.json` (per-unit approved scopes/caps) are LOCAL, derived trust
 *  state — gitignored by `ensureSiloDir`, read/written by `./runs`. A consumer is free to un-gitignore them. */
export interface SiloPaths { "root": string; "siloDir": string; "baseline": string; "review": string; "ledger": string; "registry": string }

export function siloPaths(root: string = findRoot(process.cwd())): SiloPaths {
	const siloDir = path.join(root, ".silo");

	return {
		"root": root,
		"siloDir": siloDir,
		"baseline": path.join(siloDir, "baseline.json"),
		"review": path.join(siloDir, "review.json"),
		"ledger": path.join(siloDir, "runs.jsonl"),
		"registry": path.join(siloDir, "registry.json")
	};
}

/** Create `.silo/` lazily and seed its gitignore (only baseline.json + review.json are committed by default;
 *  the derived trust state is ignored — a consumer can override that file to commit run history if they want). */
export async function ensureSiloDir(paths: SiloPaths): Promise<void> {
	if (!fs.existsSync(paths.siloDir)) {
		await fs.mkdir(paths.siloDir, { "recursive": true });
		fs.writeFileSync(path.join(paths.siloDir, ".gitignore"), "registry.json\nruns.jsonl\nfingerprints.json\neslintcache\npending-review.json\n");
	}
}
