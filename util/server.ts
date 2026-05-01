import * as fs from "./fs";
import { pathToRegexp, match } from "path-to-regexp";
import * as http from "http";
import * as path from "path";
import mime from "mime/lite";

import { render } from "./render";

export function createServer(router = {}) {
	const server = http.createServer(async function(request, response) {
		const startTime = performance.now();

		const originalUrl = request.url;

		response.on("finish", function() {
			console.log(request.method, originalUrl, response.statusCode, (performance.now() - startTime).toFixed(3), "ms");
		});

		let statusCode = 404;
		let headers = { "Content-Type": "text/plain" };
		let body;

		try {
			const [pathName] = Object.keys(router).filter(function(route) {
				return route.startsWith(request.method) && pathToRegexp(route.replace(/^[A-Z]+ /u, "")).regexp.test(request.url.split("?")[0]);
			});

			if (router[pathName] !== undefined) {
				request["query"] = Object.fromEntries(new URLSearchParams(request.url.split("?")[1]).entries());
				request["params"] = match(pathName.replace(/^[A-Z]+ /u, ""))(request.url)?.["params"];

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

				request["json"] = async function() {
					const chunks = [];

					for await (const chunk of request) {
						chunks.push(chunk);
					}

					return JSON.parse(Buffer.concat(chunks).toString());
				};

				({ statusCode, headers, body } = await router[pathName](request, response));

				if (/json/ui.test(headers?.["Content-Type"]) && typeof body !== "string") {
					body = JSON.stringify(body, undefined, 4);
				}
			}

			response.writeHead(statusCode, headers);
			response.end(body);
		} catch (error) {
			if (statusCode < 500) {
				statusCode = 500;
			}

			console.error(error.stack);

			response.writeHead(statusCode, headers);
			response.end(body ?? "Internal server error");
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
