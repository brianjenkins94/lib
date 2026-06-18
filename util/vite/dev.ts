/**
 * Per-package dev server.
 *
 * A package opts in via its own `dev` script (`npx tsx ../../util/vite/dev.ts`);
 * this serves *that* package (its cwd) with Vite in middleware mode
 * (getViteDevServer). A package that needs more deviates with its own dev script
 * that imports `serve` and adds its services.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { getViteDevServer } from "../router";

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

// Run directly → serve the package this was invoked from.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await serve(process.cwd());
}
