import type { OnLoadResult } from "esbuild";
import * as path from "path";

import * as fs from "../../fs";
import { replaceAsync } from "../../text";

// Handle `new URL("./path/to/asset", import.meta.url)`

export function importMetaUrl(callbackOrFiles) {
    return async function(args): Promise<OnLoadResult> {
        let contents = await fs.readFile(args.path);

        const newUrlRegEx = /new URL\((?:"|')(.*?)(?:"|'), \w+(?:\.\w+)*\)(?:\.\w+(?:\(\))?)?/gu;

        if (newUrlRegEx.test(contents)) {
            contents = await replaceAsync(newUrlRegEx, contents, function([_, match]) {
                return callbackOrFiles(match, args);
            });

            return {
                "contents": contents,
                "loader": path.extname(args.path).substring(1) as OnLoadResult["loader"]
            };
        }
    };
}
