export function camelCaseToTitleCase(string) {
	return string.replace(/(^[a-z])|([A-Z])/gu, function(match) {
		return /[a-z]/u.test(match) ? match.toUpperCase() : " " + match;
	});
}

export function kebabCaseToPascalCase(string) {
	return string.replace(/(^\w|-\w)/gu, function(match) {
		return match.replace(/-/u, "").toUpperCase();
	});
}

export function pascalCaseToKebabCase(string) {
	return string.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
}

export function titleCaseToKebabCase(string) {
	return string.replace(/([a-z0-9])\s+([a-z])/gui, "$1-$2").toLowerCase();
}

export function equalsIgnoreCase(a, b) {
	return a.localeCompare(b, undefined, { "sensitivity": "base" }) === 0;
}

export function toTitleCase(string) {
	return string.replace(/(^|\s)\S/gu, function(match) {
		return match.toUpperCase();
	});
}

export function dedent(input) {
	input = input
		.replace(/^\t+/gmu, function(match) {
			return " ".repeat(match.length * 4);
		});

	const indentationWidth = (/^ {2,}/mu.exec(input) ?? [""])[0].length;

	return input
		.replace(/^\s*\n(?=\s*\S)/mu, "")
		.replace(new RegExp("^( {" + indentationWidth + "})", "gmu"), "")
		.replace(/(?<=^)\n|(?<=\n+) +(?=$)/gu, "");
		//.replace(/^ +/gmu, function(match) {
		//	return "\t".repeat(match.length / 4);
		//});
}

export function indent(input) {
    input = input
        .replace(/^\t+/gmu, function(match) {
            return " ".repeat(match.length * 4);
        });

    const indentationWidth = (/^ {2,}/mu.exec(input) ?? [""])[0].length;

    return input.trim().split("\n").map((line, index) => " ".repeat(index && indentationWidth - 4) + line).join("\n");
}

export async function replaceAsync(regex, input, callback = async (execResults: RegExpExecArray) => Promise.resolve(execResults[1])) {
    regex = new RegExp(regex.source, [...new Set([...regex.flags, "d"])].join(""));

    const output = [];

    let index = input.length;
    let result;

    for (let origin = 0; result = regex.exec(input); origin = index) {
        index = result.indices[1][1] + 1;

        output.push(input.substring(origin, result.indices[1][0] - 1), await callback(result));
    }

    output.push(input.substring(index));

    return output.join("");
}

export function longestCommonPrefix([first, ...strings]) {
	const result = [];

	for (let x = 0; x < first.length; x++) {
		const char = first[x];

		if (!strings.every((string) => string[x] === char)) {
			break;
		}

		result.push(char);
	}

	return result.join("");
}
