/**
 * Per-package dev server. `serve(appRoot)` serves a package (its cwd) with Vite in
 * middleware mode (getViteDevServer). Run it via the `util-dev` bin (util/scripts/dev.ts);
 * a package that needs more imports `serve` here and composes its own dev script.
 */

import type { ViteDevServer } from "vite";
import http from "node:http";
import { log } from "@brianjenkins94/util/logger";
import * as path from "node:path";
import * as url from "node:url";
import * as fs from "@brianjenkins94/util/fs";
import { createServer as createViteServer, mergeConfig, version as viteVersion } from "vite";
import { jsxToString } from "jsx-async-runtime";

/**
 * Serialize a jsx-async-runtime node to HTML WITHOUT entity-escaping the content of `<style>`/`<script>` —
 * HTML "raw text" elements whose text must stay literal (a `[data-x="y"]` selector would otherwise be
 * corrupted into the undecodable `[data-x=&quot;y&quot;]`). The runtime escapes every text node, so flip its
 * `jsxEscapeHTML` hook off for raw-text subtrees and thread this serializer through everything else.
 */
export async function jsxToHtml(node) {
	const isRawText = node !== null && typeof node === "object" && !("html" in node) && (node.tag === "style" || node.tag === "script");

	return jsxToString.call(isRawText ? { "jsxEscapeHTML": false } : { "jsxToString": jsxToHtml }, node);
}

import { defaults } from "./defaults";
import { polyfillNodeEsbuild, polyfillNodeRolldown } from "./plugins/polyfillNode";

/** Close tags jsx-async-runtime emits for HTML void elements — invalid HTML5, so strip them. */
const VOID_CLOSE_TAGS = /<\/(?:meta|link|br|hr|img|input|area|base|col|embed|source|track|wbr)>/gu;

/**
 * The shared Vite dev server (middleware mode, custom appType) — one per process. This is the base
 * everything else builds on: `util/router` layers route-module invalidation on top, `util/mcp`'s
 * bridge re-enters the entry through it, and `serve` below renders HTML through it.
 */
let viteDevServer: ViteDevServer | undefined;

export async function getViteDevServer(root: string): Promise<ViteDevServer> {
	// Start from the shared repo defaults (esnext, logLevel, worker format, …) so the
	// dev server matches the build configs instead of re-specifying its own base.
	viteDevServer ??= await createViteServer(mergeConfig(defaults, {
		"root": root,
		"appType": "custom",
		// allowedHosts: this dev server is often mounted on an app reached through a
		// tunnel/proxy (e.g. a *.loca.lt webhook), and Vite's default host check would
		// 403 those requests. It's a dev-only server, so trust any host.
		"server": { "middlewareMode": true, "allowedHosts": true },
		"esbuild": { "jsx": "automatic", "jsxImportSource": "jsx-async-runtime" },
		// Vite 8 pre-bundles deps with Rolldown (it stubs esbuild plugins → "Not implemented"); earlier
		// Vite uses esbuild. Wire the polyfill to whichever optimizer this Vite runs.
		"optimizeDeps": Number(viteVersion.split(".")[0]) >= 8
			? { "rolldownOptions": { "plugins": [polyfillNodeRolldown(["fs", "path", "url", "util"])] } }
			: { "esbuildOptions": { "plugins": [polyfillNodeEsbuild(["fs", "path", "url", "util"])] } },
		"publicDir": false
	}));

	return viteDevServer;
}

let entered = false;

/**
 * Dev "quine" guard. On the FIRST call (the tsx entry, in dev) it spins up the shared Vite server and
 * re-enters the calling entry through SSR, then returns `true` so the caller skips its app body — the
 * re-entry will run it. On the re-entry pass (and in production) it returns `false` → run the app body,
 * now in ONE module graph with the routes/tools it loads.
 *
 * The two passes are told apart by the module-level `entered` flag, NOT `import.meta.env.SSR`: this
 * module is externalized from Vite (it's a node_module), so it's a single instance across both passes.
 * That also means a consumer never has to read `import.meta.env` — which Vite's SSR module runner
 * forbids reading dynamically anyway.
 *
 * Usage:  if (!(await bootstrapOrRun(import.meta.url, appRoot))) { ...app body... }
 */
export async function bootstrapOrRun(metaUrl: string, root: string): Promise<boolean> {
	if (process.env["NODE_ENV"] === "production" || entered) {
		return false;
	}

	entered = true;

	const vite = await getViteDevServer(root);

	await vite.ssrLoadModule("/" + path.relative(root, url.fileURLToPath(metaUrl)).replace(/\\/gu, "/"));

	return true;
}

/** Serve one package directory in dev (Vite middleware + manual HTML, since
 *  getViteDevServer uses appType:"custom"). */
export async function serve(appRoot: string, port = 5173): Promise<void> {
	const vite = await getViteDevServer(appRoot);

	http.createServer((req, res) => {
		vite.middlewares(req, res, async () => {
			try {
				const urlPath = (req.url ?? "/").split("?")[0];
				let file = urlPath === "/" ? "index.html" : urlPath.slice(1);

				if (!file.endsWith(".html") || !fs.existsSync(path.join(appRoot, file))) { file = "index.html"; }
				const html = await vite.transformIndexHtml(req.url ?? "/", await fs.readFile(path.join(appRoot, file)));

				res.setHeader("content-type", "text/html");
				res.end(html);
			} catch (err) {
				vite.ssrFixStacktrace?.(err as Error);
				res.statusCode = 500;
				res.end(String((err as Error)?.stack ?? err));
			}
		});
	}).listen(port, () => { log.info(`${path.basename(appRoot)} → http://localhost:${port}/`); });
}

/** An Express view engine callback. */
type ViewEngine = (filePath: string, options: object, callback: (error: unknown, html?: string) => void) => Promise<void>;

/**
 * Express view engine for full-page TSX views, rendered through `vite` — the shared dev server
 * server.ts also mounts as middleware, passed in so the sharing is explicit. A view's default
 * export returns the whole <html> document; we SSR-load it, stringify the JSX, strip the void-
 * element close tags jsx-async-runtime emits (parse5 in `transformIndexHtml` rejects `</meta>`
 * etc.), then run the transform. A `route` prop, if present, is the transform url. Wire with
 * `server.engine("tsx", tsxEngine(await getViteDevServer(root)))`.
 */
export function tsxEngine(vite: ViteDevServer): ViewEngine {
	return async function(filePath, options, callback) {
		try {
			const props = options as Record<string, unknown>;
			const moduleId = "/" + path.relative(vite.config.root, filePath).replace(/\\/gu, "/");

			const { "default": Page } = await vite.ssrLoadModule(moduleId);
			const document = "<!doctype html>\n" + (await jsxToHtml(await Page(props))).replace(VOID_CLOSE_TAGS, "");

			callback(null, await vite.transformIndexHtml((props["route"] as string) ?? "/", document));
		} catch (error) {
			vite.ssrFixStacktrace?.(error as Error);
			callback(error);
		}
	};
}
