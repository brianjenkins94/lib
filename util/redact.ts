import objectScan from "object-scan";

export function createRedactor(patterns: string[], censor: unknown | ((value: unknown, key: (string | number)[]) => unknown) = "<redacted>") {
	const redact = objectScan(patterns, {
		"breakFn": function({ isCircular }) {
			return isCircular;
		},
		"filterFn": function({ parent, property, value, key }) {
			parent[property] = typeof censor === "function" ? censor(value, key) : censor;
		}
	});

	return function(object) {
		if (object === null || typeof object !== "object") {
			return object;
		}

		const clone = structuredClone(object);

		redact(clone);

		return clone;
	};
}
