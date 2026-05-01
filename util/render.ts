import * as ejs from "ejs";
import * as fs from "./fs";
import { mapEntries } from "./array";
import * as path from "path";

let vite;

export async function render(template, data = {}, { useVite = false, __dirname = undefined, ...options } = {}) {
	// Convert the object values to strings
	data = mapEntries(data, function([key, value]) {
		if (typeof value !== "function" && typeof value === "object") {
			value = JSON.stringify(value);
		}

		return [key, value];
	});

	// Convert the function values to strings
	data = mapEntries(data, function([key, value]) {
		if (typeof value === "function") {
			value = ejs.render(value.toString().substring(value.toString().indexOf("{") + 1, value.toString().lastIndexOf("}")), data, { "openDelimiter": "\"<", "closeDelimiter": ">\"" }).trim();
		}

		return [key, value];
	});

	template = await fs.readFile(template, { "encoding": "utf8" });

	while (true) {
		try {
			let html = ejs.render(template, data, options);

			if (useVite) {
				vite ??= await import(import.meta.resolve("vite"));

				const result = await vite.build({
					"mode": "development",
					"root": __dirname,
					"plugins": [
						{
							"name": "vfs",
							"enforce": "pre",
							"resolveId": function(id) {
								if (id === "/index.html") {
									return path.join(__dirname, id);
								}
							},
							"load": function(id) {
								if (id === path.join(__dirname, "index.html")) {
									return html;
								}
							}
						}
					],
					"build": {
						"outDir": "../dist",
						"emptyOutDir": false,
						"rollupOptions": { "input": "/index.html" },
						"minify": false,
						"modulePreload": { "polyfill": false }
					}
				});

				html = result.output.find(({ fileName }) => fileName === "index.html").source;
			}

			return html;
		} catch (error) {
			const message = error.toString().split("\n").pop();

			console.error(message);

			const match = (/(.+) is not defined/ui.exec(message) || []).pop();

			if (match !== undefined) {
				data[match] = "";

				continue;
			}

			throw error;
		}
	}
}
