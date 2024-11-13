import { defineConfig } from "tsup";
import * as path from "path";
import * as url from "url";

import { importMetaUrl } from "../../util/esbuild/plugins"
import { manualChunks } from "../../util/esbuild/plugins"
import { esbuildOptions } from "../../util/esbuild"
import { __root } from "../../util/env"

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(await manualChunks({
    "entry": {
        "monaco": ["demo/package.json"]
    },
    "esbuildOptions": esbuildOptions({
        "nodePaths": [path.join(__dirname, "demo", "node_modules")]
    }),
    "esbuildPlugins": [
        importMetaUrl(__dirname)
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
    },
    "tsconfig": path.join(__dirname, "tsconfig.json")
}, __dirname));
