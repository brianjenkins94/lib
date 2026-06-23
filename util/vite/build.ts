import { build, mergeConfig, type InlineConfig } from "vite";
import { readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { defaults } from "./defaults";

export { defaults };

/**
 * Low-level primitive: build one package with `defaults` merged over `overrides`.
 * Published as `@brianjenkins94/util/vite/build` and consumed by sibling repos.
 */
export function buildPackage(root: string, overrides: InlineConfig = {}) {
    return build(mergeConfig(mergeConfig({ "root": root }, defaults), overrides));
}

export interface BuildAppOptions {
    /** Path segment prepended to an app's deploy base, e.g. "games" → base `/games/<name>/`. */
    baseDir?: string;
    /** Extra vite config merged into an app build (e.g. a `resolve.alias`). */
    overrides?: InlineConfig;
}

/**
 * Per-package build convention. A package opts in by pointing its own `build`
 * script here (`npx tsx ../../util/vite/build.ts`); this builds *that* package
 * (its cwd) with the `defaults` injected.
 *
 * A package with `.html` entries is built as a static app deployed under a
 * `/<baseDir>/<name>/` base to `docs/<name>/`. A package without `.html` (e.g. a
 * library, like the monaco-vscode-api component) is built from its own vite.config
 * plus the injected defaults. `options` lets a consuming repo deviate (e.g. games
 * passes `baseDir: "games"` and a phaser `resolve.alias`).
 */
export async function buildApp(appRoot: string, repoRoot: string, options: BuildAppOptions = {}): Promise<void> {
    const name = basename(appRoot);
    const files = readdirSync(appRoot);
    const input = files.filter((file) => file.endsWith(".html")).map((file) => resolve(appRoot, file));
    const isApp = input.length > 0;

    if (isApp) {
        const base = "/" + [options.baseDir, name].filter(Boolean).join("/") + "/";
        await buildPackage(appRoot, mergeConfig({
            "base": base,
            "build": {
                "outDir": resolve(repoRoot, "docs", name),
                "assetsInlineLimit": 0,
                "rollupOptions": {
                    "input": input,
                    "output": {
                        // Mirror each asset's on-disk location (strip the leading src/)
                        // instead of flattening into assets/. Fallback for generated assets.
                        "assetFileNames": (asset) => {
                            const source = asset.originalFileName;
                            return source ? source.replace(/^src\//u, "") : "assets/[name][extname]";
                        }
                    }
                }
            }
        }, options.overrides ?? {}));
        console.log(`built ${name} → docs/${name}/`);
    } else if (files.some((file) => /^vite\.config\.[mc]?[jt]s$/u.test(file))) {
        // Library with its own vite.config — build it directly so the file config is
        // authoritative. It inherits `defaults` itself (via mergeConfig) and may override
        // them (e.g. `minify`); buildPackage's inline config would otherwise win and clobber.
        await build({ "root": appRoot, "logLevel": "warn" });

        console.log(`built ${name}`);
    } else {
        // No `.html` and no vite.config — nothing buildable here (this is also what runs
        // when the file is invoked from a non-package dir, e.g. the repo root).
        console.log(`nothing to build in ${name}`);
    }
}

// Run directly → build the package this was invoked from. repoRoot is two
// levels up from this file (util/vite/).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await buildApp(process.cwd(), resolve(import.meta.dirname, "../.."));
}
