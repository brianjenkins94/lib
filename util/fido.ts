import * as Bottleneck from "bottleneck";
import * as util from "util";

// 100 requests/minute
const limiter = new Bottleneck({
	"reservoir": 100,
	"reservoirRefreshAmount": 100,
	"reservoirRefreshInterval": 60_000
});

limiter.on("failed", function(error, { retryCount }) {
	if (retryCount < 2) {
		return (2 ** (retryCount + 1)) * 1000;
	}

	return undefined;
});

function flush(buffer, callback) {
	for (let x = 0; x < buffer.length; x++) {
		if (x % 2 === 0) {
			callback("--> " + buffer[x].join("\n--> "));
		} else {
			callback("\n<-- " + buffer[x].join("\n<-- ") + "\n");
		}
	}
}

let SaxesParser;

// FROM: https://github.com/tomas/needle/blob/cfc51beac3c209d7eeca2f1ba546f67d9aa780ea/lib/parsers.js#L9
function parseXml(xmlString) {
	const parser = new SaxesParser();

	return new Promise(function(resolve, reject) {
		let object;
		let current;

		parser.on("error", function(error) {
			reject(error);
		});

		parser.on("text", function(text) {
			if (current !== undefined) {
				current.value += text;
			}
		});

		parser.on("opentag", function({ name, attributes }) {
			const element = {
				"name": name ?? "",
				"value": "",
				"attributes": attributes
			};

			if (current !== undefined) {
				element["parent"] = current;

				current["children"] ??= [];

				current.children.push(element);
			} else {
				object = element;
			}

			current = element;
		});

		parser.on("closetag", function() {
			if (current.parent !== undefined) {
				const previous = current;

				current = current.parent;

				delete previous.parent;
			}
		});

		parser.on("end", function() {
			resolve(object);
		});

		parser.write(xmlString).close();
	});
}

async function attemptParse(response: Response): Promise<any> {
	const arrayBuffer = response.arrayBuffer();

	let body;

	response.arrayBuffer = async function() {
		return arrayBuffer;
	};

	let contentType = response.headers?.get("Content-Type");
	const contentLength = response.headers.get("Content-Length");

	if (contentType === undefined && parseInt(contentLength) > 0) {
		body = new TextDecoder().decode(await arrayBuffer);

		if (/[^\r\n\x20-\x7E]/ui.test(body)) {
			contentType = "text/plain";
		}
	}

	if (contentType?.endsWith("json")) {
		try {
			body ??= JSON.parse(new TextDecoder().decode(await arrayBuffer));

			response.json = async function() {
				return body;
			};
			response.text = async function() {
				return JSON.stringify(body, undefined, 2);
			};
		} catch (error) { }
	} else if (contentType?.startsWith("text") && !contentType?.endsWith("xml")) {
		body ??= new TextDecoder().decode(await arrayBuffer);

		response.json = async function() {
			return JSON.parse(body);
		};
		response.text = async function() {
			return body;
		};
	} else if (SaxesParser !== null && contentType?.endsWith("xml")) {
		try {
			SaxesParser ??= (await import("saxes"))["default"]["SaxesParser"];

			body ??= new TextDecoder().decode(await arrayBuffer);

			body = parseXml(body);

			response["xml"] = async function() {
				return body;
			};
		} catch (error) {
			SaxesParser = null;
		}
	}

	return body;
}

function extendedFetch(url, options): Promise<Response> {
	return new Promise(function retry(resolve, reject) {
		const requestBuffer = [];

		if (options["debug"]) {
			requestBuffer.push(options.method.toUpperCase() + " " + url);
		}

		if (options["headers"]?.["Content-Type"] !== undefined) {
			if (options["debug"]) {
				for (const header of ["Content-Type"]) {
					if (options.headers[header] !== undefined) {
						requestBuffer.push(header + ": " + options.headers[header]);
					}
				}
			}

			if (options["headers"]["Content-Type"].endsWith("json") && typeof options.body === "object") {
				if (options["debug"]) {
					requestBuffer.push(...util.inspect(options.body, { "compact": false }).split("\n"));
				}

				options.body = JSON.stringify(options.body);
			}
		}

		limiter.schedule(function() {
			const responseBuffer = [];

			return fetch(url, options)
				.then(async function(response) {
					if (options["debug"]) {
						responseBuffer.push("HTTP " + String(response.status) + " " + response.statusText);

						for (const header of ["Content-Length", "Content-Type", "Server", "X-Powered-By"]) {
							if (response.headers.has(header)) {
								responseBuffer.push(header + ": " + response.headers.get(header));
							}
						}
					}

					if (response.status >= 400 && response.status < 500 && options.method === "get") {
						responseBuffer.push("Request failed with " + (String(response.status) + " " + response.statusText).trim());

						const body = await attemptParse(response);

						if (body !== undefined) {
							responseBuffer.push(...util.inspect(body, { "compact": false }).split("\n"));
						}

						responseBuffer.push("Retrying...");

						throw new Error();
					} else {
						const body = await attemptParse(response);

						if (body !== undefined) {
							responseBuffer.push(...util.inspect(body, { "compact": false }).split("\n"));
						}

						resolve(response);
					}

					flush([requestBuffer, responseBuffer], console.log);
				})
				.catch(function(error) {
					if (options["debug"]) {
						responseBuffer.push(error.toString());
					}

					flush([requestBuffer, responseBuffer], console.log);

					throw new Error(error);
				});
		});
	});
}

function fetchFactory(method, baseUrl?, defaultOptions = {}) {
	return async function(url, query = {}, options = {}): Promise<Response> {
		url = new URL(url, baseUrl);

		if (!Object.values(query).every(function(value) { return typeof value !== "object"; })) {
			options = query;
			query = {};
		}

		query = {
			...Object.fromEntries(new URLSearchParams(url.search)),
			...query
		};

		if (Object.entries(query).length > 0) {
			url.search = new URLSearchParams(query);
		}

		if (options["body"] !== undefined) {
			if (method === "get") {
				throw new Error("That's illegal.");
			} else if (options["headers"]?.["Content-Type"] === undefined) {
				throw new Error("`Content-Type` is required when providing a payload.");
			}
		}

		const response: Response = await extendedFetch(new URL(url).toString(), {
			...options,
			"headers": {
				...defaultOptions?.["headers"],
				...options["headers"]
			},
			"debug": options["debug"] ?? process.env["NODE_ENV"] !== "production",
			"method": method
		});

		return response;
	};
}

export const get = fetchFactory("get");
export const post = fetchFactory("post");
export const put = fetchFactory("put");
export const del = fetchFactory("delete");

export function poll(url, query = {}, options = {}, condition: (response: Response) => Promise<boolean> = async function(response) { return Promise.resolve(response.ok); }): Promise<Response> {
	url = new URL(url);

	if (typeof query === "function") {
		// @ts-expect-error
		condition = query;
		query = {};
		options = {};
	} else if (typeof options === "function") {
		// @ts-expect-error
		condition = options;
		options = {};
	}

	if (!Object.values(query).every(function(value) { return typeof value !== "object"; })) {
		options = query;
		query = {};
	}

	query = {
		...Object.fromEntries(new URLSearchParams(url.search)),
		...query
	};

	if (Object.entries(query).length > 0) {
		url.search = new URLSearchParams(query);
	}

	if (options["body"] !== undefined) {
		throw new Error("That's illegal.");
	}

	return new Promise(async function(resolve, reject) {
		const response = await get(new URL(url).toString(), options);

		if (await condition(response)) {
			resolve(response);
		} else {
			throw new Error();
		}
	});
}

export function withDefaults(baseUrl, options) {
	return {
		"get": fetchFactory("get", baseUrl, options),
		"post": fetchFactory("post", baseUrl, options),
		"put": fetchFactory("put", baseUrl, options),
		"del": fetchFactory("delete", baseUrl, options)
	};
}
