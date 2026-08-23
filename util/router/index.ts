import * as path from "node:path";
import * as url from "node:url";
import { mapAsync } from "../array";
import { logger } from "../logger";
import { discover, getViteDevServer, moduleRoot, resolveExport } from "./core";

// Diagnostics go through the logger (→ stderr), never console.log (→ stdout): binding onto a stdio MCP
// server would otherwise corrupt its JSON-RPC stream.
const log = logger({ "source": "router" });

// The protocol-agnostic core (file discovery + dev/prod module resolver + package-root lookup) lives in
// ./core so util/mcp can reuse it WITHOUT importing this HTTP binder. Re-exported here so existing
// `@brianjenkins94/util/router` importers of discover/moduleRoot/resolveExport keep working.
export { discover, moduleRoot, resolveExport } from "./core";

/** File → route path relative to its directory (an `index` file collapses to its dirname; `[id]`/`[...x]` brackets kept intact). */
function routePath(filePath, directory) {
	const baseName = path.basename(filePath, path.extname(filePath));
	const pathName = path.dirname(filePath.substring(directory.length));

	return baseName === "index" ? pathName : path.join(pathName, baseName);
}

/* ------------------------------------------------------------------------------------------------ *
 * Unified binder. ONE walk over the handler tree; each file is imported once and its exports are
 * dispatched by SHAPE:
 *
 *   verb functions (`get`/`post`/`all`/… + optional `middlewares`) → HTTP routes on `targets.http`
 *   a `defineTool` DEFAULT export ({ name, config, handler })       → an MCP tool on `targets.mcp`
 *
 * A single file can export both and be served over both transports (colocation) — the HTTP route and
 * the MCP tool are two projections of one capability that share the file (and usually a shared inner
 * function); they are deliberately NOT forced into one handler shape. An export whose target isn't
 * provided is simply skipped, so an HTTP-only or MCP-only process ignores the other's exports.
 *
 *   targets.http — anything with `server[method](path, ...middlewares, handler)` (e.g. an Express app)
 *   targets.mcp  — anything with `registerTool(name, { description, inputSchema }, callback)`
 *                  (e.g. @modelcontextprotocol/sdk's McpServer)
 *
 * Isolation: an MCP tool is registered through util/mcp's shared registrar (context + MRTR confirmation),
 * imported LAZILY below — only when `targets.mcp` is set AND a tool was found — so an HTTP-only consumer
 * (bindRoutes) never loads the MCP SDK. The default-export shape is checked inline (no import) so even the
 * discovery pass stays SDK-free until there's an actual tool to register.
 * ------------------------------------------------------------------------------------------------ */

const VERB = /^(?:all|connect|del|get|head|options|patch|post|put|trace)/u;

/** True if a module's default export looks like a `defineTool` result (checked inline to keep this file
 *  SDK-free until registration). Mirrors util/mcp/tool's `isMcpTool`. */
function looksLikeTool(value) {
	return value !== undefined && value !== null && typeof value === "object" && typeof value.handler === "function" && typeof value.config === "object";
}

export async function bind(targets, routeMap) {
	const httpRoutes = [];
	const mcpTools = [];

	await mapAsync(Object.entries(routeMap), async function([basePath, directory]) {
		const root = moduleRoot(directory);

		await mapAsync(await discover(directory), async function(filePath) {
			const module = await import(url.pathToFileURL(filePath).toString());
			const relativePath = routePath(filePath, directory);

			// --- HTTP: verb-named function exports (+ a shared per-file `middlewares`) ---
			if (targets.http !== undefined) {
				const middlewares = module["middlewares"] ?? [];

				for (const [exportName] of Object.entries(module).filter(([name]) => VERB.test(name))) {
					let [method] = VERB.exec(exportName) ?? [];

					if (exportName === "del") {
						method = "delete";
					}

					let deferred = false;

					const pathName = path.join(basePath, relativePath)
						.replace(/(\[\[?)(\.{3})?([^[\]]+)\]\]?/gu, function(_, optional, catchAll, parameter) {
							deferred = true;

							return (catchAll === "..." ? "*" : ":") + parameter;
						})
						.replace(/\\/gu, "/");

					httpRoutes.push({
						"method": method,
						"pathName": pathName,
						"middlewares": middlewares,
						"deferred": deferred,
						"routeHandler": async function(request, response, next) {
							try {
								return (await resolveExport(root, filePath, exportName))(request, response, next);
							} catch (error) {
								if (process.env["NODE_ENV"] !== "production") {
									(await getViteDevServer(root)).ssrFixStacktrace?.(error);
								}

								throw error;
							}
						}
					});
				}
			}

			// --- MCP: a `defineTool` default export ---
			if (targets.mcp !== undefined && looksLikeTool(module.default)) {
				if (/\[[^\]]+\]/u.test(relativePath)) {
					// Tools take structured `inputSchema` args, not path params — `[id]`/`[...x]` files are HTTP-only.
					log.warn("Skipping tool in " + filePath + " — parameterized files can't be tools");
				} else {
					const prefix = basePath.split(/[/\\]/u).filter(Boolean).join("_");
					const derived = relativePath.split(/[/\\]/u).filter(Boolean).join("_").replace(/-/gu, "_");

					mcpTools.push({
						"name": module.default.name || [prefix, derived].filter(Boolean).join("_"),
						"config": module.default.config,
						"root": root,
						"filePath": filePath
					});
				}
			}
		});
	});

	// HTTP: order matters (Express matches in registration order) — static before catch-all, longest first.
	if (targets.http !== undefined) {
		httpRoutes.sort(function(a, b) {
			if (a.deferred !== b.deferred) {
				return a.deferred ? 1 : -1;
			}

			if (a.deferred && b.deferred) {
				const difference = b.pathName.length - a.pathName.length;

				if (difference !== 0) {
					return difference;
				}
			}

			const comparison = a.pathName.localeCompare(b.pathName);

			if (comparison !== 0) {
				return comparison;
			}

			return a.method.localeCompare(b.method);
		});

		for (const { method, pathName, middlewares, routeHandler } of httpRoutes) {
			log.info("Binding " + method.toUpperCase() + " " + pathName);

			targets.http[method](pathName, ...middlewares, routeHandler);
		}
	}

	// MCP: exact-name keyed — order is irrelevant; sort only for stable logs. The registrar (context +
	// MRTR) is imported here, lazily, so HTTP-only consumers never pull the MCP SDK. Each tool re-resolves
	// its handler per invocation (hot-reload) through the shared `resolveExport`.
	if (targets.mcp !== undefined && mcpTools.length > 0) {
		const { registerResolvingTool } = await import("@brianjenkins94/util/mcp/tool");

		mcpTools.sort((a, b) => a.name.localeCompare(b.name));

		for (const { name, config, root, filePath } of mcpTools) {
			log.info("Binding tool " + name);

			registerResolvingTool(targets.mcp, name, config, () => resolveExport(root, filePath, "default"));
		}
	}
}

/** HTTP-only convenience wrapper over `bind`. */
export async function bindRoutes(server, routeMap) {
	return bind({ "http": server }, routeMap);
}

/** MCP-only convenience wrapper over `bind`. */
export async function bindTools(server, routeMap) {
	return bind({ "mcp": server }, routeMap);
}
