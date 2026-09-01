import * as util from "node:util";
import { Bottleneck } from "@brianjenkins94/util/bottleneck";
import { isBrowser } from "@brianjenkins94/util/env";
import { log } from "@brianjenkins94/util/logger";
import { attemptParse } from "./parse";
import { poll } from "./poll";
import { backoff, defaultRetry } from "./retry";

export { defaultConditionCallback } from "./poll";

function extendedFetch(url, { cache, cacheKey, debug, fetch, limiter, retry, ...options }): Promise<Response> {
	if (debug && url instanceof Request) {
		options["body"] = url["body"];
		options["headers"] = Object.fromEntries(url.headers);
	}

	return new Promise(function(resolve, reject) {
		const requestBuffer = [];

		const summary = options["method"].toUpperCase() + " " + (url instanceof Request ? url.url : url);

		if (debug && options["headers"]?.["Content-Type"] !== undefined) {
			for (const header of ["Content-Type"]) {
				if (options["headers"][header] !== undefined) {
					requestBuffer.push(header + ": " + options["headers"][header]);
				}
			}

			if (options["headers"]["Content-Type"].endsWith("json")) {
				requestBuffer.push(...util.inspect(typeof options["body"] === "string" ? JSON.parse(options["body"]) : options["body"], { "compact": false, "maxStringLength": 1000 }).split("\n"));
			}
		}

		const cacheHeader = options["headers"]?.["Cache"] ?? options["headers"]?.["cache"];

		let didResolve = false;
		let cachePromise = Promise.resolve();

		if (cache && cacheHeader !== undefined && [true, "force-cache", "only-if-cached"].includes(cacheHeader)) {
			cachePromise = cache.get(cacheKey)
				.then(function({ body, status }) {
					didResolve = true;
					resolve(new Response(JSON.stringify(body), { "status": status }));
				})
				.catch(function(error) {
					if (cacheHeader === "only-if-cached") {
						didResolve = true;
						resolve(new Response(null, {
							"status": 504,
							"statusText": "Gateway Timeout"
						}));
					}
				});
		}

		cachePromise.then(function() {
			if (didResolve) {
				return;
			}

			limiter.schedule(async function() {
				const responseBuffer = [];

				using span = debug ? log.span(summary) : undefined;

				if (debug) {
					for (const line of requestBuffer) {
						span.debug(line);
					}
				}

				try {
					const response = await fetch(url, options);

					if (debug) {
						responseBuffer.push("HTTP " + String(response.status) + " " + response.statusText);

						for (const header of ["Content-Length", "Content-Type", "Retry-After", "Server", "X-Powered-By", /Rate-Limit/ui]) {
							if (header instanceof RegExp) {
								for (const [key, value] of response.headers) {
									if (header.test(key)) {
										responseBuffer.push(key.replace(/(^\w|-\w)/gu, (match) => match.toUpperCase()) + ": " + value);
									}
								}
							} else if (response.headers.has(header)) {
								responseBuffer.push(header + ": " + response.headers.get(header));
							}
						}
					}

					if (response.status >= 400 && response.status < 500) {
						responseBuffer.push("Request failed with " + (String(response.status) + " " + response.statusText).trim());

						const body = await attemptParse(response.clone());

						if (debug && body !== undefined) {
							responseBuffer.push(...util.inspect(body, { "compact": false }).split("\n"));
						}

						if (retry === true || (typeof retry === "function" && retry(options))) {
							responseBuffer.push("Retrying...");

							const error = new Error("Response status code: " + response.status);

							error["request"] = {
								"body": options["body"],
								"headers": options["headers"],
								"method": options["method"],
								"url": url
							};

							error["response"] = {
								"body": body,
								"headers": response.headers,
								"ok": response.ok,
								"redirected": response.redirected,
								"status": response.status,
								"statusText": response.statusText,
								"type": response.type,
								"url": response.url
							};

							throw error;
						}
					} else {
						const body = await attemptParse(response.clone());

						if (debug && body !== undefined) {
							responseBuffer.push(...util.inspect(body, { "compact": false }).split("\n"));
						}

						if (response.ok && cache && cacheHeader !== undefined && [true, "reload", "no-cache", "force-cache"].includes(cacheHeader)) {
							cache.set(cacheKey, {
								"body": body,
								"status": response.status,
								"url": response.url
							});
						}
					}

					resolve(response);
				} catch (error) {
					if (debug) {
						responseBuffer.push(error.toString());
					}

					throw error;
				} finally {
					if (debug) {
						for (const line of responseBuffer) {
							span.debug(line);
						}
					}
				}
			}).catch(reject);
		});
	});
}

async function sha1(string: string) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(string))),
		(byte) => byte.toString(16).padStart(2, "0")
	).join("");
}

let cache;

let limiter;

async function fetchFactory(baseUrl?, defaultOptions = {}) {
	defaultOptions["fetch"] ??= globalThis.fetch;
	defaultOptions["retry"] ??= defaultRetry;
	defaultOptions["headers"] ??= {};
	defaultOptions["debug"] ??= process.env["NODE_ENV"] !== "production";

	if (defaultOptions["debug"] && defaultOptions["cache"]) {
		if (!isBrowser) {
			cache ??= new (await import(/*! @external */ "@brianjenkins94/util/store")).PersistentStore();
		}

		defaultOptions["cache"] = cache;
	}

	if (limiter !== false && limiter === undefined) {
		limiter = new Bottleneck({
			"reservoir": 100,
			"reservoirRefreshAmount": 100,
			"reservoirRefreshInterval": 60_000
		});
	}

	defaultOptions["limiter"] ??= limiter;

	if (defaultOptions["limiter"] instanceof Bottleneck && defaultOptions["retry"]) {
		defaultOptions["limiter"].retryHandler = backoff(defaultOptions["retry"]);
	}

	return async function(url, query?, options = {}) {
		if (typeof url === "string") {
			url = new URL(url, baseUrl);
		}

		query = {
			...new URLSearchParams(url.search),
			...query
		};

		if (Object.keys(query).length > 0) {
			url.search = new URLSearchParams(query);
		}

		options["headers"] = {
			...defaultOptions["headers"],
			...options["headers"]
		};

		if (options["body"] !== undefined) {
			if (options["method"] === "get") {
				throw new Error("That's illegal.");
			} else if (options["headers"]?.["Content-Type"] === undefined) {
				throw new Error("`Content-Type` is required when providing a payload.");
			}
		}

		return extendedFetch(url, {
			...options,
			"headers": {
				"Cache": options["headers"]?.["Cache"] ?? options["headers"]?.["cache"] ?? (((options["debug"] ?? defaultOptions["debug"]) && options["method"] === "get") || "no-store"),
				...options["headers"]
			},
			"cache": options["cache"] ?? cache,
			"cacheKey": options["method"] + ":" + url + (options["body"] !== undefined && !(options["body"] instanceof ReadableStream) ? ":" + await sha1(options["body"]) : ""),
			"debug": options["debug"] ?? defaultOptions["debug"],
			"limiter": options["limiter"] ?? defaultOptions["limiter"],
			"method": options["method"].toUpperCase(),
			"fetch": defaultOptions["fetch"],
			"retry": options["retry"] ?? defaultOptions["retry"]
		});
	};
}

export function withDefaults(baseUrl, defaultOptions = {}) {
	const fido = {
		"fetch": async (url, query?, options?) => (fido.fetch = await fetchFactory(baseUrl, defaultOptions))(url, query, options),
		"get": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "GET" }),
		"post": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "POST" }),
		"put": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "PUT" }),
		"patch": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "PATCH" }),
		"delete": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "DELETE" }),
		"poll": (url, query?, options?) => (fido.poll = (url, query?, options?) => (poll.bind(fido))(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { "method": "GET", ...(options ?? query) }))(url, query, options),
		"limit": function(amount) {
			if (defaultOptions["limiter"] !== false) {
				const limiter = new Bottleneck(typeof amount === "number" ? {
					"reservoir": amount,
					"reservoirRefreshAmount": amount,
					"reservoirRefreshInterval": 60_000
				} : amount);

				defaultOptions["limiter"] = defaultOptions["limiter"] instanceof Bottleneck ? defaultOptions["limiter"].chain(limiter) : limiter;
			}

			return withDefaults(baseUrl, defaultOptions);
		}
	};

	return fido;
}

export const fido = {
	"fetch": async (url, query?, options?) => (fido.fetch = await fetchFactory())(url, query, options),
	"get": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "GET" }),
	"post": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "POST" }),
	"put": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "PUT" }),
	"patch": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "PATCH" }),
	"delete": (url, query?, options?) => fido.fetch(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "DELETE" }),
	"poll": (url, query?, options?) => (fido.poll = (url, query?, options?) => (poll.bind(fido))(url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { "method": "GET", ...(options ?? query) }))(url, query, options)
};
