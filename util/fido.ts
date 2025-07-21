import { Bottleneck } from "../util/bottleneck";
import * as util from "util"
import * as fs from "fs"
import * as path from "path";
import { isBrowser } from "./env";

// FROM: https://github.com/zaaack/keyv-file/blob/master/index.ts#L41
class KeyvFile {
	private options = {
		deserialize: JSON.parse,
		expiredCheckDelay: 24 * 3600 * 1000, // ms
		filename: `.cache/keyv-file.json`,
		serialize: (value) => JSON.stringify(value, undefined, 4),
		writeDelay: 100, // ms
		checkFileLock: false
	};
	private _cache: object;
	private _lastExpire: number

	constructor(options = {}) {
		this.options = { ...this.options, ...options };
		if (!isBrowser && this.options.checkFileLock) {
			this.acquireFileLock()
		}
		try {
			const data = this.options.deserialize(
				fs.readFileSync(this.options.filename, 'utf8')
			)
			this._cache = data.cache
			this._lastExpire = data.lastExpire
		} catch (e) {
			this._cache = {}
			this._lastExpire = Date.now()
		}
	}

	private get _lockFile() {
		return this.options.filename + '.lock'
	}

	acquireFileLock() {
		try {
			let fd = fs.openSync(this._lockFile, "wx");
			fs.closeSync(fd)

			process.on('SIGINT', () => {
				fs.unlinkSync(this._lockFile);
				process.exit(0)
			})
			process.on('exit', () => {
				this.releaseFileLock()
			})
		} catch (error) {
			console.error(`[keyv-file] There is another process using this file`)
			throw error;
		}
	}

	releaseFileLock() {
		fs.unlinkSync(this._lockFile);
	}

	public async get(key: string) {
		try {
			const data = this._cache[key];
			if (this.isExpired(data)) {
				delete this._cache[key]
			}
			return data?.value
		} catch (error) {}
	}

	public async set(key: string, value: any, ttl?: number) {
		if (ttl === 0) {
			ttl = undefined
		}
		this._cache[key] = {
			expire: typeof ttl === "number" ? Date.now() + ttl : undefined,
			value: value as any,
		};
		return this.save()
	}

	private isExpired(data) {
		return typeof data.expire === "number" && data.expire <= Date.now()
	}

	private clearExpire() {
		const now = Date.now();
		if (now - this._lastExpire <= this.options.expiredCheckDelay) {
			return;
		}
		for (const [key, value] of Object.entries(this._cache)) {
			if (this.isExpired(value)) {
				delete this._cache[key]
			}
		}
		this._lastExpire = now
	}

	private saveToDisk() {
		const data = this.options.serialize({
			"cache": this._cache,
			"lastExpire": this._lastExpire,
		});

		return new Promise<void>((resolve, reject) => {
			const dirname = path.dirname(this.options.filename);

			if (!(fs.existsSync(dirname))) {
				fs.mkdirSync(dirname, { "recursive": true })
			}

			try {
				fs.writeFileSync(this.options.filename, data)
			} catch (error) {
				reject(error);

				return;
			}

			resolve()
		});
	}

	private _savePromise?: Promise<any> | undefined

	private save() {
		this.clearExpire()
		if (this._savePromise) {
			return this._savePromise
		}
		this._savePromise = isBrowser ? Promise.resolve() : new Promise<void>((resolve, reject) => {
			setTimeout(() => {
				this.saveToDisk()
					.then(resolve, reject)
					.finally(() => {
						this._savePromise = undefined
					})
			}, this.options.writeDelay)
		});
		return this._savePromise
	}
}

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

function extendedFetch(url, { cache, cacheKey, debug, fetch, limiter, retry, ...options }): Promise<Response> {
	return new Promise(function(resolve, reject) {
		const requestBuffer = [];

		if (debug) {
			requestBuffer.push(options["method"].toUpperCase() + " " + url);
		}

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
					resolve(new Response(JSON.stringify(body), { status }))
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

			limiter.schedule(function() {
				const responseBuffer = [];

				return fetch(url, options)
					.then(async function(response) {
						if (debug) {
							responseBuffer.push("HTTP " + String(response.status) + " " + response.statusText);

							for (const header of ["Content-Length", "Content-Type", "Retry-After", "Server", "X-Powered-By", /Rate-Limit/ui]) {
								if (header instanceof RegExp) {
									for (const [key, value] of response.headers.entries()) {
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

							const body = await attemptParse(response);

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
						} else if (!(url instanceof Request)) {
							const body = await attemptParse(response);

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

						flush([requestBuffer, responseBuffer], console.log);
					})
					.catch(function(error) {
						if (debug) {
							responseBuffer.push(error.toString());
						}

						flush([requestBuffer, responseBuffer], console.log);

						throw error;
					});
			});
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

function fetchFactory(baseUrl?, defaultOptions = {}) {
	defaultOptions["fetch"] ??= globalThis.fetch;
	defaultOptions["retry"] ??= ({ method }) => method === "get";
	defaultOptions["headers"] ??= {};
	defaultOptions["debug"] ??= process.env["NODE_ENV"] !== "production"

	if (defaultOptions["debug"] && defaultOptions["cache"]) {
		cache ??= new KeyvFile();

		defaultOptions["cache"] = cache;
	}

	if (limiter !== false && limiter === undefined) {
		// 100 requests/minute
		limiter = new Bottleneck({
			"minTime": Math.floor(60_000 / 100),
			"reservoir": 100,
			"reservoirRefreshAmount": 100,
			"reservoirRefreshInterval": 60_000
		});
	}

	defaultOptions["limiter"] ??= limiter;

	if (defaultOptions["limiter"] instanceof Bottleneck && defaultOptions["retry"]) {
		defaultOptions["limiter"].on("failed", function(error, { "options": { id }, retryCount }) {
			const { request, response } = error;

			if (defaultOptions["retry"] === false || (typeof defaultOptions["retry"] === "function" && defaultOptions["retry"]({ "method": request.method }) === false)) {
				throw error;
			}

			let [header, reset] = response.headers.entries().find(([header]) => /Rate-Limit-(After|Reset)/ui.test(header)) ?? [];

			reset = reset * 1000;

			if (reset >= Date.now()) {
				reset -= Date.now();
			}

			if (retryCount < 2) {
				const jitter = Math.floor(Math.random() * 500);

				return (reset || (2 ** (retryCount + 1)) * 1000) + jitter;
			} else  {
				throw error;
			}
		});
	}

	return async function(url, query?, options = {}) {
		if (typeof url === "string") {
			url = new URL(url, baseUrl);
		}

		query = {
			...Object.fromEntries(new URLSearchParams(url.search)),
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
		"fetch": (url, query?, options?) => (fido.fetch = fetchFactory(baseUrl, defaultOptions))(url, query, options),
		"get": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "GET" }),
		"post": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "POST" }),
		"put": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "PUT" }),
		"patch": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "PATCH" }),
		"delete": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "DELETE" }),
		"limit": function(amount) {
			if (defaultOptions["limiter"] !== false) {
				const limiter = new Bottleneck(typeof amount === "number" ? {
					"reservoir": amount,
					"reservoirRefreshAmount": amount,
					"reservoirRefreshInterval": 60_000
				} : amount);

				defaultOptions["limiter"] = defaultOptions["limiter"] instanceof Bottleneck ? defaultOptions["limiter"].chain(limiter) : limiter;
			}

			return withDefaults(baseUrl, defaultOptions)
		}
	};

	return fido;
}

export const fido = {
	"fetch": (url, query?, options?) => (fido.fetch = fetchFactory())(url, query, options),
	"get": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "GET" }),
	"post": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "POST" }),
	"put": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "PUT" }),
	"patch": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "PATCH" }),
	"delete": (url, query?, options?) => fido.fetch(url, options ?? (query && Object.values(query).every((v) => typeof v !== "object") ? query : undefined), { ...(options ?? query), "method": "DELETE" }),
};
