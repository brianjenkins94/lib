import { mapAsync, partition } from "../array";
import { spawn } from "child_process";
import { realpathSync } from "fs";
import * as path from "path";
import * as url from "url";

/**
 * Build every git-tracked workspace by running its own `build` script. Library packages under
 * `packages/` build to completion first, so dependents (apps) can consume their built dist.
 * Returns a `{ workspace: exitCode }` map.
 */
export async function build(workspaces?) {
    workspaces ??= (await new Promise<string[]>(function(resolve, reject) {
        const gitLs = spawn("sh", ["-c", "git ls-files */package.json */*/package.json"]);

        const chunks = []

        gitLs.stdout.on("data", function(chunk) {
            chunks.push(chunk)
        })

        gitLs.on("close", function() {
            resolve(Buffer.concat(chunks).toString().trim().split("\n"));
        })
    })).map(path.dirname);

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
