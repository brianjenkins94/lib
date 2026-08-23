/**
 * Protocol-agnostic router core — the reusable half both `util/router` (HTTP + colocated MCP) and
 * `util/mcp` (dedicated MCP servers) sit on: file discovery, the package-root lookup, and — the
 * valuable part — the dev/prod module resolver that hot-reloads a handler through the Vite SSR graph
 * (cache invalidated by the watcher below). None of this knows anything about HTTP or MCP, so both
 * consumers walk the SAME tree and hot-reload through the SAME watcher-invalidated cache.
 *
 * Extracted from `util/router` so `util/mcp` can reuse discovery/resolution WITHOUT importing the HTTP
 * binder (and its Express-shaped code) — see the isolation note in `util/router`.
 */

import * as path from "node:path";
import * as url from "node:url";
import * as fs from "@brianjenkins94/util/fs";
import { getViteDevServer as getBaseViteDevServer } from "@brianjenkins94/util/vite/dev";

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

/** The dev Vite SSR server for `root`, with a one-time watcher that drops a cached module (and anything
 *  that imports it) from `routeModules` on change/unlink — so `resolveExport` reloads edited code. */
export async function getViteDevServer(root) {
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

/** Absolute paths of every handler file under `directory` (recursively) — the single discovery walk
 *  both `util/router` and `util/mcp` use, so a `tools/` tree is enumerated one way. */
export async function discover(directory) {
	return (await Array.fromAsync(fs.glob("**/*.ts*", { "cwd": directory }))).map((filePath) => path.join(directory, filePath));
}

/** The nearest package root above `directory` (the base the Vite SSR graph resolves module URLs against). */
export function moduleRoot(directory) {
	return path.dirname(fs.closest(directory, "package.json"));
}

/**
 * Resolve the CURRENT value of a named export, hot-reloading in dev. In production the module is the
 * statically-imported (ESM-cached) one; in development it's loaded through the Vite SSR server and
 * cached in `routeModules` until the watcher invalidates it. Called per request / per tool invocation
 * so an edit is live without re-binding — HTTP routes and MCP tools hot-reload through this one path.
 */
export async function resolveExport(root, filePath, exportName) {
	if (process.env["NODE_ENV"] === "production") {
		return (await import(url.pathToFileURL(filePath).toString()))[exportName];
	}

	const normalizedFilePath = path.resolve(filePath).replace(/\\/gu, "/");
	const moduleUrl = "/" + path.relative(root, normalizedFilePath).replace(/\\/gu, "/");

	const module = await (routeModules.get(normalizedFilePath) ?? routeModules.set(normalizedFilePath, (await getViteDevServer(root)).ssrLoadModule(moduleUrl)).get(normalizedFilePath));

	return module[exportName];
}
