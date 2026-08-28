import type { PluginOption } from "vite";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { builtinModules } from "node:module";
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

export function polyfillNode(builtins = builtinModules): PluginOption {
	const polyfill = builtins.filter(isFunctional);
	const stub = builtins.filter((builtin) => !isFunctional(builtin));

	const filter = new RegExp(`^(?:${NAMESPACE})?(${stub.join("|")})(/.*)?$`, "u");

	// Specifiers seen with an `@external` annotation, filled by the transform hook below.
	const optional = new Set<string>();

	return [
		{
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
		} as PluginOption,
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
