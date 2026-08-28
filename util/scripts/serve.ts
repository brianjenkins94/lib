import * as path from "node:path";
import * as url from "node:url";
import { log } from "@brianjenkins94/util/logger";
import * as fs from "@brianjenkins94/util/fs";
import { createServer, serveStatic } from "@brianjenkins94/util/server";

type Server = ReturnType<typeof createServer>;

export interface ServeStaticOptions {
	/** Directory to serve, resolved against the cwd. Defaults to the cwd. */
	"dir"?: string;
	/** Port to listen on. Defaults to 3000. */
	"port"?: number;
	/** Mount the site under `/<base>` instead of at the root — mirrors a GitHub Pages `/<repo>/` deploy so
	 *  base-relative URLs and a service-worker scope behave locally as they will in production. The root
	 *  redirects to `/<base>/`. Leading/trailing slashes are optional. Omit to serve at `/`. */
	"base"?: string;
}

async function exists(file: string): Promise<boolean> {
	return fs.stat(file).then(() => true, () => false);
}

/**
 * The zero-config profile — resolve {@link ServeStaticOptions} purely from convention, so the
 * `util-serve` bin runs with no arguments. Serves the first of `docs/`/`_site/` that exists (the
 * base-agnostic output {@link buildStatic}/`util-build-static` produces), else the cwd; port from
 * `$PORT`, else 3000. Override any piece by spreading: `serve({ ...await discoverServeConfig(), port })`.
 */
export async function discoverServeConfig(root = process.cwd()): Promise<Required<Omit<ServeStaticOptions, "base">>> {
	let dir = root;

	for (const candidate of ["docs", "_site"].map((name) => path.resolve(root, name))) {
		if (await exists(candidate)) { dir = candidate; break; }
	}

	return { dir, "port": process.env["PORT"] !== undefined ? Number(process.env["PORT"]) : 3000 };
}

/**
 * Serve a directory of static files over HTTP — the local counterpart to `util-build-static`, for
 * previewing a base-agnostic static build. Reuses `serveStatic` (index.html fallback + path-traversal
 * guard) on the shared `createServer`; the dir is resolved to an absolute path so that guard holds. With
 * a `base`, the site mounts under `/<base>` (the wildcard strips the prefix, so `serveStatic` still sees
 * a dir-relative path) and the root redirects to `/<base>/`. Resolves once listening, with the server
 * (call `.close()` to stop). Consumed as `@brianjenkins94/util/scripts/serve`; the `util-serve` bin runs
 * it with a convention-resolved dir/port.
 */
export async function serve(options: ServeStaticOptions = {}): Promise<Server> {
	const dir = path.resolve(options.dir ?? process.cwd());
	const port = options.port ?? 3000;
	const base = options.base?.replace(/^\/+|\/+$/gu, ""); // normalize `/repo/` | `repo` → `repo`

	const server = createServer();

	if (base) {
		const prefix = "/" + base;

		server.get(prefix + "/*", serveStatic(dir));
		// Bare `/<base>` (no trailing slash) and `/` both land on the mounted root.
		server.get(prefix, (_request, response) => response.redirect(prefix + "/"));
		server.get("/", (_request, response) => response.redirect(prefix + "/"));
	} else {
		server.get("/*", serveStatic(dir));
	}

	return new Promise((resolve) => {
		server.listen(port, () => {
			log.info("serving static", { dir, "url": `http://localhost:${port}${base ? "/" + base : ""}/` });
			resolve(server);
		});
	});
}

// Run directly (the `util-serve` bin): `util-serve [dir] [--port N] [--base <prefix>]`. An explicit
// dir/port overrides the convention profile; with no arguments it serves the conventional static output
// dir on the default port. `--base` mounts the site under `/<prefix>` (a local GitHub Pages mirror).
if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(await fs.realpath(process.argv[1])).toString()) {
	const args = process.argv.slice(2);
	let dir: string | undefined;
	let port: number | undefined;
	let base: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (arg === "--port" || arg === "-p") { port = Number(args[index += 1]); } else if (arg === "--base" || arg === "-b") { base = args[index += 1]; } else if (!arg.startsWith("-")) { dir = arg; }
	}

	const config = await discoverServeConfig();

	await serve({ "dir": dir ?? config.dir, "port": port ?? config.port, base });
}
