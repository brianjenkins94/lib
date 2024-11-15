import type { OnLoadResult } from "esbuild";
import * as path from "path";
import polyfillNode from "node-stdlib-browser/helpers/esbuild/plugin"; // NOT "esbuild-plugins-node-modules-polyfill" NOR "esbuild-plugin-polyfill-node"
import stdLibBrowser from "node-stdlib-browser";
import { createHash } from "crypto";
import JSON5 from "json5";

import * as fs from "../../fs";
import { esbuildOptions, tsup } from "../";
import { mapEntries } from "../../array";
import { replaceAsync } from "../../text";

// Handle `new URL("./path/to/asset", import.meta.url)`

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
            polyfillNode(mapEntries(["buffer", "crypto", "events", "os", "net", "path", "process", "stream", "util"], function(libName) {
                return [libName, stdLibBrowser[libName]];
            }))
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

export function importMetaUrl(callbackOrDirName?) {
    if (typeof callbackOrDirName === "function") {
        return async function(args): Promise<OnLoadResult> {
            let contents = await fs.readFile(args.path);

            const newUrlRegEx = /new URL\((?:"|')(.*?)(?:"|'), \w+(?:\.\w+)*\)(?:\.\w+(?:\(\))?)?/gu;

            if (newUrlRegEx.test(contents)) {
                // TODO: This whole function could use a review.
                contents = await replaceAsync(newUrlRegEx, contents, function([_, match]) {
                    return callbackOrDirName(match, args);
                });

                return {
                    "contents": contents,
                    "loader": path.extname(args.path).substring(1) as OnLoadResult["loader"]
                };
            }
        };
    }

    const assetsDirectory = path.join(callbackOrDirName, "dist", "assets");

    return {
        "name": "import-meta-url",
        "setup": function(build) {
            build.onLoad({ "filter": /.*/u }, async function(args) {
                let contents = await fs.readFile(args.path);

                const newUrlRegEx = /new URL\((?:"|')(.*?)(?:"|'), \w+(?:\.\w+)*\)(?:\.\w+(?:\(\))?)?/gu;

                if (newUrlRegEx.test(contents)) {
                    contents = await replaceAsync(newUrlRegEx, contents, async function([_, match]) {
                        let filePath = (await build.resolve(match, {
                            "kind": "import-statement",
                            "resolveDir": path.dirname(args.path),
                        })).path;
                        let baseName = path.basename(filePath);

                        if (filePath.endsWith(".ts")) {
                            [filePath, baseName] = await handleTypeScript(filePath, baseName);
                        }

                        switch (true) {
                            case filePath.endsWith(".json"):
                                await fs.writeFile(filePath, JSON.stringify(JSON5.parse(await fs.readFile(filePath) || "{}"), undefined, "\t") + "\n");
                                break;
                            case filePath.endsWith(".mp3"):
                                return "\"data:audio/mpeg;base64,\"";
                            default:
                        }

                        // Caching opportunity here:
                        const file = await fs.readFile(filePath);

                        const hash = createHash("sha256").update(file).digest("hex").substring(0, 6);

                        const extension = path.extname(baseName);
                        baseName = path.basename(baseName, extension);

                        baseName = baseName + "-" + hash + extension;

                        // Copy it to the assets directory
                        await fs.mkdir(assetsDirectory, { "recursive": true })
                        await fs.copyFile(filePath, path.join(assetsDirectory, baseName));

                        if (args.path.endsWith(".ts")) {
                            return "\"./assets/" + baseName + "\"";
                        }

                        // So that we can refer to it by its unique name.
                        return "\"./" + baseName + "\"";
                    });

                    return {
                        "contents": contents,
                        "loader": path.extname(args.path).substring(1)
                    };
                }
            });
        }
    }
}
