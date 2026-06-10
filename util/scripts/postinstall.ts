import { mapAsync } from "../array";
import { spawn } from "child_process";
import { realpathSync } from "fs";
import * as path from "path";
import * as url from "url";

/**
 * Install every git-tracked workspace (pnpm `--ignore-workspace`, falling back to npm), so each
 * sub-package's own dependencies and install lifecycle run. Used as the repo's `postinstall`.
 */
export async function postinstall(workspaces?) {
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

    return await mapAsync(workspaces, function(workspace) {
        return new Promise(function(resolve, reject) {
            const subprocess = spawn("pnpm", ["--ignore-workspace", "install"], {
                "cwd": workspace,
                "shell": true,
                //"stdio": "inherit"
            });

            subprocess.on("close", function(code) {
                if (code !== 0) {
                    // FROM: https://github.com/vercel/turborepo/blob/1ae620cdf454d0258a162a96976e3064433391a2/packages/turbo/bin/turbo#L29
                    const subprocess = spawn("npm", ["install", "--loglevel=error", "--prefer-offline", "--no-audit", "--progress=false"], {
                        "cwd": workspace,
                        "shell": true,
                        //"stdio": "inherit"
                    });

                    subprocess.on("close", function(code) {
                        resolve(code);
                    });
                } else {
                    resolve(code);
                }
            })
        })
    });
}

if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(realpathSync(process.argv[1])).toString()) {
    await postinstall();
}
