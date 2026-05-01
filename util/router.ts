import * as path from "path";
import * as url from "url";
import { promises as fs, existsSync } from "fs";
import { mapAsync } from "./array";
import * as vite from "vite";

let viteDevServer;
let routeModules = new Map();

// TODO: Improve
export async function findParentPackageJson(directory) {
	if (existsSync(path.join(directory, "package.json"))) {
		return path.join(directory, "package.json");
	} else if (path.dirname(directory) === directory) {
		throw new Error("Unable to find parent package.json for " + directory);
	} else {
		return findParentPackageJson(path.dirname(directory));
	}
}

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

export async function getViteDevServer(root) {
	if (viteDevServer === undefined) {
		viteDevServer = await vite.createServer({
			"root": root,
			"appType": "custom",
			"server": {
				"middlewareMode": true
			},
			"esbuild": {
				"jsx": "automatic",
				"jsxImportSource": "jsx-async-runtime"
			},
			"publicDir": false
		});

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

export async function bindRoutes(server, routeMap) {
	const routes = (await mapAsync(Object.entries(routeMap), async function([basePath, routeDirectory]) {
		return (await mapAsync(await Array.fromAsync(fs.glob("**/*.ts*", { "cwd": routeDirectory })), async function(filePath) {
			filePath = path.join(routeDirectory, filePath);

			const route = await import(url.pathToFileURL(filePath).toString());

			const middlewares = route["middlewares"] ?? [];

			return (await mapAsync(Object.entries(route), async function([routeMethod, routeHandler]) {
				let [method] = /^(?:all|connect|del|get|head|options|patch|post|put|trace)/u.exec(routeMethod) ?? [];

				if (method === undefined) {
					return [];
				}

				if (routeMethod === "del") {
					method = "delete";
				}

				const baseName = path.basename(filePath, path.extname(filePath));
				let pathName = path.dirname(filePath.substring(routeDirectory.length));

				if (baseName !== "index") {
					pathName = path.join(pathName, baseName);
				}

				pathName = path.join(basePath, pathName);

				let deferred = false;

				pathName = pathName
					.replace(/(\[\[?)([.]{3}?)(.+?)\]\]?/gu, function(_, optional, catchAll, parameter) {
						deferred = true;

						return (catchAll === "..." ? "*" : ":") + parameter;
					})
					.replace(/\\/gu, "/");

				return {
					"method": method,
					"pathName": pathName,
					"middlewares": middlewares,
					"routeHandler": async function(request, response, next) {
						let root = path.dirname(await findParentPackageJson(routeDirectory));

						try {
							const normalizedFilePath = path.resolve(filePath).replace(/\\/gu, "/");
							const moduleUrl = "/" + path.relative(root, normalizedFilePath).replace(/\\/gu, "/");

							const route = process.env["NODE_ENV"] === "production"
								? { [routeMethod]: routeHandler }
								: await (routeModules.get(normalizedFilePath) ?? routeModules.set(normalizedFilePath, (await getViteDevServer(root)).ssrLoadModule(moduleUrl)).get(normalizedFilePath));

							return route[routeMethod](request, response, next);
						} catch (error) {
							if (process.env["NODE_ENV"] !== "production") {
								const viteDevServer = await getViteDevServer(root);

								viteDevServer.ssrFixStacktrace?.(error);
							}

							throw error;
						}
					},
					"deferred": deferred
				};
			})).flat();
		})).flat();
	})).flat();

	routes.sort(function(a, b) {
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

	for (const { method, pathName, middlewares, routeHandler } of routes) {
		console.log("Binding " + method.toUpperCase() + " " + pathName);

		server[method](pathName, ...middlewares, routeHandler);
	}
}
