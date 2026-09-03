import type { PluginOption } from "vite";
import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin as RolldownPlugin } from "rolldown";
import { builtinModules, createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import stdlib from "node-stdlib-browser";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const NAMESPACE = "\0external-global:";

/**
 * node-stdlib-browser's global shim: exports `process`, `Buffer`, `global`. esbuild's `inject`
 * pulls these into any module that uses them as free globals (env.ts reads `process.platform`
 * without importing it) — the esbuild-side equivalent of the globals vite-plugin-node-polyfills
 * injects for `polyfillNode`.
 */
const NODE_GLOBALS_SHIM = url.fileURLToPath(import.meta.resolve("node-stdlib-browser/helpers/esbuild/shim"));

function isFunctional(builtin: string): boolean {
	return stdlib[builtin] !== undefined && !/mock[/\\]empty/u.test(stdlib[builtin]);
}

/**
 * A dynamic import whose specifier is preceded by a `@external` LEGAL block comment (`/*! … *\/`)
 * names an OPTIONAL dependency the consuming app may not install — the same axis as an
 * un-polyfillable builtin: an import that would otherwise break a browser bundle of the lib. We
 * collect the annotated specifiers from source, then externalize each ONLY IF it doesn't resolve —
 * so a consumer that DOES install the dep still gets it bundled and working, while one that doesn't
 * gets a harmless unreached runtime import instead of a build-time "failed to resolve import" error.
 * (Bundlers have no cross-tool ignore comment — `@vite-ignore`/`webpackIgnore` are each honored only
 * by their own tool — so an annotation like this only means anything paired with a plugin that reads
 * it; this is that plugin.)
 *
 * The `/*!` (legal-comment) form is REQUIRED, not stylistic: a plain `/* … *\/` is dropped when util
 * itself is published (its source is Rolldown-bundled, minify:false — which still strips ordinary
 * comments but preserves legal ones), so the annotation would never reach a consumer's build and the
 * specifier would never be externalized. Keep every `@external` marker a `/*!` comment.
 */
const OPTIONAL_IMPORT = /import\(\s*((?:\/\*[\s\S]*?\*\/\s*)*)["']([^"']+)["']/gu;

/**
 * Externalize `@external`-annotated dynamic imports that a consuming app may not have installed:
 * installed → let normal resolution bundle it; absent → leave it a harmless unreached runtime import.
 * Split out of {@link polyfillNode} so a build using {@link polyfillNodeRolldown} can keep this behavior.
 */
export function externalOptionalDeps(): PluginOption {
	// Specifiers seen with an `@external` annotation, filled by the transform hook below.
	const optional = new Set<string>();

	return {
		"name": "external-optional-deps",
		"enforce": "pre",
		"transform": function(code: string) {
			for (const [, comments, id] of code.matchAll(OPTIONAL_IMPORT)) {
				if (/@external/u.test(comments)) {
					optional.add(id);
				}
			}

			return null;
		},
		"resolveId": async function(id: string, importer: string | undefined) {
			if (!optional.has(id)) {
				return undefined;
			}

			// Installed → let normal resolution bundle it; absent → leave it a runtime import.
			const resolved = await this.resolve(id, importer, { "skipSelf": true });

			return resolved === null ? { "id": id, "external": true } : undefined;
		}
	} as PluginOption;
}

/** Marks a package.json as a stub this tooling generated, so {@link ensureOptionalStubs} only ever
 *  overwrites/keeps its own and a later real `npm install <dep>` (which replaces the folder) wins. */
const STUB_MARKER = "@brianjenkins94/util:optional-external-stub";

/**
 * Dev-server companion to {@link externalOptionalDeps} for the ONE case that plugin can't reach: an
 * `@external` optional dep that the app hasn't installed, imported from a package Vite PRE-BUNDLES.
 *
 * Vite's dep optimizer resolves the imports inside a `.vite/deps/*` chunk through an internal, on-disk-only
 * path — it consults no plugin `resolveId`, no `resolve.alias`, and neither `optimizeDeps.include` nor
 * `exclude` (all verified). And in dev a resolveId `external: true` is ignored unless the id is an external
 * URL (import-analysis gates on `isExternalUrl`, not rollup's build-time flag). So the browser-side
 * equivalent of the annotation's "harmless unreached runtime import" HAS to be a real on-disk module: a
 * bare specifier only resolves out of a `node_modules/<name>`.
 *
 * This scans `packageDir` (the lib that ships the `@external` imports) for those specifiers and, for each
 * bare one that doesn't resolve from `root`, writes an inert `node_modules/<name>` stub (default export `{}`
 * — the consumer reads it inside a try/catch and degrades). It is idempotent, only ever creates/overwrites
 * folders it marked itself, and never touches a real install (a folder it didn't mark is left alone; a real
 * `npm install <dep>` replaces the folder and takes over). Dev-only: production builds go through
 * {@link externalOptionalDeps}, which rollup honors.
 */
export async function ensureOptionalStubs(packageDir: string, root: string): Promise<void> {
	const specifiers = new Set<string>();

	// Walk the lib's shipped source for `@external`-annotated specifiers (skip its own node_modules).
	async function collect(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { "withFileTypes": true }).catch(() => []);

		await Promise.all(entries.map(async function(entry) {
			const full = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") { await collect(full); }
			} else if (entry.name.endsWith(".js")) {
				const code = await fs.readFile(full, "utf8").catch(() => "");

				for (const [, comments, id] of code.matchAll(OPTIONAL_IMPORT)) {
					// Only a bare specifier resolves out of node_modules and so can be stubbed there.
					if (/@external/u.test(comments) && id[0] !== "." && id[0] !== "/") { specifiers.add(id); }
				}
			}
		}));
	}

	await collect(packageDir);

	if (specifiers.size === 0) { return; }

	const require = createRequire(path.join(root, "index.js"));

	await Promise.all([...specifiers].map(async function(specifier) {
		// Installed (or already stubbed) → resolvable → nothing to do.
		try { require.resolve(specifier); return; } catch {}

		const stubDir = path.join(root, "node_modules", specifier);
		const manifest = path.join(stubDir, "package.json");

		// Never clobber a folder we didn't create — only a prior stub of ours (or nothing) is ours to write.
		const existing = await fs.readFile(manifest, "utf8").catch(() => null);
		if (existing !== null && !existing.includes(STUB_MARKER)) { return; }

		await fs.mkdir(stubDir, { "recursive": true });
		await fs.writeFile(manifest, JSON.stringify({
			"name": specifier,
			"version": "0.0.0-stub",
			"type": "module",
			"exports": "./index.js",
			"//": STUB_MARKER
		}, undefined, "\t") + "\n");
		await fs.writeFile(path.join(stubDir, "index.js"), "export default {};\n");
	}));
}

export function polyfillNode(builtins = builtinModules): PluginOption {
	const polyfill = builtins.filter(isFunctional);
	const stub = builtins.filter((builtin) => !isFunctional(builtin));

	const filter = new RegExp(`^(?:${NAMESPACE})?(${stub.join("|")})(/.*)?$`, "u");

	return [
		externalOptionalDeps(),
		...(polyfill.length > 0 ? nodePolyfills({ "include": polyfill, "protocolImports": true }) : []),
		...(stub.length > 0 ? [{
			"name": "node-stdlib-browser-alias",
			"enforce": "pre",
			"resolveId": function(id) {
				const [_, match] = filter.exec(id) ?? [];

				if (match !== undefined && stub.some((builtin) => id.startsWith(builtin))) {
					return NAMESPACE + id;
				}
			},
			"load": async function(id) {
				const [_, match] = filter.exec(id) ?? [];

				if (match !== undefined) {
					return Object.entries(await import(match)).map(function([key, value]) {
						return `export ${key === "default" ? "default" : `const ${key} =`} ${typeof value === "function" ? "() => {}" : undefined};`;
					}).join("\n");
				}
			}
		} as PluginOption] : [])
	];
}

/**
 * The esbuild counterpart of {@link polyfillNode}, for `optimizeDeps.esbuildOptions.plugins`.
 *
 * Vite's dep optimizer pre-bundles with esbuild and BYPASSES the Vite plugin pipeline, so a
 * dependency pulled into the optimizer (e.g. a client import of fido) never sees `polyfillNode`
 * and its `node:*` imports blow up in the browser. This gives esbuild the same treatment:
 *  - functional builtins  → resolved to their node-stdlib-browser polyfill (so `node:url`'s
 *    `fileURLToPath`, `node:util`, `buffer`, … actually work), and
 *  - un-polyfillable ones (`fs`, …) → a generated module of no-op named exports, so a named
 *    import like `{ readFileSync }` links (esbuild would otherwise error on the missing export)
 *    and simply does nothing unless called.
 *
 * It's a *rough* equivalent — it doesn't inject the `Buffer`/`process` globals the way
 * `vite-plugin-node-polyfills` can; it covers the import-resolution half, which is what a
 * Node-leaning dep (static `node:*` imports at module load) needs to load client-side.
 */
export function polyfillNodeEsbuild(builtins = builtinModules): EsbuildPlugin {
	const STUB_NS = "polyfill-node-stub";
	// Strip an optional `node:` prefix and any subpath (`fs/promises` → `fs`) to the base builtin.
	const base = (id: string): string => id.replace(/^node:/u, "").split("/")[0];
	// esbuild filters run on Go's RE2 (no `u` flag); builtin names are `[a-z_/]` so no escaping needed.
	const filter = new RegExp(`^(?:node:)?(?:${builtins.join("|")})(?:/.*)?$`);

	return {
		"name": "polyfill-node-esbuild",
		async setup(build) {
			// A pre-bundled dep's `import.meta.url` is its .vite/deps chunk URL, not the app's;
			// point it at the page instead (mirrors the render pipeline). Node-path helpers that
			// consume it still guard for a non-file: URL (see util/env.ts). Existing defines win.
			build.initialOptions.define = { "import.meta.url": "location.href", ...build.initialOptions.define };
			// Provide the `process`/`Buffer`/`global` globals for deps that reference them unimported.
			// Vite runs these esbuildOptions in BOTH the dep-scan pass (write:false — which marks
			// resolved paths external, and an *injected* file may not be external) and the optimize
			// pass (write:true). Inject only in the optimize pass; during scan it would error out
			// ("injected path cannot be marked as external") and abort dependency discovery.
			if (build.initialOptions.write !== false) {
				build.initialOptions.inject = [...build.initialOptions.inject ?? [], NODE_GLOBALS_SHIM];
			}

			// A `stdlib` entry can be a package dir OR a file, and esbuild's own resolver handles both
			// (honoring the browser field) — no `browser-resolve`. `build.resolve` is only callable from
			// a callback (post-setup), so resolve each functional builtin's polyfill lazily + cache it.
			const polyfilled = new Map<string, string | undefined>();

			build.onResolve({ filter }, async function(args) {
				const name = base(args.path);

				if (isFunctional(name)) {
					if (!polyfilled.has(name)) {
						const resolved = await build.resolve(stdlib[name], { "kind": "import-statement", "resolveDir": process.cwd() });

						polyfilled.set(name, resolved.errors.length === 0 ? resolved.path : undefined);
					}

					const entry = polyfilled.get(name);

					if (entry !== undefined) {
						return { "path": entry };
					}
				}

				// Known-but-un-polyfillable (fs, …): hand off to the stub loader below.
				if (stdlib[name] !== undefined) {
					return { "path": name, "namespace": STUB_NS };
				}

				return undefined;
			});

			build.onLoad({ "filter": /.*/, "namespace": STUB_NS }, async function(args) {
				// Import the REAL builtin (this runs in Node at build time) to mirror its named
				// exports as no-ops, so downstream named imports link.
				const real = await import(args.path).catch(() => ({}));
				const contents = Object.entries(real).map(function([key, value]) {
					return `export ${key === "default" ? "default" : `const ${key} =`} ${typeof value === "function" ? "() => {}" : "undefined"};`;
				}).join("\n");

				return { "contents": contents || "export default {};", "loader": "js" };
			});
		}
	};
}

/**
 * The Rolldown counterpart of {@link polyfillNodeEsbuild}, for `optimizeDeps.rolldownOptions.plugins`.
 *
 * Vite 8's dep optimizer pre-bundles with ROLLDOWN, not esbuild: it stubs esbuild plugins and throws
 * "Not implemented" the instant one touches the esbuild `build` object, so `polyfillNodeEsbuild` dies in
 * its `setup`. Rolldown runs Rollup-style plugins, so this gives the optimizer the same treatment through
 * `resolveId`/`load`/`transform`:
 *  - functional builtins → resolved to their node-stdlib-browser polyfill (so `node:url`'s `fileURLToPath`,
 *    `node:util`, `buffer`, … work);
 *  - un-polyfillable ones (`fs`, …) → a `\0`-virtual module of no-op named exports, so `{ readFileSync }` links;
 *  - `process`, read as a free global at module load by node-leaning deps (fido → `process.platform`) → a
 *    minimal INLINE shim.
 *
 * The `process` shim is inlined deliberately: `optimizeDeps.rolldownOptions.inject` is rejected by Vite
 * ("Invalid key: Expected never"), and injecting it by IMPORTING node-stdlib-browser's shim adds a dep edge
 * that churns Vite's optimizer into a 504-loop. Only `process` is covered — the only free global these deps
 * read; a dep that needs a real `Buffer` would want `stdlib.buffer`'s `Buffer` given the same treatment.
 */
export function polyfillNodeRolldown(builtins = builtinModules): RolldownPlugin {
	const STUB = "\0polyfill-node-stub:";
	// Strip an optional `node:` prefix and any subpath (`fs/promises` → `fs`) to the base builtin.
	const base = (id: string): string => id.replace(/^node:/u, "").split("/")[0];
	const filter = new RegExp(`^(?:node:)?(?:${builtins.join("|")})(?:/.*)?$`, "u");
	// A minimal browser `process`, inlined (no import edge to churn the optimizer); `var` so it's a
	// harmless no-op in a module that already has one.
	const PROCESS_SHIM = `var process = globalThis.process ?? { "env": {}, "argv": [], "platform": "browser", "version": "", "versions": {}, "cwd": () => "/", "nextTick": (fn) => queueMicrotask(fn) };\n`;

	return {
		"name": "polyfill-node-rolldown",
		"resolveId": async function(id) {
			if (!filter.test(id)) {
				return null;
			}

			const name = base(id);

			if (isFunctional(name)) {
				// stdlib maps some builtins to a package DIRECTORY (path-browserify, util); resolving that with
				// `this.resolve(dir, undefined)` yields the directory (rolldown then fails to load it). Node's
				// require.resolve applies package `main`/`index` resolution, so it lands on the real entry file.
				return createRequire(import.meta.url).resolve(stdlib[name]);
			}

			// Known-but-un-polyfillable (fs, …) → the stub loader below.
			return stdlib[name] !== undefined ? STUB + name : null;
		},
		"load": async function(id) {
			if (!id.startsWith(STUB)) {
				return null;
			}

			// Import the REAL builtin (runs in Node here) to mirror its named exports as no-ops.
			const real = await import(id.slice(STUB.length)).catch(() => ({}));

			return Object.entries(real).map(function([key, value]) {
				return `export ${key === "default" ? "default" : `const ${key} =`} ${typeof value === "function" ? "() => {}" : "undefined"};`;
			}).join("\n") || "export default {};";
		},
		"transform": function(code, id) {
			// Skip the polyfills themselves; inject only where `process` is read as a free global.
			if (id.includes("node-stdlib-browser") || !(/(?<![\w.$])process\b/u).test(code)) {
				return null;
			}

			return { "code": PROCESS_SHIM + code, "map": null };
		}
	};
}
