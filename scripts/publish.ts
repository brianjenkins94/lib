import { __root } from "../util/env";
import { mapAsync, mapEntries } from "../util/array"
import { tsup } from "../util/esbuild"
import * as fs from "../util/fs";
import * as path from "path";
import * as url from "url"
import { build } from "./build";

const workspaces = Object.entries(await build(process.argv.length > 2 ? process.argv.slice(2) : undefined)).filter(([key, value]) => value === 0).map(([key]) => key);

const configs = await mapAsync(workspaces, async function(workspace) {
    if (!fs.existsSync(path.join(workspace, "package.json"))) {
        return;
    }

    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json")));

    // TODO: Find all TypeScript files and build them, adding files and exports to the package.json
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
