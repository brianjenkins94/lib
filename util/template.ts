// A tiny EJS-subset template renderer, enough to replace the `ejs` dependency.
// Tags: <% %> execute, <%= %> HTML-escaped, <%- %> raw, <%# %> comment. A template
// compiles to a function body run with `with (data)`, and `data` is a proxy that
// claims every name and yields undefined for ones that weren't passed — so a missing
// local renders as "" instead of throwing, with no retry/back-fill loop.

function parse(template) {
	const buffer = [];

	const openTagRegex = /(.*?)<%\s*(=|-|#)?\s*/gsu;
	const closeTagRegex = /'|"|`|\/\*|(\s*%>)/gu;

	let index = 0;
	let match;

	while (match = openTagRegex.exec(template)) {
		index = match[0].length + match.index;
		const prefix = match[2] ?? "";

		buffer.push(match[1]);

		closeTagRegex.lastIndex = index;

		let closeTag;

		while (closeTag = closeTagRegex.exec(template)) {
			if (closeTag[1] !== undefined) {
				const value = template.substring(index, closeTag.index);

				index = closeTagRegex.lastIndex;
				openTagRegex.lastIndex = index;

				buffer.push({
					"type": {
						"": "execute",
						"-": "raw",
						"=": "interpolate",
						"#": "comment"
					}[prefix],
					"value": value
				});

				break;
			}
		}
	}

	if (index < template.length) {
		buffer.push(template.substring(index));
	}

	return buffer;
}

function compile(nodes) {
	const buffer = [
		"const buffer = [];",
		"const escape = (value) => value == null ? \"\" : String(value).replace(/[&<>\"']/gu, (character) => ({ \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" }[character]));",
		"with (data) {"
	];

	for (const node of nodes) {
		if (typeof node === "string") {
			// Escape only the literal text — for safe embedding in a `backtick` literal.
			buffer.push("buffer.push(`" + node.replace(/\\/gu, "\\\\").replace(/`/gu, "\\`").replace(/\$\{/gu, "\\${") + "`);");
		} else {
			const { type, value } = node;

			switch (type) {
				case "interpolate":
					buffer.push("buffer.push(escape(" + value + "));");
					break;
				case "raw":
					buffer.push("buffer.push(" + value + ");");
					break;
				case "execute":
					buffer.push(value);
					break;
				default:
			}
		}
	}

	buffer.push("}");
	buffer.push("return buffer.join(\"\");");

	return buffer.join("\n");
}

export function render(template, data = {}) {
	// `with (data)` resolves bare names in the template; the proxy makes every name
	// present (undefined for absent ones) so missing locals render "" and don't throw.
	// It reports `buffer`/`escape` as absent so `with` can't shadow those internals.
	const scope = new Proxy(data, {
		"has": (target, key) => key !== "buffer" && key !== "escape",
		"get": (target, key) => (key in target ? target[key] : undefined)
	});

	// eslint-disable-next-line no-new-func, ts/no-implied-eval
	return new Function("data", compile(parse(template)))(scope);
}
