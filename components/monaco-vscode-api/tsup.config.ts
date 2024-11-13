import { defineConfig } from "tsup";
import * as path from "path";
import * as url from "url";

import { importMetaUrl } from "../../util/esbuild/plugins"
import { virtualFileSystem } from "../../util/esbuild/plugins"
import { esbuildOptions } from "../../util/esbuild"
import * as fs from "../../util/fs"
import { mapAsync } from "../../util/array";
import { __root } from "../../util/env"

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function findParentPackageJson(directory) {
    if (fs.existsSync(path.join(directory, "package.json"))) {
        return path.join(directory, "package.json");
    } else {
        return findParentPackageJson(path.dirname(directory));
    }
}

const files = {};

async function manualChunks(chunkAliases: Record<string, string[]>) {
    return Object.fromEntries(await mapAsync(Object.entries(chunkAliases), async function([chunkAlias, modules]) {
        let packageJsonPath;

        const dependencies = [...new Set((await mapAsync(modules, async function(module) {
            let modulePath;

            try {
                modulePath = import.meta.resolve(path.join(__dirname, module), import.meta.url);
            } catch (error) {
                modulePath = path.join(__dirname, "node_modules", module);

                if (!fs.existsSync(modulePath)) {
                    return [];
                }
            }

            packageJsonPath = await findParentPackageJson(modulePath);

            const packageJson = await fs.readFile(packageJsonPath);

            return (await mapAsync(Object.keys(JSON.parse(packageJson).dependencies ?? {}), function(module) {
                return new Promise(function(resolve, reject) {
                    resolve(path.join(path.dirname(packageJsonPath), "node_modules", module));
                });
            })).filter(function(element) {
                return fs.existsSync(element);
            });
        })))].flat(Infinity);

        files[modules[0]] = dependencies.map(function(module) {
            return "import \"./" + path.relative(path.dirname(packageJsonPath), module).replace(/\\/gu, "/") + "\";";
        }).join("\n");

        return [chunkAlias, path.relative(__root, packageJsonPath)];
    }));
}

export default defineConfig({
    "entry": {
        ...await manualChunks({
            "monaco": ["demo/package.json"]
        })
    },
    "esbuildOptions": esbuildOptions({
        "nodePaths": ["./demo/node_modules/"]
    }),
    "esbuildPlugins": [
        virtualFileSystem(files, __dirname),
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
