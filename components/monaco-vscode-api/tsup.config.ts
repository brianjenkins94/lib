import { defineConfig } from "tsup";
import * as path from "path";
import * as url from "url";

import { importMetaUrl } from "../../util/esbuild/plugins"
import { virtualFileSystem } from "../../util/esbuild/plugins"
import { esbuildOptions } from "../../util/esbuild"
import * as fs from "../../util/fs"
import { mapAsync } from "../../util/array";

async function findParentPackageJson(directory) {
    if (fs.existsSync(path.join(directory, "package.json"))) {
        return path.join(directory, "package.json");
    } else {
        return findParentPackageJson(path.dirname(directory));
    }
}

async function manualChunks(chunkAliases: Record<string, string[]>) {
    return Object.fromEntries(await mapAsync(Object.entries(chunkAliases), async function([chunkAlias, modules]) {
        if (!fs.existsSync(path.join(chunksDirectory, chunkAlias + ".ts"))) {
            const dependencies = [...new Set((await mapAsync(modules, async function(module) {
                let modulePath;

                try {
                    modulePath = url.fileURLToPath(resolve(module, import.meta.url));
                } catch (error) {
                    modulePath = path.join(__dirname, "node_modules", module);

                    if (!fs.existsSync(modulePath)) {
                        return [];
                    }
                }

                const packageJsonPath = await findParentPackageJson(modulePath);

                const packageJson = await fs.readFile(packageJsonPath, { "encoding": "utf8" });

                return (await mapAsync(Object.keys(JSON.parse(packageJson).dependencies ?? {}), function(module) {
                    return new Promise(function(resolve, reject) {
                        resolve(path.join(path.dirname(packageJsonPath), "node_modules", module));
                    });
                })).filter(function(element) {
                    return fs.existsSync(element);
                });
            })))].flat(Infinity);

            await fs.writeFile(path.join(chunksDirectory, chunkAlias + ".ts"), dependencies.map(function(module) {
                return "import \"../" + path.relative(__dirname, module).replace(/\\/gu, "/") + "\";\n";
            }));
        }

        return [chunkAlias, path.join("chunks", chunkAlias + ".ts")];
    }));
}

export default defineConfig({
    "entry": {
        "main": "main.ts",
        ...await manualChunks({
            "monaco": ["./demo/src/main.ts"]
        }),
        "assets/editor.worker": "./demo/node_modules/vscode/workers/editor.worker.js",
        "assets/extensionHost.worker": "./demo/node_modules/vscode/vscode/src/vs/workbench/api/worker/extensionHostWorker.js"
    },
    "esbuildOptions": esbuildOptions({
        "nodePaths": ["./demo/node_modules/"]
    }),
    "esbuildPlugins": [
        virtualFileSystem(vfs),
        importMetaUrl()
    ],
    "external": [
        "fonts"
    ],
    "loader": {
        ".bin": "copy",
        ".map": "empty",
        ".svg": "dataurl",
        ".tmLanguage": "dataurl",
        ".wasm": "copy"
    }
});
