import * as path from "path";

import { virtualFileSystem } from "./"
import * as fs from "../../fs"
import { mapAsync, mapEntries } from "../../array";
import { __root } from "../../env"

async function findParentPackageJson(directory) {
    if (fs.existsSync(path.join(directory, "package.json"))) {
        return path.join(directory, "package.json");
    } else {
        return findParentPackageJson(path.dirname(directory));
    }
}

export async function manualChunks(options, __dirname) {
    const chunkAliases: Record<string, string[]> = options.entry;

    const files = {};

    const entry = await mapEntries(chunkAliases, async function([chunkAlias, modules]) {
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

            packageJsonPath = await findParentPackageJson(path.dirname(modulePath));

            const packageJson = await fs.readFile(packageJsonPath);

            return (await mapAsync(Object.keys(JSON.parse(packageJson).dependencies ?? {}), function(module) {
                return new Promise(function(resolve, reject) {
                    resolve(path.join(path.dirname(packageJsonPath), "node_modules", module));
                });
            }, function(element) {
                return fs.existsSync(element);
            }));
        })))].flat(Infinity);

        files[modules[0]] = dependencies.map(function(module) {
            return "import \"./" + path.relative(path.dirname(packageJsonPath), module).replace(/\\/gu, "/") + "\";";
        }).join("\n");

        return [chunkAlias, path.relative(__root, packageJsonPath)];
    });

    return {
        ...options,
        "entry": {
            ...options.entry,
            ...entry
        },
        "esbuildPlugins": [
            virtualFileSystem(files),
            ...options.esbuildPlugins
        ]
    }
}
