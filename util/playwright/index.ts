import type { Browser, BrowserContext, Page } from "playwright";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { mapSeries } from "@brianjenkins94/util/array";
import { __root, isWindows } from "@brianjenkins94/util/env";

import { defaultConditionCallback } from "@brianjenkins94/util/fido";
import * as fs from "@brianjenkins94/util/fs";
import { sleep } from "@brianjenkins94/util/sleep";
import { externalOptionalDeps, polyfillNodeRolldown } from "@brianjenkins94/util/vite/plugins/polyfillNode";
import { virtualFileSystem } from "@brianjenkins94/util/vite/plugins/virtualFileSystem";
import { chromium } from "playwright";

const browsers = {
	"Brave": {
		"binary": isWindows
			? (fs.existsSync(path.join(process.env["ProgramW6432"] ?? "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
					? path.join(process.env["ProgramW6432"] ?? "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
					: path.join(process.env["LOCALAPPDATA"] ?? "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
			: path.join("/", "Applications", "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
		"killArgs": isWindows ? ["/F", "/IM", "brave.exe", "/T"] : ["-INT", "\"Brave Browser\""],
		"profile": isWindows
			? path.join(process.env["LOCALAPPDATA"] ?? "", "BraveSoftware", "Brave-Browser", "User Data")
			: path.join(process.env["HOME"] ?? "", "Library", "Application Support", "BraveSoftware", "Brave-Browser")
	},
	"Chrome": {
		"binary": isWindows
			? path.join(process.env["ProgramW6432"] ?? "", "Google", "Chrome", "Application", "chrome.exe")
			: path.join("/", "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
		"killArgs": isWindows ? ["/F", "/IM", "chrome.exe", "/T"] : ["-INT", "\"Google Chrome\""],
		"profile": isWindows
			? path.join(process.env["LOCALAPPDATA"] ?? "", "Google", "Chrome", "User Data")
			: path.join(process.env["HOME"] ?? "", "Library", "Application Support", "Google", "Chrome")
	}
};

export async function attach(endpointURL = "http://127.0.0.1:9222", { timeout = 15_000 } = {}) {
	const url = new URL(endpointURL);
	const port = url.port || "9222";

	if (url.hostname === "localhost") {
		url.hostname = "127.0.0.1";
		endpointURL = url.toString();
	}

	if (url.hostname === "127.0.0.1") {
		try {
			await fetch(endpointURL);
		} catch (error) {
			const target = Object.values(browsers).find(({ binary }) => fs.existsSync(binary));

			if (target === undefined) {
				throw new Error(`No Brave/Chrome found to launch. Start one with --remote-debugging-port=${port} and an explicit --user-data-dir.`, { "cause": error });
			}

			await new Promise((resolve) => {
				const shell = spawn(isWindows ? "taskkill" : "killall", target.killArgs, { "shell": true });

				shell.on("error", resolve);
				shell.on("close", resolve);
			});

			await sleep(2500);

			spawn(target.binary, [
				`--user-data-dir=${target.profile}`,
				`--remote-debugging-port=${port}`,
				"--restore-last-session"
			], { "detached": true, "stdio": "ignore" }).unref();

			const deadline = Date.now() + 30_000;

			while (true) {
				try {
					await fetch(endpointURL);

					break;
				} catch {
					if (Date.now() > deadline) {
						throw new Error(`Relaunched ${target.binary} but ${endpointURL} never came up.`, { "cause": error });
					}

					await sleep(500);
				}
			}
		}
	}

	const browser = await chromium.connectOverCDP(endpointURL, { "timeout": timeout })
		.catch(function(error: unknown) {
			throw new Error(`Couldn't reach a CDP browser at ${endpointURL}. Start Chrome/Brave with --remote-debugging-port=${port} and an explicit --user-data-dir.`, { "cause": error });
		});

	return {
		"browser": browser,
		"contexts": browser.contexts(),
		[Symbol.asyncDispose]: async () => { await browser.close(); }
	};
}

let browser: Browser;

let context: BrowserContext;

export async function launch(url, options?) {
	options ??= {
		"devtools": true,
		"headless": false
	};

	browser ??= await chromium.launch(options);

	context ??= await browser.newContext();

	const page: Page = await context.newPage();

	await page.goto(url);

	const originalClose = page.close.bind(page);

	page.close = function(options?) {
		return mapSeries([
			() => originalClose(options),
			() => context.close(),
			() => browser.close()
		]);
	};

	return page;
}

const contents = async function({ url, query, options, id }) {
	if (!globalThis.fetch.toString().includes("[native code]")) {
		console.warn("`fetch` appears to have been overwritten.");

		const iframe = document.createElement("iframe");

		document.body.append(iframe);

		globalThis.fetch = iframe.contentWindow.fetch;
	}

	globalThis["__fido"] ??= {};
	globalThis["__fido"][id] = await fido[options["method"].toLowerCase()](url, query, options);
}.toString();

let vite;

try {
	vite = await import("vite");
} catch (error) {}

let bundle;

async function fetchFactory(baseUrl?, defaultOptions = {}) {
	bundle ??= (await vite.build({
		"mode": "production",
		"root": __root,
		"build": {
			"rolldownOptions": {
				"input": "index.ts",
				"treeshake": false,
				"external": ["saxes"],
				// One self-contained chunk — the page's AsyncFunction body can't `import` a sibling chunk.
				"output": { "codeSplitting": false }
			},
			"minify": false,
			"modulePreload": { "polyfill": false },
			"write": false
		},
		"define": {
			"import.meta.url": "('file://' + location.pathname)",
			"import.meta.resolve": "undefined"
		},
		"plugins": [
			// Honor `/*! @external */` on optional dynamic imports (e.g. the node-only store).
			externalOptionalDeps(),
			// `pre` so it redirects `node:*` before Vite externalizes builtins to its browser-external stub.
			// It inlines the functional polyfills (path/url/util) into the one bundle and shims `process` — so
			// output[0].code is fully self-contained, no external `import`s, runnable as an AsyncFunction body.
			{ ...polyfillNodeRolldown(["path", "url", "util"]), "enforce": "pre" },
			virtualFileSystem({
				"index.ts": [
					"import { fido } from \"./util/fido\";",
					contents.substring(contents.indexOf("{", contents.indexOf(")") + 1) + 1, contents.lastIndexOf("}"))
				].join("\n")
			})
		]
	})).output[0].code;

	const args = contents.substring(contents.indexOf("(") + 1, contents.indexOf(")"));
	const functionBody = bundle + `
		const __fidoResponse = globalThis.__fido[id];
		try {
			return {
				"status": __fidoResponse.status,
				"statusText": __fidoResponse.statusText,
				"headers": Object.fromEntries(__fidoResponse.headers.entries()),
				"body": Array.from(new Uint8Array(await __fidoResponse.arrayBuffer()))
			};
		} finally { delete globalThis.__fido[id]; }
	`;

	const AsyncFunction = async function() { }.constructor;

	return async function(page, url, query?, options?) {
		// @ts-expect-error
		const result = await page.evaluate(new AsyncFunction(args, functionBody), {
			"url": url instanceof Request ? url.url : url,
			"query": query,
			"options": options,
			"id": randomUUID()
		});

		return new Response([101, 204, 205, 304].includes(result.status) ? null : new Uint8Array(result.body), {
			"status": result.status,
			"statusText": result.statusText,
			"headers": result.headers
		});
	};
}

export const fido = {
	"fetch": async (page, url, query?, options?) => (fido.fetch = await fetchFactory())(page, url, query, options),
	"get": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "GET" }),
	"post": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "POST" }),
	"put": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "PUT" }),
	"patch": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "PATCH" }),
	"delete": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "DELETE" }),
	"poll": (page, url, query?, options?) => (async function poll(page, url, query: Record<string, string> = {}, { conditionCallback = defaultConditionCallback, initialValue = [], ...options }) {
		if (typeof url === "string") {
			url = new URL(url);
		}

		url.search = new URLSearchParams([
			...new URLSearchParams(url.search).entries(),
			...Object.entries(query)
		]).toString();

		const currentValue = initialValue;

		let request = new Request(url.toString(), {
			"method": options["method"] ?? "GET",
			"headers": options["headers"],
			"body": options["body"]
		});

		for (let callCount = 1; request instanceof Request; callCount++) {
			const response = await fido[request.method.toLowerCase()](page, request);

			request = await conditionCallback(currentValue, {
				"request": request,
				"response": response
			}, callCount);
		}

		return request;
	})(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { "method": "GET", ...(options ?? query) })
};

export function getHref(page) {
	return page.evaluate(function() {
		return location.href;
	});
}

/*
import * as url from "url";

if (import.meta.url === url.pathToFileURL(process.argv[1]).toString()) {
	await fetch();
}
*/
