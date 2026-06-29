import { mapAsync, partition } from "../array";
import { findWorkspaces } from "../fs";
import { spawn } from "child_process";
import { realpathSync } from "fs";
import * as url from "url";

/**
 * Build every git-tracked workspace by running its own `build` script. Library packages under
 * `packages/` build to completion first, so dependents (apps) can consume their built dist.
 * Private workspaces are skipped (they self-manage — see `findWorkspaces()`). Returns a
 * `{ workspace: exitCode }` map.
 */
export async function build(workspaces?: string[]) {
    workspaces ??= (await findWorkspaces()).filter((workspace) => !workspace.private).map((workspace) => workspace.dir);

    function buildOne(workspace) {
        return new Promise(function(resolve, reject) {
            const subprocess = spawn("pnpm", ["--ignore-workspace", "run", "--if-present", "build"], {
                "cwd": workspace,
                "shell": true,
                //"stdio": "inherit"
            });

            subprocess.on("close", function(code) {
                resolve([workspace, code]);
            });
        });
    }

    const [packages, rest] = partition(workspaces, (workspace) => workspace.split("/")[0] === "packages");

    const packageResults = await mapAsync(packages, buildOne);
    const restResults = await mapAsync(rest, buildOne);

    return Object.fromEntries([...packageResults, ...restResults]);
}

if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(realpathSync(process.argv[1])).toString()) {
	await build();
}
