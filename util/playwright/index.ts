import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "../fs"

import { __root, isWindows } from "../env";
import { sleep } from "../sleep";
import { mapSeries } from "../array";
import { defaultConditionCallback } from "../fido";
import { polyfillNode } from "../vite/plugins/polyfillNode";
import { virtualFileSystem } from "../vite/plugins/virtualFileSystem";

const browsers = {
	"Brave": {
		"path": isWindows ? (fs.existsSync(path.join(process.env["ProgramW6432"], "BraveSoftware", "Brave-Browser", "Application", "brave.exe")) ? path.join(process.env["ProgramW6432"], "BraveSoftware", "Brave-Browser", "Application", "brave.exe") : path.join(path.join(process.env["LOCALAPPDATA"], "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))) : path.join("/", "Applications", "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
		"args": isWindows ? ["/F", "/IM", "brave.exe", "/T"] : ["-INT", "\"Brave Browser\""]
	},
	"Chrome": {
		"path": isWindows ? path.join(process.env["ProgramW6432"], "Google", "Chrome", "Application", "chrome.exe") : path.join("/", "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
		"args": isWindows ? ["/F", "/IM", "chrome.exe", "/T"] : ["-INT", "\"Google Chrome\""]
	}
}

export async function attach(endpointURL = "http://localhost:9222") {
	if (new URL(endpointURL).hostname === "localhost") {
		for (const browser of Object.values(browsers).filter(({ path }) => fs.existsSync(path))) {
			try {
				await fetch(endpointURL);
			} catch (error) {
				const shell = spawn(isWindows ? "taskkill" : "killall", browser.args, {
					"shell": true
				});

				const code = await new Promise(function(resolve, reject) {
					shell.on("error", function(error) {
						console.warn(error);
					});

					shell.on("close", function(code) {
						resolve(code);
					});
				});

				if (code === 0 || (isWindows ? code === 128 : code === 1)) {
					spawn(browser.path, [
						// https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md#Windows
						//"--enable-logging=stderr --v=1",
						"--remote-debugging-port=9222",
						"--restore-last-session",
						//"--user-data-dir=" + (isWindows ? path.join(process.env["LOCALAPPDATA"], "Google", "Chrome", "User Data") : path.join(process.env["HOME"], "Library", "Application Support", "Google", "Chrome"))
						//"--profile-directory=Default"
					], {
						"detached": true
					});

					await sleep(1000);

					break;
				} else {
					console.warn("Command exited with non-zero exit-code: " + code);
				}
			}
		}
	}

	const browser = await chromium.connectOverCDP(endpointURL);

	return {
		"browser": browser,
		"contexts": browser.contexts(),
		[Symbol.asyncDispose]: async () => { await browser.close(); },
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

const contents = async function({ url, query, options }) {
	if (!globalThis.fetch.toString().includes("[native code]")) {
		console.warn("`fetch` appears to have been overwritten.");

		const iframe = document.createElement("iframe");

		document.body.append(iframe);

		globalThis.fetch = iframe.contentWindow.fetch;
	}

	const response = await fido[options["method"].toLowerCase()](url, query, options);
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
				"external": ["saxes"]
			},
			"minify": false,
			"modulePreload": { "polyfill": false },
			"write": false
		},
		"define": {
			"import.meta.url": "location.pathname",
			"process": "{ \"env\": {} }"
		},
		"plugins": [
			polyfillNode(["fs", "path", "url"]),
			virtualFileSystem({
				"index.ts": [
					"import { fido } from \"./util/fido\";",
					contents.substring(contents.indexOf("{", contents.indexOf(")") + 1) + 1, contents.lastIndexOf("}"))
						.replace(/const response ?= ?await/u, "globalThis.__response = await")
				].join("\n")
			})
		]
	})).output[0].code;

	const args = contents.substring(contents.indexOf("(") + 1, contents.indexOf(")"));
	const functionBody = bundle + `
		// Must be [serializable](https://playwright.dev/docs/evaluating#evaluation-argument).
		return Array.from(new Uint8Array(await globalThis.__response.arrayBuffer()));
	`;

	const AsyncFunction = (async function() { }).constructor;

	return async function(page, url, query?, options?) {
		// @ts-expect-error
		const body = await page.evaluate(new AsyncFunction(args, functionBody), {
			"url": url instanceof Request ? url.url : url,
			"query": query,
			"options": options
		});

		const response = new Response(new Uint8Array(body));

		return response;
	};
}

export const fido = {
	"fetch": async (page, url, query?, options?) => (fido.fetch = await fetchFactory())(page, url, query, options),
	"get": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "GET" }),
	"post": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "POST" }),
	"put": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "PUT" }),
	"patch": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "PATCH" }),
	"delete": (page, url, query?, options?) => fido.fetch(page, url, options === undefined && (query && Object.values(query).every((value) => typeof value !== "object") ? query : undefined), { ...(options ?? query), "method": "DELETE" }),
	"poll": (page, url, query?, options?) => (async function poll(page, url, query: Record<string, string> = {}, { conditionCallback = defaultConditionCallback, initialValue = [], ...options}) {
		if (typeof url === "string") {
			url = new URL(url);
		}

		url.search = new URLSearchParams([
			...new URLSearchParams(url.search).entries(),
			...Object.entries(query)
		]).toString();

		let currentValue = initialValue;

		let request = new Request(url.toString(), {
			"method": options["method"] ?? "GET",
			"headers": options["headers"],
			"body": options["body"]
		});

		for (let callCount = 1; request instanceof Request; callCount++) {
			const response = await fido[request.method.toLowerCase()](page, request);

			request = await conditionCallback(currentValue, { request, response }, callCount);
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
