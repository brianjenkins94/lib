import Bottleneck from "bottleneck/light";
import * as util from "util"
import * as fs from "fs"
import * as path from "path";
import { isBrowser } from "./env";

// FROM: https://github.com/zaaack/keyv-file/blob/master/index.ts#L41
class KeyvFile {
	public namespace?: string | undefined
	public options = {
		deserialize: JSON.parse,
		expiredCheckDelay: 24 * 3600 * 1000, // ms
		filename: `.cache/keyv-file.json`,
		serialize: (value) => JSON.stringify(value, undefined, 4),
		writeDelay: 100, // ms
		checkFileLock: false,
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

	public async get<Value>(key: string): Promise<StoredData<Value> | undefined> {
		try {
			const data = this._cache[key];
			if (!data) {
				return undefined;
			} else if (this.isExpired(data)) {
				delete this._cache[key]
				return undefined;
			} else {
				return data.value as StoredData<Value>
			}
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

	private isExpired(data: WrappedValue) {
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

	public async *iterator(namespace?: string) {
		for (const [key, { value }] of Object.entries(this._cache)) {
			if (key === undefined) {
				continue;
			}

			if (namespace === undefined || key.includes(namespace)) {
				yield [key, value];
			}
		}
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

async function sha1(string: string) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(string))),
		(byte) => byte.toString(16).padStart(2, "0")
	).join("");
}

function extendedFetch(url, { cache, debug, fetch, limiter, retry, ...options }): Promise<Response> {
	return new Promise(function(resolve, reject) {
		const requestBuffer = [];

		if (debug) {
			requestBuffer.push(options["method"].toUpperCase() + " " + url);
		}

		if (options["headers"]?.["Content-Type"] !== undefined) {
			if (debug) {
				for (const header of ["Content-Type"]) {
					if (options["headers"][header] !== undefined) {
						requestBuffer.push(header + ": " + options["headers"][header]);
					}
				}
			}

			if (options["headers"]["Content-Type"].endsWith("json")) {
				if (debug) {
					requestBuffer.push(...util.inspect(typeof options["body"] === "string" ? JSON.parse(options["body"]) : options["body"], { "compact": false, "maxStringLength": 1000 }).split("\n"));
				}
			}
		}

		const key = options["method"] + ":" + url + (options["body"] !== undefined && !(options["body"] instanceof ReadableStream) ? ":" + sha1(options["body"]) : "")

		const cacheHeader = options["headers"]?.["Cache"] ?? options["headers"]?.["cache"];

		let didResolve = false;
		let cachePromise = Promise.resolve();

		if (cacheHeader !== undefined && [true, "force-cache", "only-if-cached"].includes(cacheHeader)) {
			cachePromise = cache.get(key)
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

							for (const header of ["Content-Length", "Content-Type", "Retry-After", "Server", "X-Powered-By"]) {
								if (response.headers.has(header)) {
									responseBuffer.push(header + ": " + response.headers.get(header));
								}
							}
						}

						if (response.status >= 400 && response.status < 500) {
							responseBuffer.push("Request failed with " + (String(response.status) + " " + response.statusText).trim());

							const body = await attemptParse(response);

							if (body !== undefined) {
								responseBuffer.push(...util.inspect(body, { "compact": false }).split("\n"));
							}

							if ((typeof retry === "boolean" && retry === true) || (typeof retry === "function" && retry(options))) {
								responseBuffer.push("Retrying...");

								throw new Error("Response status code: " + response.status);
							}
						} else {
							const body = await attemptParse(response);

							if (body !== undefined) {
								responseBuffer.push(...util.inspect(body, { "compact": false }).split("\n"));
							}

							if (response.ok && cacheHeader !== undefined && [true, "reload", "no-cache", "force-cache"].includes(cacheHeader)) {
								cache.set(key, {
									"url": response.url,
									"status": response.status,
									"body": body
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

let cache;

let limiter;

function fetchFactory(method, baseUrl?, defaultOptions = {}) {
	defaultOptions["fetch"] ??= globalThis.fetch;
	defaultOptions["retry"] ??= ({ method }) => method === "get";
	defaultOptions["headers"] ??= {};
	defaultOptions["debug"] ??= process.env["NODE_ENV"] !== "production"

	if (defaultOptions["debug"] && defaultOptions["cache"] === undefined) {
		cache ??= new KeyvFile();

		defaultOptions["cache"] = cache;
	}

	if (limiter === undefined) {
		// 100 requests/minute
		limiter = new Bottleneck({
			"reservoir": 100,
			"reservoirRefreshAmount": 100,
			"reservoirRefreshInterval": 60_000
		});

		if (defaultOptions["retry"] === true || defaultOptions["retry"]({ method }) === true) {
			// This could present an issue with parallel requests.
			limiter.on("failed", function(error, { "options": { id }, retryCount }) {
				if (retryCount < 2) {
					return (2 ** (retryCount + 1)) * 1000;
				}
			});
		}
	}

	defaultOptions["limiter"] ??= limiter;

	const fetch = async function(url, query = {}, options = {}): Promise<Response> {
		url = new URL(url, baseUrl);

		if (typeof query === "object" && query["body"] !== undefined && [defaultOptions, query, options].some(({ headers }) => headers["Content-Type"])) {
			options = query;
			query = {};
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
			if (method === "get") {
				throw new Error("That's illegal.");
			} else if (options["headers"]?.["Content-Type"] === undefined) {
				throw new Error("`Content-Type` is required when providing a payload.");
			}
		}

		const response: Response = await extendedFetch(new URL(url).toString(), {
			...options,
			"headers": {
				"Cache": options["headers"]?.["cache"] ?? ((options["debug"] ?? defaultOptions["debug"]) || "no-store"),
				...options["headers"]
			},
			"cache": options["cache"] ?? cache,
			"debug": options["debug"] ?? defaultOptions["debug"],
			"limiter": options["limiter"] ?? defaultOptions["limiter"],
			"method": method,
			"fetch": defaultOptions["fetch"],
			"retry": options["retry"] ?? defaultOptions["retry"]
		});

		return response;
	};

	return fetch;
}

export const get = fetchFactory("get");
export const post = fetchFactory("post");
export const put = fetchFactory("put");
export const del = fetchFactory("delete");

export function poll(url, query = {}, options = {}, condition: (response: Response) => Promise<boolean> = async (response) => response.ok): Promise<Response> {
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

	if (typeof query === "object" && query["body"] !== undefined && [query, options].some(({ headers }) => headers["Content-Type"])) {
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
			reject(new Error("Did not pass condition."));
		}
	});
}

export function withDefaults(baseUrl, options = {}) {
	return {
		"get": fetchFactory("get", baseUrl, options),
		"post": fetchFactory("post", baseUrl, options),
		"put": fetchFactory("put", baseUrl, options),
		"del": fetchFactory("delete", baseUrl, options),
		"limit": function(amount) {
			const limiter = new Bottleneck({
				"reservoir": amount,
				"reservoirRefreshAmount": amount,
				"reservoirRefreshInterval": 60_000
			});

			options["limiter"] = limiter;

			return {
				"get": fetchFactory("get", baseUrl, options),
				"post": fetchFactory("post", baseUrl, options),
				"put": fetchFactory("put", baseUrl, options),
				"del": fetchFactory("delete", baseUrl, options)
			};
		}
	};
}
