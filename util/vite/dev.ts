/**
 * Per-package dev server. `serve(appRoot)` serves a package (its cwd) with Vite in
 * middleware mode (getViteDevServer). Run it via the `util-dev` bin (util/scripts/dev.ts);
 * a package that needs more imports `serve` here and composes its own dev script.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";

/**
 * The shared Vite dev server (middleware mode, custom appType) — one per process. This is the base
 * everything else builds on: `util/router` layers route-module invalidation on top, `util/mcp`'s
 * bridge re-enters the entry through it, and `serve` below renders HTML through it.
 */
let viteDevServer: ViteDevServer | undefined;

export async function getViteDevServer(root: string): Promise<ViteDevServer> {
    viteDevServer ??= await createViteServer({
        "root": root,
        "appType": "custom",
        "server": { "middlewareMode": true },
        "esbuild": { "jsx": "automatic", "jsxImportSource": "jsx-async-runtime" },
        "publicDir": false
    });

    return viteDevServer;
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
                if (!file.endsWith(".html") || !existsSync(join(appRoot, file))) file = "index.html";
                const html = await vite.transformIndexHtml(req.url ?? "/", await readFile(join(appRoot, file), "utf8"));
                res.setHeader("content-type", "text/html");
                res.end(html);
            } catch (err) {
                vite.ssrFixStacktrace?.(err as Error);
                res.statusCode = 500;
                res.end(String((err as Error)?.stack ?? err));
            }
        });
    }).listen(port, () => console.log(`\n  ${basename(appRoot)} → http://localhost:${port}/\n`));
}
