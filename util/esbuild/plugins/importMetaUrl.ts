import { createHash } from "crypto";
import * as url from "url";
import * as path from "path";
import JSON5 from "json5";
import polyfillNode from "node-stdlib-browser/helpers/esbuild/plugin"; // NOT "esbuild-plugins-node-modules-polyfill" OR "esbuild-plugin-polyfill-node"
import stdLibBrowser from "node-stdlib-browser";

import * as fs from "../../fs";
import { tsup } from "../";

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

export function importMetaUrl(options = {}) {
    return {
        "name": "import-meta-url",
        "setup": function(build) {
            build.onLoad({ "filter": /.*/u }, async function({ "path": importer }) {
                const contents = await fs.readFile(importer, { "encoding": "utf8" });

                const workerRegEx = /worker(?:\.jsx?|\.tsx?)?(?:\?worker)?/u;

                if (workerRegEx.test(contents)) {
                    console.log(importer);
                }
            });

            build.onLoad({ "filter": /.*/u }, async function({ "path": importer }) {
                let contents = await fs.readFile(importer, { "encoding": "utf8" });

                const newUrlRegEx = /new URL\((?:"|')(.*?)(?:"|'), \w+(?:\.\w+)*\)(?:\.\w+(?:\(\))?)?/gu;

                if (newUrlRegEx.test(contents)) {
                    // TODO: This whole function could use a review.
                    contents = await replaceAsync(newUrlRegEx, contents, async function([_, match]) {
                        let filePath = path.join(path.dirname(importer), match);
                        let baseName = path.basename(filePath);

                        if (filePath.endsWith(".ts")) {
                            console.log(importer);

                            await tsup({
                                "config": false,
                                "entry": [filePath],
                                "inject": [
                                    url.fileURLToPath(import.meta.resolve("node-stdlib-browser/helpers/esbuild/shim"))
                                ],
                                "define": {
                                    "Buffer": "Buffer"
                                },
                                "esbuildPlugins": [
                                    // These plugins don't appear to be order-sensitive.
                                    polyfillNode(Object.fromEntries(["buffer", "crypto", "events", "os", "net", "path", "process", "stream", "util"].map(function(libName) {
                                        return [libName, stdLibBrowser[libName]];
                                    }))),
                                    importMetaUrl()
                                ],
                                "external": ["vscode"], //[/^vscode.*/u],
                                "format": "cjs",
                                "outDir": cacheDirectory,
                                "platform": "browser"
                            });

                            const extension = path.extname(baseName);
                            baseName = path.basename(baseName, extension);

                            filePath = path.join(cacheDirectory, baseName + ".cjs");
                            baseName += ".js";
                        }

                        // TODO: Improve
                        if (!fs.existsSync(filePath)) {
                            const fallbackPaths = [
                                path.join(__dirname, "demo", "node_modules", match),
                                path.join(__dirname, "demo", "node_modules", match + ".js"),
                                path.join(__dirname, "demo", "node_modules", "vscode", match)
                            ];

                            for (const fallbackPath of fallbackPaths) {
                                if (fs.existsSync(fallbackPath)) {
                                    filePath = fallbackPath;
                                    baseName = path.basename(filePath);

                                    break;
                                }
                            }
                        }

                        switch (true) {
                            case filePath.endsWith(".code-snippets"):
                                baseName += ".json";
                                break;
                            case filePath.endsWith(".json"):
                                await fs.writeFile(filePath, JSON.stringify(JSON5.parse(await fs.readFile(filePath, { "encoding": "utf8" }) || "{}"), undefined, "\t") + "\n");
                                break;
                            case filePath.endsWith(".mp3"):
                                return "\"data:audio/mpeg;base64,\"";
                            case filePath.endsWith(".html"):
                            case filePath.endsWith(".tmLanguage"):
                            case filePath.endsWith(".woff"):
                                await fs.copyFile(filePath, path.join(assetsDirectory, baseName));

                                return "\"./" + baseName + "\"";
                            default:
                        }

                        // Caching opportunity here:
                        const file = await fs.readFile(filePath);

                        const hash = createHash("sha256").update(file).digest("hex").substring(0, 6);

                        const extension = path.extname(baseName);
                        baseName = path.basename(baseName, extension);

                        baseName = baseName + "-" + hash + extension;

                        // Copy it to the assets directory
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
