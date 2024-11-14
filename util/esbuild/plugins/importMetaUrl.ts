import { createHash } from "crypto";
import * as path from "path";
import JSON5 from "json5";
import polyfillNode from "node-stdlib-browser/helpers/esbuild/plugin"; // NOT "esbuild-plugins-node-modules-polyfill" NOR "esbuild-plugin-polyfill-node"
import stdLibBrowser from "node-stdlib-browser";

import * as fs from "../../fs";
import { esbuildOptions, tsup } from "../";

// Handle `new URL("./path/to/asset", import.meta.url)`

async function replaceAsync(regex, input, callback = async (execResults: RegExpExecArray) => Promise.resolve(execResults[1])) {
    regex = new RegExp(regex.source, [...new Set([...regex.flags, "d"])].join(""));

    const output = [];

    let index = input.length;
    let result;

    for (let origin = 0; result = regex.exec(input); origin = index) {
        index = result.indices[1][1] + 1;

        output.push(input.substring(origin, result.indices[1][0] - 1), await callback(result));
    }

    output.push(input.substring(index));

    return output.join("");
}

async function handleTypeScript(filePath, baseName) {
    const results = await tsup({
        "config": false,
        "entry": [filePath],
        "inject": [
            import.meta.resolve("node-stdlib-browser/helpers/esbuild/shim", import.meta.url)
        ],
        "define": {
            "Buffer": "Buffer"
        },
        "esbuildOptions": esbuildOptions({
            "write": false
        }),
        "esbuildPlugins": [
            polyfillNode(Object.fromEntries(["buffer", "crypto", "events", "os", "net", "path", "process", "stream", "util"].map(function(libName) {
                return [libName, stdLibBrowser[libName]];
            }))),
            importMetaUrl(__dirname)
        ],
        "external": ["vscode"], //[/^vscode.*/u],
        "format": "cjs",
        "platform": "browser"
    });

    console.log(results);

    const extension = path.extname(baseName);
    baseName = path.basename(baseName, extension);

    filePath = path.join(cacheDirectory, baseName + ".cjs");
    baseName += ".js";
}

export function importMetaUrl(__dirname) {
    const assetsDirectory = path.join(__dirname, "dist", "assets");

    return {
        "name": "import-meta-url",
        "setup": function(build) {
            // This is just for logging
            build.onLoad({ "filter": /.*/u }, async function({ "path": importer }) {
                const contents = await fs.readFile(importer);

                const workerRegEx = /worker(?:\.jsx?|\.tsx?)?(?:\?worker)?/u;

                if (workerRegEx.test(contents)) {
                    //console.log(importer);
                }
            });

            build.onLoad({ "filter": /.*/u }, async function({ "path": importer }) {
                let contents = await fs.readFile(importer);

                const newUrlRegEx = /new URL\((?:"|')(.*?)(?:"|'), \w+(?:\.\w+)*\)(?:\.\w+(?:\(\))?)?/gu;

                if (newUrlRegEx.test(contents)) {
                    // TODO: This whole function could use a review.
                    contents = await replaceAsync(newUrlRegEx, contents, async function([_, match]) {
                        let filePath = (await build.resolve(match, {
                            "kind": "import-statement",
                            "resolveDir": path.dirname(importer),
                        })).path;
                        let baseName = path.basename(filePath);

                        if (filePath.endsWith(".ts")) {
                            await handleTypeScript();
                        }

                        switch (true) {
                            case filePath.endsWith(".json"):
                                await fs.writeFile(filePath, JSON.stringify(JSON5.parse(await fs.readFile(filePath) || "{}"), undefined, "\t") + "\n");
                                break;
                            case filePath.endsWith(".mp3"):
                                return "\"data:audio/mpeg;base64,\"";
                            default:
                        }

                        console.log("new entrypoint?: " + path.relative(__dirname, filePath))

                        // Caching opportunity here:
                        const file = await fs.readFile(filePath);

                        const hash = createHash("sha256").update(file).digest("hex").substring(0, 6);

                        const extension = path.extname(baseName);
                        baseName = path.basename(baseName, extension);

                        baseName = baseName + "-" + hash + extension;

                        // Copy it to the assets directory
                        await fs.mkdir(assetsDirectory, { "recursive": true })
                        await fs.copyFile(filePath, path.join(assetsDirectory, baseName));

                        if (importer.endsWith(".ts")) {
                            return "\"./assets/" + baseName + "\"";
                        }

                        // So that we can refer to it by its unique name.
                        return "\"./" + baseName + "\"";
                    });

                    return {
                        "contents": contents,
                        "loader": path.extname(importer).substring(1)
                    };
                }
            });
        }
    }
}
