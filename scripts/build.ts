import { __root } from "../util/env";
import { mapAsync } from "../util/array"
import { spawn } from "child_process";
import * as path from "path";

const gitLs = spawn("git", ["ls-files", "\"**/package.json\""], {
    "shell": true
});

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
        const subprocess = spawn("npm", ["run", "build", "--if-present"], {
            "cwd": workspace,
            "shell": true,
            //"stdio": "inherit"
        });

        subprocess.on("close", function(code) {
            subprocess.unref()

            resolve(code);
        });
    });
});
