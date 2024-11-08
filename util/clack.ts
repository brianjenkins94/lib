import * as clack from "@clack/prompts";

export * from "@clack/prompts";
export { default as color } from "picocolors";

export function cancel(message = "Operation cancelled.", code = 0) {
	clack.log.error(message);

	console.log();

	process.exit(code);
}

export async function confirm(options = {}) {
	let defaultValue = options["defaultValue"] === true ? "[Y/n]" : "[y/N]";

	if (options["defaultValue"] === true) {
		options["defaultValue"] = "y";
	} else if (options["defaultValue"] === false) {
		options["defaultValue"] = "n";
	} else if (options["defaultValue"] === undefined) {
		defaultValue = defaultValue.toLowerCase();
	}

	const result = await clack.text({
		"message": [options["message"], defaultValue].join(" ").trim(),
		"defaultValue": options["defaultValue"],
		"validate": function(value) {
			if (options["required"] && value.length === 0) {
				return "Response required.";
			}

			if (!/^(y(es)?|n(o)?)?$/ui.test(value)) {
				return "Value must be either [Y]es or [N]o.";
			}
		}
	});

	if (clack.isCancel(result)) {
		return result;
	}

	// @ts-expect-error
	return /^y/ui.test(result);
}

export async function group(prompts) {
	prompts = Object.entries(prompts);

	const results = [];

	for (let index = 0; index < prompts.length; index++) {
		const [name, prompt] = prompts[index];

		const result = await prompt(Object.fromEntries(results), function unshift(items) {
			prompts.splice(index + 1, 0, ...Object.entries(items));
		});

		if (clack.isCancel(result)) {
			results.push([name, "cancelled"]);

			cancel("Operation cancelled.");

			return;
		}

		results.push([name, result]);
	}

	return results;
}
