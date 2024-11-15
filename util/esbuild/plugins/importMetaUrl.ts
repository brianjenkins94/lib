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

export function importMetaUrl(callback) {
    return async function(args): Promise<OnLoadResult> {
        let contents = await fs.readFile(args.path);

        const newUrlRegEx = /new URL\((?:"|')(.*?)(?:"|'), \w+(?:\.\w+)*\)(?:\.\w+(?:\(\))?)?/gu;

        if (newUrlRegEx.test(contents)) {
            contents = await replaceAsync(newUrlRegEx, contents, function([_, match]) {
                return callback(match, args);
            });

            return {
                "contents": contents,
                "loader": path.extname(args.path).substring(1) as OnLoadResult["loader"]
            };
        }
    };
}
