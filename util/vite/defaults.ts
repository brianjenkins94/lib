import type { InlineConfig } from "vite";

/**
 * The repo's preferred build defaults (unminified, esnext, cleaned outDir, ES workers, no module
 * preload). Kept in its own side-effect-free module so a package's vite.config can `import { defaults }`
 * and `mergeConfig(defaults, { ... })` without pulling in the runnable `build.ts` (whose self-run guard
 * must not fire during config loading).
 *
 * Output naming is DETERMINISTIC by design: entries keep readable `[name].js` (the published `exports`
 * surface consumers import), while chunks and assets are content-hashed. Non-hashed chunk/asset names
 * collide inside collision-heavy bundles (e.g. monaco-vscode-api pulls in dozens of `@codingame`
 * `extension.js`/`package.json`), and rollup then disambiguates with ORDER-DEPENDENT numeric suffixes
 * (`extension2.js`, `package3.json`, …) that shuffle between builds and cascade into chunk import refs —
 * making every build byte-different and churning the publisher endlessly. Content hashes make identical
 * content resolve to identical names regardless of build order, so unchanged packages rebuild identically.
 */
export const defaults: InlineConfig = {
	"build": {
		"target": "esnext",
		"minify": false,
		"emptyOutDir": true,
		"modulePreload": { "polyfill": false },
		"rollupOptions": {
			"output": {
				"entryFileNames": "[name].js",
				"chunkFileNames": "[name]-[hash].js",
				"assetFileNames": "[name]-[hash][extname]"
			}
		}
	},
	"worker": {
		"format": "es"
	},
	"logLevel": "warn"
};
