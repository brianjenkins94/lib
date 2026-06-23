import type { InlineConfig } from "vite";

/**
 * The repo's preferred build defaults (unminified, `[name].js`, esnext, cleaned
 * outDir, ES workers, no module preload). Kept in its own side-effect-free module
 * so a package's vite.config can `import { defaults }` and `mergeConfig(defaults,
 * { ... })` without pulling in the runnable `build.ts` (whose self-run guard must
 * not fire during config loading).
 */
export const defaults: InlineConfig = {
    "build": {
        "target": "esnext",
        "minify": false,
        "emptyOutDir": true,
        "modulePreload": false,
        "rollupOptions": {
            "output": {
                "entryFileNames": "[name].js",
                "chunkFileNames": "[name].js"
            }
        }
    },
    "worker": {
        "format": "es"
    },
    "logLevel": "warn"
};
