/**
 * The `@external` annotation: a dynamic import whose specifier is preceded by an `@external` LEGAL block
 * comment (`/*! … *\/`) names an OPTIONAL dependency the consuming app may not install — the same axis as
 * an un-polyfillable builtin: an import that would otherwise break a bundle of the lib. This module is the
 * one reader of that annotation; everything that acts on it derives its list from here:
 *  - `externalOptionalDeps` (util/vite/plugins/polyfillNode.ts) externalizes each annotated specifier in a
 *    BUILD if it doesn't resolve, so an absent dep is a harmless unreached runtime import rather than a
 *    "failed to resolve import" error;
 *  - util/scripts/publish.ts turns each annotated BARE specifier into an optional peer of the published
 *    package (`peerDependencies` + `peerDependenciesMeta.<name>.optional`). That is the only lever the DEV
 *    optimizer honors: Vite pre-bundles the lib into `.vite/deps` through its own resolver — an
 *    optimizer-plugin stub never took effect on Vite 8 (the chunk kept the bare import, which the dev server
 *    then failed to resolve) — but for an optional peer that resolver inlines its own inert stub (a module
 *    that throws "Could not resolve … Is it installed?"), in the esbuild (Vite 7) and rolldown (Vite 8)
 *    optimizers alike, so the consumer's try/catch around the import degrades exactly as an unreached
 *    runtime import would. npm never auto-installs an optional peer, so it costs the app nothing, and the
 *    declaration is generated, never hand-written.
 *
 * (Bundlers have no cross-tool ignore comment — `@vite-ignore`/`webpackIgnore` are each honored only by
 * their own tool — so an annotation like this only means anything paired with code that reads it.)
 *
 * The `/*!` (legal-comment) form is REQUIRED, not stylistic: a plain `/* … *\/` is dropped when util itself
 * is published (its source is Rolldown-bundled, minify:false — which still strips ordinary comments but
 * preserves legal ones), so the annotation would never reach a consumer's build or the publish-time scan
 * of the emitted code. Keep every `@external` marker a `/*!` comment.
 */
export const OPTIONAL_IMPORT = /import\(\s*((?:\/\*[\s\S]*?\*\/\s*)*)["']([^"']+)["']/gu;

/** The specifiers `code` imports through an `@external`-annotated dynamic import. */
export function externalSpecifiers(code: string): Set<string> {
	const specifiers = new Set<string>();

	for (const [, comments, id] of code.matchAll(OPTIONAL_IMPORT)) {
		if (/@external/u.test(comments)) {
			specifiers.add(id);
		}
	}

	return specifiers;
}

/** The npm package a bare specifier addresses (`@scope/name/sub` → `@scope/name`, `name/sub` → `name`). */
export function packageName(specifier: string): string {
	return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}
