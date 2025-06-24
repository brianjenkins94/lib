import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { spawn } from "child_process";
import * as path from "path";
import stdLibBrowser from "node-stdlib-browser";
import * as fs from "../fs"

import { __root, isWindows } from "../env";
import { sleep } from "../sleep";
import { series } from "../array";

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

	const response = await fido[method](url, query, options);
}.toString();

let esbuild;

try {
	esbuild = await import("esbuild");
} catch (error) {}

let bundle;

async function fetchFactory(baseUrl?, defaultOptions = {}) {
	bundle ??= (await esbuild.build({
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
		//"inject": [url.fileURLToPath(import.meta.resolve("node-stdlib-browser/helpers/esbuild/shim", import.meta.url))],
		"define": {
			"import.meta.url": "location.pathname",
			"process": "{ \"env\": {} }"
		},
		"plugins": [
			{
				"name": "node-stdlib-browser-alias",
				"setup": function(build) {
					const builtinsMap = Object.fromEntries(Object.keys(stdLibBrowser).map(function(libName) {
						return [libName, stdLibBrowser[libName]];
					}))

					const filter = new RegExp(`^(${["fs", "path", "url"].join("|")})(/.*)?$`)

					build.onResolve({ "filter": filter }, function(args) {
						if (Object.keys(builtinsMap).some((builtin) => args.path.startsWith(builtin))) {
							return {
								"path": args.path,
								"namespace": "external-global",
								"pluginData": args
							};
						}
					});

					build.onLoad({ "filter": /.*/, "namespace": "external-global" }, async function({ "pluginData": { importer }, ...args }) {
						//const [match] = new RegExp(`(?<=^import ).+?(?= from (?:"|')${args["path"]}(?:"|');?$)`, "mu").exec(await fs.readFile(importer)) || [];

						const matches = Object.entries(await import(args["path"])).map(function([key, value]) {
							return `export ${key === "default" ? "default" : `const ${key} =`} ${(typeof value === "function" ? "() => {}" : undefined)};`;
						}).join("\n");

						return {
							"contents": matches,
							"loader": "js"
						};
					});
				}
			}
		]
	})).outputFiles[0].text;

	const args = contents.substring(contents.indexOf("(") + 1, contents.indexOf(")"));
	const functionBody = bundle + `
		// Must be [serializable](https://playwright.dev/docs/evaluating#evaluation-argument).
		return Array.from(new Uint8Array(await response.arrayBuffer()));
	`;

	const AsyncFunction = (async function() { }).constructor;

	return async function(page, method, url, query?, options?) {
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
	"get": async function(page, url, query?, options?) {
		this["_fido"] ??= await fetchFactory();

		return this["_fido"](page, "get", url, query, options);
	},
	"post": async function(page, url, query?, options?) {
		this["_fido"] ??= await fetchFactory();

		return this["_fido"](page, "post", url, query, options);
	},
	"put": async function(page, url, query?, options?) {
		this["_fido"] ??= await fetchFactory();

		return this["_fido"](page, "put", url, query, options);
	},
	"del": async function(page, url, query?, options?) {
		this["_fido"] ??= await fetchFactory();

		return this["_fido"](page, "del", url, query, options);
	}
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
