import * as path from "node:path";
import * as url from "node:url";
import * as fs from "@brianjenkins94/util/fs";
import { mapAsync } from "./array";
import { getViteDevServer as getBaseViteDevServer } from "./vite/dev";

let watcherAttached = false;
const routeModules = new Map();

// TODO: Review
function hasDependency(moduleNode, filePath, seen = new Set()) {
	if (moduleNode === undefined || moduleNode === null) {
		return false;
	}

	if (seen.has(moduleNode)) {
		return false;
	}

	seen.add(moduleNode);

	if (moduleNode.file !== null && moduleNode.file.replace(/\\/gu, "/") === filePath) {
		return true;
	}

	for (const importedModule of moduleNode.importedModules ?? []) {
		if (hasDependency(importedModule, filePath, seen)) {
			return true;
		}
	}

	return false;
}

async function getViteDevServer(root) {
	const viteDevServer = await getBaseViteDevServer(root);

	if (!watcherAttached) {
		watcherAttached = true;

		for (const event of ["change", "unlink"]) {
			viteDevServer.watcher.on(event, async function(changedFilePath) {
				for (const [routeFilePath] of routeModules) {
					const moduleNode = await viteDevServer.moduleGraph.getModuleByUrl("/" + path.relative(root, routeFilePath).replace(/\\/gu, "/"));

					if (hasDependency(moduleNode, changedFilePath)) {
						routeModules.delete(routeFilePath);
					}
				}
			});
		}
	}

	return viteDevServer;
}

/* ------------------------------------------------------------------------------------------------ *
 * Protocol-agnostic core. `bindRoutes` (HTTP) and `bindTools` (MCP) both sit on these: file
 * discovery, the file → address mapping, the package root, and — the valuable part — the dev/prod
 * module resolver that hot-reloads a handler through the Vite SSR graph (cache invalidated by the
 * watcher above). None of these know anything about HTTP or MCP.
 * ------------------------------------------------------------------------------------------------ */

/** Absolute paths of every handler file under `directory`. */
async function discover(directory) {
	return (await Array.fromAsync(fs.glob("**/*.ts*", { "cwd": directory }))).map((filePath) => path.join(directory, filePath));
}

/** File → route path relative to its directory (an `index` file collapses to its dirname; `[id]`/`[...x]` brackets kept intact). */
function routePath(filePath, directory) {
	const baseName = path.basename(filePath, path.extname(filePath));
	const pathName = path.dirname(filePath.substring(directory.length));

	return baseName === "index" ? pathName : path.join(pathName, baseName);
}

/** The nearest package root above `directory` (the base the Vite SSR graph resolves module URLs against). */
function moduleRoot(directory) {
	return path.dirname(fs.closest(directory, "package.json"));
}

/**
 * Resolve the CURRENT value of a named export, hot-reloading in dev. In production the module is the
 * statically-imported (ESM-cached) one; in development it's loaded through the Vite SSR server and
 * cached in `routeModules` until the watcher invalidates it. Called per request / per tool invocation
 * so an edit is live without re-binding.
 */
async function resolveExport(root, filePath, exportName) {
	if (process.env["NODE_ENV"] === "production") {
		return (await import(url.pathToFileURL(filePath).toString()))[exportName];
	}

	const normalizedFilePath = path.resolve(filePath).replace(/\\/gu, "/");
	const moduleUrl = "/" + path.relative(root, normalizedFilePath).replace(/\\/gu, "/");

	const module = await (routeModules.get(normalizedFilePath) ?? routeModules.set(normalizedFilePath, (await getViteDevServer(root)).ssrLoadModule(moduleUrl)).get(normalizedFilePath));

	return module[exportName];
}

/* ------------------------------------------------------------------------------------------------ *
 * Unified binder. ONE walk over the handler tree; each file is imported once and its exports are
 * dispatched by SHAPE:
 *
 *   verb functions (`get`/`post`/`all`/… + optional `middlewares`) → HTTP routes on `targets.http`
 *   a `tool` object (`{ name?, description, inputSchema?, handler }`) → an MCP tool on `targets.mcp`
 *
 * A single file can export both and be served over both transports (colocation) — the HTTP route and
 * the MCP tool are two projections of one capability that share the file (and usually a shared inner
 * function); they are deliberately NOT forced into one handler shape. An export whose target isn't
 * provided is simply skipped, so an HTTP-only or MCP-only process ignores the other's exports.
 *
 *   targets.http — anything with `server[method](path, ...middlewares, handler)` (e.g. an Express app)
 *   targets.mcp  — anything with `registerTool(name, { description, inputSchema }, callback)`
 *                  (e.g. @modelcontextprotocol/sdk's McpServer)
 * ------------------------------------------------------------------------------------------------ */

const VERB = /^(?:all|connect|del|get|head|options|patch|post|put|trace)/u;

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

			// --- MCP: a `tool` object export ---
			const { tool } = module;

			if (tool !== undefined && targets.mcp !== undefined) {
				if (/\[[^\]]+\]/u.test(relativePath)) {
					// Tools take structured `inputSchema` args, not path params — `[id]`/`[...x]` files are HTTP-only.
					console.warn("Skipping tool in " + filePath + " — parameterized files can't be tools");
				} else {
					const prefix = basePath.split(/[/\\]/u).filter(Boolean).join("_");
					const derived = relativePath.split(/[/\\]/u).filter(Boolean).join("_").replace(/-/gu, "_");

					mcpTools.push({
						"name": tool.name ?? [prefix, derived].filter(Boolean).join("_"),
						"config": { "description": tool.description, "inputSchema": tool.inputSchema ?? {} },
						"handler": async function(...args) {
							return (await resolveExport(root, filePath, "tool")).handler(...args);
						}
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
			console.log("Binding " + method.toUpperCase() + " " + pathName);

			targets.http[method](pathName, ...middlewares, routeHandler);
		}
	}

	// MCP: exact-name keyed — order is irrelevant; sort only for stable logs.
	if (targets.mcp !== undefined) {
		mcpTools.sort((a, b) => a.name.localeCompare(b.name));

		for (const { name, config, handler } of mcpTools) {
			console.log("Binding tool " + name);

			targets.mcp.registerTool(name, config, handler);
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
