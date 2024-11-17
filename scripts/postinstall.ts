import * as path from "path";
import * as fs from "../util/fs";
import { __root } from "../util/env";
import { spawn } from "child_process";
import { mapAsync, series, mapEntries } from "../util/array"
import * as url from "url"
import { tsup } from "../util/esbuild"

const gitLs = spawn("git", ["ls-files", "\"**/package.json\""], {
    "shell": true
})

const workspaces = (await new Promise<string[]>(function(resolve, reject) {
    const buffer = []

    gitLs.stdout.on("data", function(chunk) {
        buffer.push(chunk)
    })

    gitLs.on("close", function() {
        resolve(Buffer.concat(buffer).toString("utf8").trim().split("\n"));
    })
})).map(path.dirname)

await Promise.all(workspaces.map(function(workspace) {
    return series([
        () => new Promise(function(resolve, reject) {
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
        }),
        () => new Promise(function(resolve, reject) {
            const subprocess = spawn("npm", ["run", "build"], {
                "cwd": workspace,
                "shell": true,
                //"stdio": "inherit"
            });

            subprocess.on("close", function(code) {
                subprocess.unref()

                resolve(code);
            })
        }),
    ])
}))

const defaultConfig = {
    "format": "esm",
    "treeshake": true
};

const configs = await mapAsync(workspaces, async function(workspace) {
    if (!fs.existsSync(path.join(workspace, "package.json"))) {
        return;
    }

    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json")));

    if (packageJson["exports"] === undefined) {
        return;
    }

    let customConfig = {
        "entry": {}
    };

    if (fs.existsSync(path.join(workspace, "tsup.config.ts"))) {
        customConfig = {
            ...customConfig,
            ...(await import(url.pathToFileURL(path.join("./" + workspace, "tsup.config.ts")).toString()))["default"]
        };
    }

    customConfig["entry"] = {
        ...customConfig["entry"],
        ...mapEntries(packageJson["exports"], function([exportName, sourceFile]) {
            return [path.basename(exportName) === "." ? path.basename(sourceFile, path.extname(sourceFile)) : path.basename(exportName), "./" + path.join(workspace, sourceFile)];
        })
    }

    return {
        ...defaultConfig,
        ...customConfig
    }
}, Boolean);

await mapAsync(configs, tsup);
