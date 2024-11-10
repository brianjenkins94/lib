import * as ejs from "ejs";
import * as fs from "./fs";

export async function render(template, data = {}, options = {}) {
	// Convert the object values to strings
	data = Object.fromEntries(Object.entries(data).map(function([key, value]) {
		if (typeof value !== "function" && typeof value === "object") {
			value = JSON.stringify(value);
		}

		return [key, value];
	}));

	// Convert the function values to strings
	data = Object.fromEntries(Object.entries(data).map(function([key, value]) {
		if (typeof value === "function") {
			value = ejs.render(value.toString().substring(value.toString().indexOf("{") + 1, value.toString().lastIndexOf("}")), data, { "openDelimiter": "\"<", "closeDelimiter": ">\"" }).trim();
		}

		return [key, value];
	}));

	template = await fs.readFile(template, { "encoding": "utf8" });

	while (true) {
		try {
			return ejs.render(template, data, options);
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
