import { chromium } from "playwright-chromium";
import type { Browser, BrowserContext, Page } from "playwright-chromium";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { build } from "esbuild";

import { __root, isWindows } from "../env";
import { sleep } from "../sleep";
import { series } from "../array";

export async function attach() {
	try {
		await fetch("http://localhost:9222");
	} catch (error) {
		const shell = spawn(isWindows ? "taskkill" : "killall", isWindows ? ["/F", "/IM", "chrome.exe", "/T"] : ["-INT", "\"Google Chrome\""], {
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
			spawn(isWindows ? path.join(process.env["ProgramW6432"], "Google", "Chrome", "Application", "chrome.exe") : path.join("/", "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"), [
				// https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md#Windows
				//"--enable-logging=stderr --v=1",
				"--remote-debugging-port=9222",
				"--restore-last-session"
				//"--user-data-dir=" + (isWindows ? path.join(process.env["LOCALAPPDATA"], "Google", "Chrome", "User Data") : path.join(process.env["HOME"], "Library", "Application Support", "Google", "Chrome"))
			], {
				"detached": true
			});

			await sleep(1000);
		} else {
			console.warn("Command exited with non-zero exit-code: " + code);
		}
	}

	const browser = await chromium.connectOverCDP("http://localhost:9222");

	return {
		"browser": browser,
		"contexts": browser.contexts()
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
		return series([
			originalClose(options),
			context.close(),
			browser.close()
		]);
	};

	return page;
}

const contents = async function({ method, url, query, options }) {
	if (!globalThis.fetch.toString().includes("[native code]")) {
		console.warn("`fetch` appears to have been overwritten.");

		const iframe = document.createElement("iframe");

		document.body.append(iframe);

		globalThis.fetch = iframe.contentWindow.fetch;
	}

	// @ts-expect-error
	const response = await fido[method](url, query, options);
}.toString();

let bundle;

async function fetchFactory(method, baseUrl?, defaultOptions = {}) {
	bundle ??= (await build({
		"bundle": true,
		"format": "esm",
		"stdin": {
			"resolveDir": __root,
			"sourcefile": "fetch.ts",
			"contents": [
				"import * as fido from \"./util/fido\";",
				contents.substring(contents.indexOf("{", contents.indexOf(")") + 1) + 1, contents.lastIndexOf("}"))
			].join("\n")
		},
		"write": false,
		"define": {
			"process": "{}",
			"process.env": "{}",
			"process.env.NODE_ENV": "\"production\""
		}
	})).outputFiles[0].text;

	const args = contents.substring(contents.indexOf("(") + 1, contents.indexOf(")"));
	const functionBody = bundle + `
		// Must be [serializable](https://playwright.dev/docs/evaluating#evaluation-argument).
		return Array.from(new Uint8Array(await response.arrayBuffer()));
	`;

	const AsyncFunction = async function() { }.constructor;

	return async function(page, url, query?, options?) {
		// @ts-expect-error
		const body = await page.evaluate(new AsyncFunction(args, functionBody), {
			"method": method,
			"url": url,
			"query": query,
			"options": options
		});

		const response = new Response(new Uint8Array(body));

		return response;
	};
}

export const fido = {
	"get": await fetchFactory("get"),
	"post": await fetchFactory("post"),
	"put": await fetchFactory("put"),
	"del": await fetchFactory("delete")
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
