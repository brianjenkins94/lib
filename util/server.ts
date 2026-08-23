import * as http from "node:http";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import mime from "mime/lite";
import { log } from "./logger";

import { render } from "./render";

// TODO: Extract?
function toPattern(route) {
	return route.replace(/^[A-Z]+ /u, "").replace(/\*([A-Za-z_]\w*)/gu, ":$1*");
}

export function createServer(router = {}) {
	const server = http.createServer(async function(request, response) {
		const originalUrl = request.url;

		// One span per request: it times the exchange and any logging during the request nests under it.
		const span = log.span(request.method + " " + originalUrl);

		response.on("finish", function() {
			span.end({ "status": response.statusCode });
		});

		let statusCode = 404;
		let headers = { "Content-Type": "text/plain" };
		let body;

		try {
			const pathname = request.url.split("?")[0];

			const [pathName] = Object.keys(router).filter(function(route) {
				return route.startsWith(request.method) && new URLPattern({ "pathname": toPattern(route) }).test({ "pathname": pathname });
			});

			if (router[pathName] !== undefined) {
				request["query"] = Object.fromEntries(new URLSearchParams(request.url.split("?")[1]).entries());
				request["params"] = new URLPattern({ "pathname": toPattern(pathName) }).exec({ "pathname": pathname })?.["pathname"].groups;

				response["json"] = function(body) {
					return {
						"statusCode": 200,
						"headers": {
							"Content-Type": "application/json"
						},
						"body": typeof body === "object" ? JSON.stringify(body) : body
					};
				};

				response["redirect"] = function(path) {
					return {
						"statusCode": 302,
						"headers": {
							"Location": path
						}
					};
				};

				response["render"] = async function(template, data = {}, options = {}) {
					return {
						"statusCode": 200,
						"headers": {
							"Content-Type": "text/html"
						},
						"body": await render(template, data, options)
					};
				};

				let bodyPromise;

				function read() {
					bodyPromise ??= Array.fromAsync(request).then((chunks) => Buffer.concat(chunks));

					return bodyPromise;
				}

				request["bytes"] = function() {
					return read();
				};

				request["arrayBuffer"] = async function() {
					return new Uint8Array(await read()).buffer;
				};

				request["text"] = async function() {
					return (await read()).toString();
				};

				request["json"] = async function() {
					return JSON.parse(await request["text"]());
				};

				({ statusCode, headers, body } = await router[pathName](request, response) ?? {});

				if (/json/ui.test(headers?.["Content-Type"]) && typeof body !== "string") {
					body = JSON.stringify(body, undefined, 4);
				}
			}

			if (!response.headersSent) {
				response.writeHead(statusCode, headers);
				response.end(body);
			}
		} catch (error) {
			if (statusCode < 500) {
				statusCode = 500;
			}

			log.error(request.method + " " + originalUrl + " failed", { "error": error?.message, "stack": error?.stack });

			if (!response.headersSent) {
				response.writeHead(statusCode, headers);
				response.end(body ?? "Internal server error");
			}
		}
	});

	return {
		"all": function(route, handler) {
			router["ALL " + route] = handler;
		},
		"get": function(route, handler) {
			router["GET " + route] = handler;
		},
		"post": function(route, handler) {
			router["POST " + route] = handler;
		},
		"delete": function(route, handler) {
			router["DELETE " + route] = handler;
		},
		"listen": function(port: number, callback?: () => void) {
			return server.listen(port, callback);
		},
		"close": function(callback?: (error?: Error) => void) {
			return server.close(callback);
		}
	};
}

export function serveStatic(staticPath) {
	return async function serve(request, response) {
		const fullPath = path.join(staticPath, request.params[0]);

		if (path.resolve(fullPath).startsWith(staticPath)) {
			if (fs.existsSync(fullPath) && (await fs.stat(fullPath)).isFile()) {
				return {
					"statusCode": 200,
					"headers": {
						"Content-Type": mime.getType(fullPath)
					},
					"body": await fs.readFile(fullPath)
				};
			} else if (path.extname(fullPath) === "" && fs.existsSync(path.join(fullPath, "index.html"))) {
				request.params[0] += "/index.html";

				return serve(request, response);
			}
		}

		return {
			"statusCode": 404
		};
	};
}
