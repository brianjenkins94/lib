import { __root } from "../util/env";
import { mapAsync } from "../util/array"
import { spawn } from "child_process";
import * as path from "path";
import * as url from "url";

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

    return Object.fromEntries(await mapAsync(workspaces, function(workspace) {
        return new Promise(function(resolve, reject) {
            const subprocess = spawn("npm", ["run", "--if-present", "build"], {
                "cwd": workspace,
                "shell": true,
                //"stdio": "inherit"
            });

            subprocess.on("close", function(code) {
                resolve([workspace, code]);
            });
        });
    }));
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).toString()) {
	await build();
}
