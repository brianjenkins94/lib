import { __root } from "../util/env";
import { mapAsync } from "../util/array"
import { spawn } from "child_process";
import * as path from "path";

const gitLs = spawn("sh", ["-c", "git ls-files */package.json */*/package.json"]);

const workspaces = (await new Promise<string[]>(function(resolve, reject) {
    const chunks = []

    gitLs.stdout.on("data", function(chunk) {
        chunks.push(chunk)
    })

    gitLs.on("close", function() {
        resolve(Buffer.concat(chunks).toString().trim().split("\n"));
    })
})).map(path.dirname);

await mapAsync(workspaces, function(workspace) {
    return new Promise(function(resolve, reject) {
        // FROM: https://github.com/vercel/turborepo/blob/1ae620cdf454d0258a162a96976e3064433391a2/packages/turbo/bin/turbo#L29
        const subprocess = spawn("npm", ["install", "--loglevel=error", "--prefer-offline", "--no-audit", "--progress=false"], {
            "cwd": workspace,
            "shell": true,
            //"stdio": "inherit"
        });

        subprocess.on("close", function(code) {
            subprocess.unref()

            resolve(code);
        })
    })
});
