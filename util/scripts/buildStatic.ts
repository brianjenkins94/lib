import type { PluginOption } from "vite";
import * as path from "node:path";
import * as url from "node:url";
import { isEntry } from "@brianjenkins94/util/env";
import { log } from "@brianjenkins94/util/logger";
import * as fs from "@brianjenkins94/util/fs";
import { build } from "vite";
import { getViteDevServer, jsxToHtml } from "@brianjenkins94/util/vite/dev";

/** jsx-async-runtime emits close tags for HTML void elements; parse5 rejects them, so strip them. */
const VOID_CLOSE_TAGS = /<\/(?:meta|link|br|hr|img|input|area|base|col|embed|source|track|wbr)>/gu;

export interface StaticPage {
	/** The view module to SSR-load, e.g. `/app/views/index.tsx`. Its default export returns the <html>. */
	"module": string;
	/** Output path for the rendered page, relative to `outDir` (e.g. `app/index.html`). Its directory
	 *  also sets the depth used to rewrite in-app navigation to page-relative links. */
	"out": string;
}

export interface BuildStaticOptions {
	/** Vite root. Temp HTML inputs are written here so root-relative script srcs (`/app/src/…`) resolve.
	 *  Defaults to `process.cwd()`. */
	"root"?: string;
	/** Output directory for the built site. Defaults to `<root>/docs`. */
	"outDir"?: string;
	/** The pages to SSR-render and build. */
	"pages": StaticPage[];
	/** Transform each page's SSR'd HTML before the Vite build — e.g. inject a `<script>` into `<head>`. */
	"head"?: (html: string, page: StaticPage) => string;
	/** Origin-absolute in-app nav prefix (e.g. `/app`) to rewrite to page-relative AFTER the build, so the
	 *  output is deploy-path-agnostic. Omit to leave navigation untouched. */
	"rebase"?: string;
	/** Vite base. Defaults to `"./"` (relative assets → one build serves at any deploy path). */
	"base"?: string;
	/** Extra Vite plugins (e.g. `polyfillNode(...)` for a client that pulls in node builtins). */
	"plugins"?: PluginOption[];
	/** Runs after the build with the resolved `outDir` — copy extra assets, write a redirect, etc. */
	"after"?: (outDir: string) => Promise<void> | void;
}

/** Rewrite each `${prefix}/…` nav/iframe target to a link relative to `fromDir` — base-free output. */
function rebaseNav(html: string, fromDir: string, prefix: string): string {
	const anchor = prefix.replace(/^\/+/u, ""); // `/app` → `app`
	const pattern = new RegExp(`(href|src)="${prefix}/?([^"?]*)(\\?[^"]*)?"`, "gu");

	return html.replace(pattern, (_match, attr: string, target: string, query = "") => {
		let rel = path.posix.relative(fromDir, path.posix.join(anchor, target)) || ".";

		if (!rel.endsWith("/")) { rel += "/"; } // directory-style targets keep a trailing slash

		return `${attr}="${rel}${query}"`;
	});
}

/**
 * Base-agnostic static build for a full-page-TSX app: SSR each view → clean HTML (+ an optional `<head>`
 * injection) → Vite-build (relative assets by default, so ONE output serves at ANY deploy path) → rewrite
 * in-app navigation to page-relative links. The temp HTML inputs are written into `root` (so Vite's
 * root-relative script srcs resolve), Vite-built, then removed; `after` runs with the outDir for extra
 * copies/redirects. App-specific concerns (which pages exist, what goes in `<head>`, extra files) are the
 * caller's via options — the machinery here is generic. Consumed as `@brianjenkins94/util/scripts/buildStatic`.
 */
export async function buildStatic(options: BuildStaticOptions): Promise<void> {
	const root = options.root ?? process.cwd();
	const outDir = options.outDir ?? path.join(root, "docs");

	using span = log.span("build-static", { "pages": options.pages.length });

	// --- 1. SSR-render every view to clean HTML, written as temp inputs under `root` ---
	const vite = await getViteDevServer(root);
	const written: string[] = [];

	try {
		for (const page of options.pages) {
			const { "default": Page } = await vite.ssrLoadModule(page.module) as { "default": (props: object) => Promise<unknown> };
			let html = "<!doctype html>\n" + (await jsxToHtml(await Page({}))).replace(VOID_CLOSE_TAGS, "");

			if (options.head !== undefined) { html = options.head(html, page); }

			const file = path.join(root, page.out);
			await fs.mkdir(path.dirname(file), { "recursive": true });
			await fs.writeFile(file, html);
			written.push(file);
		}
	} finally {
		await vite.close();
	}

	// --- 2. Vite-build the temp HTMLs; relative assets so the output is base-free ---
	// Every ancestor dir of an output path, so intermediates created by mkdir get cleaned too.
	const createdDirs = new Set<string>();
	for (const page of options.pages) {
		for (let dir = path.dirname(page.out); dir !== "." && dir !== "/"; dir = path.dirname(dir)) { createdDirs.add(dir); }
	}

	try {
		await build({
			"root": root,
			"base": options.base ?? "./",
			"logLevel": "warn",
			"plugins": options.plugins ?? [],
			"build": {
				"target": "esnext",
				"outDir": outDir,
				"emptyOutDir": true,
				"assetsInlineLimit": 0,
				"rollupOptions": { "input": written }
			}
		});
	} finally {
		// Remove the temp HTML inputs; then, deepest-first, any dir they created that is now EMPTY
		// (a readdir check, since the lib fs has no `rmdir`) — so a pre-existing non-empty source
		// dir like `app/` is left untouched.
		for (const file of written) { await fs.rm(file, { "force": true }); }

		for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
			const full = path.join(root, dir);

			if ((await fs.readdir(full).catch(() => ["_"])).length === 0) { await fs.rm(full, { "recursive": true, "force": true }); }
		}
	}

	// --- 3. Post-process: rewrite in-app navigation to page-relative ---
	if (options.rebase !== undefined) {
		for (const page of options.pages) {
			const file = path.join(outDir, page.out);
			await fs.writeFile(file, rebaseNav(String(await fs.readFile(file)), path.posix.dirname(page.out), options.rebase));
		}
	}

	await options.after?.(outDir);
	span.info("built static", { "output": outDir });
}

/** Routes to leave out of the static copy — they need the real server (OAuth), not a mock. */
const CONVENTION_SKIP = new Set(["login", "callback"]);

async function exists(file: string): Promise<boolean> {
	return fs.stat(file).then(() => true, () => false);
}

/**
 * The default page-discovery convention: every file under `<root>/<prefix>/routes` that renders a
 * view (`response.render("name")`) becomes a page, SSR'd from `/<prefix>/views/name.tsx` and written
 * to `<prefix>/…/index.html` (mirroring the route path; `index` is the prefix root). `login`/`callback`
 * are skipped. This is the same routes→views convention `util/router` establishes, so an app that uses
 * the router gets its static pages discovered for free.
 */
export async function discoverPages(root: string, prefix = "app"): Promise<StaticPage[]> {
	const routesDir = path.join(root, prefix, "routes");
	const files = (await fs.readdir(routesDir, { "recursive": true })).filter((file) => /\.[jt]sx?$/u.test(String(file)));
	const pages: StaticPage[] = [];

	for (const rel of files) {
		const view = String(await fs.readFile(path.join(routesDir, String(rel)))).match(/response\.render\(\s*["']([^"']+)["']/u)?.[1];

		if (view === undefined) { continue; } // api/proxy routes render nothing

		const routePath = String(rel).replace(/\.[jt]sx?$/u, "").replace(/(^|\/)index$/u, "");

		if (CONVENTION_SKIP.has(routePath) || CONVENTION_SKIP.has(view)) { continue; }

		pages.push({ "module": `/${prefix}/views/${view}.tsx`, "out": `${prefix}/` + (routePath ? routePath + "/" : "") + "index.html" });
	}

	return pages;
}

/**
 * The zero-config profile — resolve a full {@link BuildStaticOptions} purely from convention, so the
 * `util-buildStatic` bin runs with no config file. Assumes the harness layout: the app composed under
 * `/<prefix>` (default `app`), views in `<prefix>/views`, routes in `<prefix>/routes`. Every piece is
 * existence-guarded:
 *   - `pages`   ← {@link discoverPages}
 *   - `plugins` ← `polyfillNode` for the node builtins a browser client commonly pulls in (via fido, …)
 *   - `rebase`  ← `/<prefix>` (in-app nav rewritten page-relative → deploy-path-agnostic)
 *   - `head`    ← inject `<prefix>/mocks/start.ts` as a module script IF present (e.g. an MSW bootstrap)
 *   - `after`   ← copy `<prefix>/public/*` under `<prefix>/` in the output IF present, and write a root
 *                 redirect into the app entry when no page renders at the site root
 * Override any single piece by spreading: `buildStatic({ ...await discoverStaticConfig(), head })`.
 */
export async function discoverStaticConfig(root = process.cwd(), prefix = "app"): Promise<BuildStaticOptions> {
	const { polyfillNode } = await import("@brianjenkins94/util/vite/plugins/polyfillNode");

	const pages = await discoverPages(root, prefix);
	const preludeSrc = `/${prefix}/mocks/start.ts`;
	const hasPrelude = await exists(path.join(root, `${prefix}/mocks/start.ts`));
	const publicDir = path.join(root, prefix, "public");
	const hasPublic = await exists(publicDir);
	const hasRootPage = pages.some((page) => page.out === "index.html");

	return {
		root,
		"outDir": path.join(root, "docs"),
		pages,
		"plugins": [polyfillNode(["fs", "path", "url", "util"])],
		"rebase": `/${prefix}`,
		"head": hasPrelude ? (html: string) => html.replace(/<head>/u, `<head><script type="module" src="${preludeSrc}"></script>`) : undefined,
		"after": async (outDir: string) => {
			// The app prefix's public dir (e.g. the MSW worker) is mirrored under the prefix so its
			// scope covers every call at any deploy path.
			if (hasPublic) { await fs.cp(publicDir, path.join(outDir, prefix), { "recursive": true }); }

			// When nothing renders at the site root, redirect it into the app entry (relative → base-free).
			if (!hasRootPage) {
				await fs.writeFile(path.join(outDir, "index.html"), `<!doctype html><meta charset="utf-8"><title>Redirecting…</title><meta http-equiv="refresh" content="0; url=./${prefix}/"><link rel="canonical" href="./${prefix}/"><a href="./${prefix}/">Continue to the app</a>`);
			}
		}
	};
}

// Run directly (the `util-buildStatic` bin). Config resolution, in order:
//   1. an explicit path argument (`util-buildStatic ./my.config.ts`),
//   2. a `buildStatic.config.{ts,js}` in the cwd if one exists,
//   3. otherwise NO config needed — fall back to the convention profile (discoverStaticConfig),
//      so an app that follows the harness layout builds with zero config.
// A config module's default export is the options object, or a function returning them. (A `.ts`
// config requires running the bin under tsx; the zero-config path needs no `.ts` import, so it runs
// under a plain `node` shebang.) Programmatic consumers just `import { buildStatic }`.
if (isEntry(import.meta)) {
	const explicit = process.argv[2] !== undefined ? path.resolve(process.cwd(), process.argv[2]) : undefined;
	const conventional = ["buildStatic.config.ts", "buildStatic.config.js"].map((name) => path.resolve(process.cwd(), name));
	const configPath = explicit ?? (await Promise.all(conventional.map(exists))).flatMap((found, index) => found ? [conventional[index]] : [])[0];

	if (configPath !== undefined) {
		const config = (await import(url.pathToFileURL(configPath).toString())).default as BuildStaticOptions | (() => BuildStaticOptions | Promise<BuildStaticOptions>);

		await buildStatic(typeof config === "function" ? await config() : config);
	} else {
		await buildStatic(await discoverStaticConfig());
	}
}
