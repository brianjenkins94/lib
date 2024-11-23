import { defineConfig } from "tsup";
import * as path from "path";
import * as url from "url";

import { manualChunks } from "../../util/esbuild/plugins"
import { __root } from "../../util/env"

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
    "esbuildOptions": {
        "nodePaths": [path.join(__dirname, "demo", "node_modules")],
        "outdir": path.join(__dirname, "dist"),
    },
    "esbuildPlugins": [],
    "external": [
        "fonts"
    ],
    "loader": {
        ".bin": "copy",
        ".code-snippets": "json",
        ".html": "dataurl",
        ".map": "empty",
        ".png": "dataurl",
        ".scm": "dataurl",
        ".svg": "dataurl",
        ".tmLanguage": "dataurl",
        ".wasm": "copy"
    },
    "tsconfig": path.join(__dirname, "tsconfig.json"),
});
