import { defineConfig } from "tsup";

import { importMetaUrl } from "../../util/esbuild/plugins"
import { esbuildOptions } from "../../util/esbuild"

export default defineConfig({
    "esbuildOptions": esbuildOptions({
        "nodePaths": ["./demo/node_modules/"]
    }),
    "esbuildPlugins": [
        importMetaUrl
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
