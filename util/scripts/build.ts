import * as url from "node:url";
import { mapAsync, partition } from "@brianjenkins94/util/array";
import { exec } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";

/**
 * Build every git-tracked workspace by running its own `build` script. Library packages under
 * `packages/` build to completion first, so dependents (apps) can consume their built dist.
 * Private workspaces are skipped (they self-manage — see `findWorkspaces()`). Returns a
 * `{ workspace: exitCode }` map.
 */
export async function build(workspaces?: string[]) {
	workspaces ??= (await fs.findWorkspaces()).filter((workspace) => !workspace.private).map((workspace) => workspace.dir);

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

if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(await fs.realpath(process.argv[1])).toString()) {
	await build();
}
