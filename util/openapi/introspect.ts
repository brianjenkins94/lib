/**
 * Read-only accessors over a JSON Schema / OpenAPI schema: the type(s) it allows, whether it's nullable,
 * its properties / required / items (allOf-aware), and a short human description. Pure — no I/O. Split out
 * from the drift classifier ([[./diff]]) so that reads as judgment rather than schema-walking plumbing.
 * (The complement to [[../schema]], which INFERS a schema from a value; this INTERROGATES one.)
 */

/** The operation verbs an OpenAPI path item can carry (lowercase, as the spec keys them) — for walking `paths`. */
export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** The set of JSON-Schema types a schema allows, resolving anyOf/oneOf/allOf and `nullable`. */
function collectTypes(schema: any): Set<string> {
	if (!schema) {
		return new Set();
	}

	if (schema.type === "null") {
		return new Set(["null"]);
	}

	if (typeof schema.type === "string") {
		const types = new Set([schema.type as string]);

		if (schema.nullable) {
			types.add("null");
		}

		return types;
	}

	if (Array.isArray(schema.type)) {
		return new Set(schema.type as string[]);
	}

	if (schema.anyOf || schema.oneOf) {
		const variants = (schema.anyOf ?? schema.oneOf) as any[];
		const types = new Set<string>();
		const seen = new Set<string>();

		for (const variant of variants) {
			const key = JSON.stringify(variant);

			if (!seen.has(key)) {
				seen.add(key);
				collectTypes(variant).forEach((type) => types.add(type));
			}
		}

		if (schema.nullable) {
			types.add("null");
		}

		return types;
	}

	if (schema.allOf || schema.properties || schema.additionalProperties !== undefined) {
		const types = new Set(["object"]);

		if (schema.nullable) {
			types.add("null");
		}

		return types;
	}

	if (schema.items !== undefined) {
		const types = new Set(["array"]);

		if (schema.nullable) {
			types.add("null");
		}

		return types;
	}

	return new Set();
}

/** The primary (non-null) type of a schema, or "unknown". */
export function primaryType(schema: any): string {
	const types = collectTypes(schema);

	types.delete("null");

	return [...types][0] ?? "unknown";
}

/** Whether the schema permits `null`. */
export function isNullable(schema: any): boolean {
	return schema ? collectTypes(schema).has("null") : false;
}

/** A schema's properties, merging allOf branches and reaching through a nullable anyOf/oneOf. */
export function getProperties(schema: any): Record<string, any> {
	if (!schema) {
		return {};
	}

	if (schema.properties) {
		return schema.properties;
	}

	if (schema.allOf) {
		const merged: Record<string, any> = {};

		for (const branch of schema.allOf as any[]) {
			Object.assign(merged, getProperties(branch));
		}

		return merged;
	}

	for (const variant of (schema.anyOf ?? schema.oneOf ?? []) as any[]) {
		if (variant.type !== "null" && variant.properties) {
			return variant.properties;
		}
	}

	return {};
}

/** A schema's required property names, unioned across allOf branches and reaching through a nullable anyOf/oneOf. */
export function getRequired(schema: any): Set<string> {
	if (!schema) {
		return new Set();
	}

	if (Array.isArray(schema.required)) {
		return new Set(schema.required as string[]);
	}

	if (schema.allOf) {
		const merged = new Set<string>();

		for (const branch of schema.allOf as any[]) {
			getRequired(branch).forEach((name) => merged.add(name));
		}

		return merged;
	}

	// Reach into the same non-null variant getProperties picks, so `required` and `properties` agree.
	for (const variant of (schema.anyOf ?? schema.oneOf ?? []) as any[]) {
		if (variant.type !== "null" && variant.properties) {
			return getRequired(variant);
		}
	}

	return new Set();
}

/** An array schema's items schema (allOf-aware, reaching through a nullable anyOf/oneOf), or null. */
export function getItems(schema: any): any {
	if (!schema) {
		return null;
	}

	if (schema.items !== undefined) {
		return schema.items;
	}

	if (schema.allOf) {
		for (const branch of schema.allOf as any[]) {
			if (branch.items !== undefined) {
				return branch.items;
			}
		}
	}

	for (const variant of (schema.anyOf ?? schema.oneOf ?? []) as any[]) {
		if (variant.type !== "null" && variant.items !== undefined) {
			return variant.items;
		}
	}

	return null;
}

/** True when a schema constrains nothing (an empty/`{}` schema — accepts anything). */
export function isOpenSchema(schema: any): boolean {
	if (!schema) {
		return false;
	}

	return Object.keys(schema).filter((key) => !["description", "example", "examples", "nullable"].includes(key)).length === 0;
}

/** A short, human-readable one-line description of a schema's shape. */
export function describeSchema(schema: any): string {
	if (!schema) {
		return "absent";
	}

	const type = primaryType(schema);
	const nullable = isNullable(schema) ? " | null" : "";

	if (type === "object") {
		const properties = Object.keys(getProperties(schema));

		return properties.length > 0 ? `object{${properties.join(", ")}}${nullable}` : `object${nullable}`;
	}

	if (type === "array") {
		const items = getItems(schema);

		return `array<${items ? describeSchema(items) : "any"}>${nullable}`;
	}

	if (type !== "unknown") {
		return type + nullable;
	}

	if (schema.anyOf || schema.oneOf) {
		const seen = new Set<string>();
		const parts: string[] = [];

		for (const variant of (schema.anyOf ?? schema.oneOf) as any[]) {
			const described = describeSchema(variant);

			if (!seen.has(described)) {
				seen.add(described);
				parts.push(described);
			}
		}

		return parts.join(" | ");
	}

	return JSON.stringify(schema).slice(0, 60);
}

/** Pull the request-body JSON Schema for an operation out of an OpenAPI `paths` object (null if absent). */
export function specRequestSchema(paths: any, path: string, method: string): any {
	return paths?.[path]?.[method]?.requestBody?.content?.["application/json"]?.schema ?? null;
}

/** Pull a response JSON Schema (by status code) out of an OpenAPI `paths` object (null if absent). */
export function specResponseSchema(paths: any, path: string, method: string, code: string): any {
	return paths?.[path]?.[method]?.responses?.[code]?.content?.["application/json"]?.schema ?? null;
}
