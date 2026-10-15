import type { PluginOption } from "vite";
import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin as RolldownPlugin } from "rolldown";
import { builtinModules } from "node:module";
import * as url from "node:url";
import { defineEnv } from "unenv";
import { externalSpecifiers } from "@brianjenkins94/util/vite/external";

/**
 * Node's built-ins for a browser bundle: unenv's (https://github.com/unjs/unenv — what esm.sh and Cloudflare's Node
 * compatibility build on; some ported from Node's own source). Each built-in listed resolves to unenv's module, with its
 * `node:` form and subpaths (`node:util/types`); what can't work in a browser (fs, child_process, …) is there by name
 * and says it isn't implemented when it's called. unenv's modules import each other by Node's names, and those are
 * unenv's own whatever was listed. The globals code written for Node reads unimported — `process`, `Buffer`, `global`,
 * `setImmediate` — are injected from unenv too (a build's; the dep optimizer gets an inline `process`, below).
 */
const { env } = defineEnv({ "nodeCompat": true, "resolve": true });

/** A built-in's name, without `node:` and its subpath (`node:fs/promises` → `fs`). */
const base = (id: string): string => id.replace(/^node:/u, "").split("/")[0];

/** Whether a module is unenv's own (its imports of Node's built-ins are unenv's). */
const isUnenv = (importer: string | undefined): boolean => importer !== undefined && /[\\/]node_modules[\\/]unenv[\\/]/u.test(importer);

/** The file of unenv's module for built-in `id` imported from `importer` — when `id` is one of `builtins` (or the
 *  importer is unenv's) and unenv has it; else undefined. */
function unenvFile(id: string, importer: string | undefined, builtins: ReadonlySet<string>): string | undefined {
	const file = env.alias[id];

	return file !== undefined && (builtins.has(base(id)) || isUnenv(importer)) ? file : undefined;
}

/** unenv's globals, as rolldown's `transform.inject` takes them. */
const GLOBALS = env.inject as Record<string, string | [string, string]>;

/**
 * Externalize `@external`-annotated dynamic imports (see util/vite/external.ts) that a consuming app may not
 * have installed: installed → let normal resolution bundle it; absent → leave it a harmless unreached runtime
 * import. A BUILD-side plugin: the dev optimizer never consults it, and is covered instead by the optional-peer
 * declaration publish.ts derives from the same annotations. Split out of {@link polyfillNode} so a build using
 * {@link polyfillNodeRolldown} can keep this behavior.
 */
export function externalOptionalDeps(): PluginOption {
	// Specifiers seen with an `@external` annotation, filled by the transform hook below.
	const optional = new Set<string>();

	return {
		"name": "external-optional-deps",
		"enforce": "pre",
		"transform": function(code: string) {
			for (const id of externalSpecifiers(code)) {
				optional.add(id);
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

/** Node's built-ins `builtins` (default: all of them) as unenv's, for a Vite build or dev server — and unenv's globals
 *  injected into a build. */
export function polyfillNode(builtins: readonly string[] = builtinModules): PluginOption {
	const listed = new Set(builtins.map(base));

	return [
		externalOptionalDeps(),
		{
			"name": "polyfill-node",
			"enforce": "pre",
			"config": () => ({ "build": { "rolldownOptions": { "transform": { "inject": GLOBALS } } } }),
			"resolveId": (id: string, importer: string | undefined) => unenvFile(id, importer, listed)
		} as PluginOption
	];
}

/** A module of unenv's globals, as esbuild's `inject` takes them (a file whose exports are the globals). */
const NODE_GLOBALS = url.fileURLToPath(new URL("./nodeGlobals.ts", import.meta.url));

/**
 * The esbuild counterpart of {@link polyfillNode}, for `optimizeDeps.esbuildOptions.plugins`: Vite's dep optimizer
 * pre-bundled with esbuild (before Vite 8) and BYPASSES the Vite plugin pipeline, so a dependency pulled into it (a
 * client import of fido) never sees `polyfillNode` and its `node:*` imports blow up in the browser. Same resolution;
 * the globals injected from a module of them (nodeGlobals.ts).
 */
export function polyfillNodeEsbuild(builtins: readonly string[] = builtinModules): EsbuildPlugin {
	const listed = new Set(builtins.map(base));
	// esbuild filters run on Go's RE2 (no `u` flag); builtin names are `[a-z_/]` so no escaping needed.
	const filter = new RegExp(`^(?:node:)?(?:${builtinModules.join("|")})(?:/.*)?$`);

	return {
		"name": "polyfill-node-esbuild",
		setup(build) {
			// A pre-bundled dep's `import.meta.url` is its .vite/deps chunk URL, not the app's;
			// point it at the page instead (mirrors the render pipeline). Node-path helpers that
			// consume it still guard for a non-file: URL (see util/env.ts). Existing defines win.
			build.initialOptions.define = { "import.meta.url": "location.href", ...build.initialOptions.define };
			// Vite runs these esbuildOptions in BOTH the dep-scan pass (write:false — which marks
			// resolved paths external, and an *injected* file may not be external) and the optimize
			// pass (write:true). Inject only in the optimize pass; during scan it would error out
			// ("injected path cannot be marked as external") and abort dependency discovery.
			if (build.initialOptions.write !== false) {
				build.initialOptions.inject = [...build.initialOptions.inject ?? [], NODE_GLOBALS];
			}

			build.onResolve({ "filter": filter }, (args) => {
				const file = unenvFile(args.path, args.importer, listed);

				return file === undefined ? undefined : { "path": file };
			});
		}
	};
}

/**
 * The Rolldown counterpart of {@link polyfillNodeEsbuild}, for `optimizeDeps.rolldownOptions.plugins`: Vite 8's dep
 * optimizer pre-bundles with ROLLDOWN (it stubs esbuild plugins and throws "Not implemented" the instant one touches the
 * esbuild `build` object), so this gives it the same resolution through `resolveId` — and `process`, read as a free
 * global at module load by node-leaning deps (fido → `process.platform`), as a minimal INLINE shim.
 *
 * The `process` shim is inlined deliberately: `optimizeDeps.rolldownOptions.inject` is rejected by Vite ("Invalid key:
 * Expected never"), and injecting it by IMPORTING a module adds a dep edge that churns Vite's optimizer into a 504-loop.
 * Only `process` is covered — the only free global these deps read.
 */
export function polyfillNodeRolldown(builtins: readonly string[] = builtinModules): RolldownPlugin {
	const listed = new Set(builtins.map(base));
	// A minimal browser `process`, inlined (no import edge to churn the optimizer); `var` so it's a
	// harmless no-op in a module that already has one.
	const PROCESS_SHIM = `var process = globalThis.process ?? { "env": {}, "argv": [], "platform": "browser", "version": "", "versions": {}, "cwd": () => "/", "nextTick": (fn) => queueMicrotask(fn) };\n`;

	return {
		"name": "polyfill-node-rolldown",
		"resolveId": (id, importer) => unenvFile(id, importer, listed) ?? null,
		"transform": function(code, id) {
			// Skip unenv's own; inject only where `process` is read as a free global — a property read (`process.platform`,
			// `process["env"]`), in a module that doesn't declare a `process` of its own. Merely containing the word isn't
			// enough: turndown (via just-bash) has `function process(node)`, and a `var process` on top of that is a
			// redeclaration that fails the whole dependency bundle.
			if (isUnenv(id) || !(/(?<![\w.$])process\s*[.[]/u).test(code) || (/\b(?:function|var|let|const|class)\s+process\b/u).test(code)) {
				return null;
			}

			return { "code": PROCESS_SHIM + code, "map": null };
		}
	};
}
