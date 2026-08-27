import type { PluginOption } from "vite";
import * as path from "node:path";
import * as url from "node:url";
import { log } from "@brianjenkins94/util/logger";
import * as fs from "@brianjenkins94/util/fs";
import { build } from "vite";
import { jsxToString } from "jsx-async-runtime";
import { getViteDevServer } from "../vite/dev";

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
	/** Vite root. Temp HTML inputs are written here so root-relative script srcs (`/app/src/…`) resolve. */
	"root": string;
	/** Output directory for the built site (e.g. an absolute `docs/`). */
	"outDir": string;
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
	using span = log.span("build-static", { "pages": options.pages.length });

	// --- 1. SSR-render every view to clean HTML, written as temp inputs under `root` ---
	const vite = await getViteDevServer(options.root);
	const written: string[] = [];

	try {
		for (const page of options.pages) {
			const { "default": Page } = await vite.ssrLoadModule(page.module) as { "default": (props: object) => Promise<unknown> };
			let html = "<!doctype html>\n" + (await jsxToString(await Page({}))).replace(VOID_CLOSE_TAGS, "");

			if (options.head !== undefined) { html = options.head(html, page); }

			const file = path.join(options.root, page.out);
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
			"root": options.root,
			"base": options.base ?? "./",
			"logLevel": "warn",
			"plugins": options.plugins ?? [],
			"build": {
				"target": "esnext",
				"outDir": options.outDir,
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
			const full = path.join(options.root, dir);

			if ((await fs.readdir(full).catch(() => ["_"])).length === 0) { await fs.rm(full, { "recursive": true, "force": true }); }
		}
	}

	// --- 3. Post-process: rewrite in-app navigation to page-relative ---
	if (options.rebase !== undefined) {
		for (const page of options.pages) {
			const file = path.join(options.outDir, page.out);
			await fs.writeFile(file, rebaseNav(String(await fs.readFile(file)), path.posix.dirname(page.out), options.rebase));
		}
	}

	await options.after?.(options.outDir);
	span.info("built static", { "output": options.outDir });
}

// Run directly (the `util-build-static` bin, run via tsx so a `.ts` config works): load
// `buildStatic.config.{ts,js}` (or an argv path) from the cwd — its default export is the options,
// or a function returning them — and build. Programmatic consumers just `import { buildStatic }`.
if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(await fs.realpath(process.argv[1])).toString()) {
	const configPath = path.resolve(process.cwd(), process.argv[2] ?? "buildStatic.config.ts");
	const config = (await import(url.pathToFileURL(configPath).toString())).default as BuildStaticOptions | (() => BuildStaticOptions | Promise<BuildStaticOptions>);

	await buildStatic(typeof config === "function" ? await config() : config);
}
