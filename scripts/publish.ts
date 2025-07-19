import { __root } from "../util/env";
import { mapAsync, mapEntries } from "../util/array"
import { spawn } from "child_process";
import { tsup } from "../util/esbuild"
import * as fs from "../util/fs";
import * as path from "path";
import * as url from "url"

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

const configs = await mapAsync(workspaces, async function(workspace) {
    if (!fs.existsSync(path.join(workspace, "package.json"))) {
        return;
    }

    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json")));

    // TODO: Find all TypeScript files and build them, adding files and exports to the package.json, or should that be a part of publish?
    /*
    if (packageJson["exports"] === undefined) {
        return;
    }
    */

    let customConfig = {
        "entry": {}
    };

    if (fs.existsSync(path.join(workspace, "tsup.config.ts"))) {
        customConfig = {
            ...customConfig,
            ...(await import(url.pathToFileURL(path.join(workspace, "tsup.config.ts")).toString()))["default"]
        };
    }

    customConfig["entry"] = {
        ...customConfig["entry"],
        ...mapEntries(packageJson["exports"], function([exportName, sourceFile]) {
            return [path.basename(exportName) === "." ? path.basename(sourceFile, path.extname(sourceFile)) : path.basename(exportName), "./" + path.join(workspace, sourceFile)];
        })
    }

    return {
        "format": "esm",
        "treeshake": true,
        ...customConfig
    }
}, Boolean);

await mapAsync(configs, tsup);
