#!/usr/bin/env node

import * as fs from "./fs";
import { SpawnOptionsWithoutStdio, spawn } from "node:child_process";
import { unescape } from "node:querystring";
import * as path from "node:path";
import mime from "mime/lite";

import { createServer } from "./server";
import { __root } from "./env";

// SOURCE: https://github.com/sindresorhus/open/blob/main/index.js
export function open(target) {
	let command;
	const args = [];
	const options: SpawnOptionsWithoutStdio = {};

	if (process.platform === "darwin") {
		command = "open";

		args.push("-a", "google-chrome", target);
	} else if (process.platform === "win32") {
		command = `${process.env["SYSTEMROOT"] || process.env["windir"] || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell`;

		args.push(
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand"
		);

		options.windowsVerbatimArguments = true;

		const encodedArguments = ["Start"];

		// Double quote with double quotes to ensure the inner quotes are passed through.
		// Inner quotes are delimited for PowerShell interpretation with backticks.
		encodedArguments.push(`"\`"chrome\`""`, `"\`"${target}\`""`);

		// Using Base64-encoded command, accepted by PowerShell, to allow special characters.
		args.push(Buffer.from(encodedArguments.join(" "), "utf16le").toString("base64"));
	} else {
		command = "google-chrome";

		args.push(target);

		// `xdg-open` will block the process unless stdio is ignored
		// and it's detached from the parent even if it's unref'd.
		options.stdio = "ignore";
		options.detached = true;
	}

	const subprocess = spawn(command, args, options);

	subprocess.unref();

	return subprocess;
}

async function serve() {
	const BASE_URL = "http://localhost:3000";

	const server = createServer();

	let username = "";
	let repository = "";
	let description = "";

	const packageJsonFile = path.join(process.cwd(), "package.json");

	if (fs.existsSync(packageJsonFile)) {
		const parsedPackageJson = JSON.parse(await fs.readFile(packageJsonFile, { "encoding": "utf8" }));

		if (parsedPackageJson?.["repository"]?.["url"] !== undefined) {
			const matches = new URL(parsedPackageJson["repository"]["url"]).pathname.split("/");

			username = matches[1];
			repository = path.basename(matches[2], path.extname(matches[2]));
		}

		if (parsedPackageJson["description"] !== undefined) {
			description = parsedPackageJson["description"];
		}
	}

	const basePath = path.join(__root, "docs"); //process.cwd();

	server.get("/", function(request, response) {
		return response.render(path.join(basePath, "index.html"), {
			"title": repository || path.basename(basePath),
			"username": username,
			"repository": repository || path.basename(basePath),
			"description": description
		});
	});

	server.get("(.*)", async function serve(request, response) {
		const fullPath = path.join(basePath, unescape(request.url.replace("/~", "")));

		if (path.resolve(fullPath).startsWith(basePath)) {
			if (fs.existsSync(fullPath)) {
				if ((await fs.stat(fullPath)).isFile()) {
					return {
						"statusCode": 200,
						"headers": {
							"Content-Type": mime.getType(fullPath)
						},
						"body": await fs.readFile(fullPath)
					};
				}

				if (request.url.startsWith("/~/")) {
					const files = [];
					const folders = [];

					for (const file of await fs.readdir(fullPath)) {
						if ((await fs.stat(path.join(fullPath, file))).isFile()) {
							files.push(file);
						} else {
							folders.push(file);
						}
					}

					return response.json({
						"files": files,
						"folders": folders
					});
				}

				request.url = path.join(fullPath, "index.html");

				return serve(request, response);
			}
		}

		return {
			"statusCode": 404
		};
	});

	server.listen(parseInt(new URL(BASE_URL).port), function() {
		console.log("> Ready on " + BASE_URL);

		open(BASE_URL);
	});
}

/*
if (import.meta.url === url.pathToFileURL(process.argv[1]).toString()) {
	await serve();
}
*/
