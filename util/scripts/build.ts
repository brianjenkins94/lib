import { isEntry } from "@brianjenkins94/util/env";
import { mapAsync, partition } from "@brianjenkins94/util/array";
import { exec } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";

/**
 * Build every git-tracked workspace by running its own `build` script. Library packages under
 * `packages/` build to completion first, so dependents (apps) can consume their built dist.
 * Private workspaces build too: `private` means "not published to the registry" (util-publish honours
 * it), NOT "not built" — a private, deployable app (e.g. a Pages workbench) still needs building.
 * Returns a `{ workspace: exitCode }` map.
 */
export async function build(workspaces?: string[]) {
	workspaces ??= (await fs.findWorkspaces()).map((workspace) => workspace.dir);

	// exec auto-shells `pnpm` (a .cmd shim) on Windows and — unlike the old hand-rolled Promise — rejects if
	// pnpm can't be spawned at all, instead of hanging forever.
	async function buildOne(workspace: string): Promise<[string, number]> {
		return [workspace, (await exec("pnpm", ["--ignore-workspace", "run", "--if-present", "build"], { "cwd": workspace })).exitCode];
	}

	const [packages, rest] = partition(workspaces, (workspace) => workspace.split("/")[0] === "packages");

	const packageResults = await mapAsync(packages, buildOne);
	const restResults = await mapAsync(rest, buildOne);

	return Object.fromEntries([...packageResults, ...restResults]);
}

if (isEntry(import.meta)) {
	await build();
}
