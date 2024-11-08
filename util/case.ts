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
