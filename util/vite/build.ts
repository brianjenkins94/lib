import { build, mergeConfig, type InlineConfig } from "vite";

export function buildPackage(root: string, overrides: InlineConfig = {}) {
    return build(mergeConfig({
        "root": root,
        "build": {
            "target": "esnext",
            "minify": false,
            "emptyOutDir": true,
            "rollupOptions": {
                "output": {
                    "entryFileNames": "[name].js",
                    "chunkFileNames": "[name].js"
                }
            }
        },
        "logLevel": "warn"
    }, overrides));
}
