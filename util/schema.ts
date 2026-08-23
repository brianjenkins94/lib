/**
 * Schema inference + merging: a runtime value → a Zod schema, merged across many samples, ready to
 * emit as JSON Schema. The shared engine behind "observe live API traffic → typed schema" — used by
 * the admin MCP discovery loop and (eventually) partner-api-docs's OpenAPI generation.
 *
 * Core logic adapted from autodisco (MIT, https://github.com/freb97/autodisco) by freb97, for Zod v4
 * and cross-run accumulation. Promoted from partner-api-docs/util/schema-utils.js so both consumers
 * share one engine (see the API-pipeline design).
 *
 * zod is a PEER dependency: the merge relies on `instanceof z.ZodObject`, so every schema handled here
 * must come from the SAME zod instance as the consumer's — a bundled second copy would break instanceof.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

/** True if the value looks like a volatile opaque id (UUID / hex hash) that varies between calls. */
function looksLikeId(value: unknown): boolean {
	if (typeof value !== "string") {
		return false;
	}

	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
		return true;
	}

	return /^[0-9a-f]{32,64}$/iu.test(value);
}

/** Stable hash of a schema's internal definition — used to dedupe equivalent schemas inside a merge. */
function getSchemaHash(schema: any): string {
	try {
		return createHash("sha256").update(JSON.stringify(schema.def)).digest("hex");
	} catch {
		// def too large to stringify (a deeply nested inferred response) — treat as unique so it still
		// participates in merging rather than being silently dropped.
		return Math.random().toString(36);
	}
}

/** Recursively infer a Zod schema from a runtime value. */
export function inferFromValue(value: unknown): z.ZodType {
	if (value === null) {
		return z.null();
	}

	if (Array.isArray(value)) {
		return inferArray(value);
	}

	if (typeof value === "object") {
		return inferObject(value as Record<string, unknown>);
	}

	if (typeof value === "string") {
		return z.string();
	}

	if (typeof value === "number") {
		return z.number();
	}

	if (typeof value === "boolean") {
		return z.boolean();
	}

	return z.unknown();
}

function inferObject(value: Record<string, unknown>): z.ZodType {
	const shape: Record<string, z.ZodType> = {};

	for (const [key, val] of Object.entries(value)) {
		shape[key] = inferFromValue(val);
	}

	return z.object(shape);
}

function inferUniqueArray(values: any[], discriminatorKey?: string): Map<string, z.ZodType> {
	const uniqueSchemas = new Map<string, z.ZodType>();

	for (const item of values) {
		const schema = inferFromValue(item);
		const hash = getSchemaHash(schema);

		if (discriminatorKey !== undefined && schema instanceof z.ZodObject) {
			// Narrow the discriminator property to a literal so discriminatedUnion works.
			(schema.shape as any)[discriminatorKey] = z.literal(item[discriminatorKey]);
		}

		if (!uniqueSchemas.has(hash)) {
			uniqueSchemas.set(hash, schema);
		}
	}

	return uniqueSchemas;
}

function inferArray(value: any[]): z.ZodType {
	if (value.length === 0) {
		return z.array(z.any());
	}

	if (value.length === 1) {
		return z.array(inferFromValue(value[0]));
	}

	const uniqueSchemas = inferUniqueArray(value);

	if (uniqueSchemas.size === 1) {
		return z.array(uniqueSchemas.values().next().value as z.ZodType);
	}

	// Try to find a discriminator key shared (and stable) across every item.
	const first = value[0];
	const discriminatorCandidates = new Set<string>();

	for (const key of Object.keys(first)) {
		if (value.every((item) => item && typeof item === "object" && key in item && typeof item[key] !== "object" && item[key] !== "" && !looksLikeId(item[key]))) {
			discriminatorCandidates.add(key);
		}
	}

	if (discriminatorCandidates.size === 0) {
		return z.array(mergeSchemas([...uniqueSchemas.values()]));
	}

	for (const discriminator of discriminatorCandidates) {
		const grouped = value.reduce<Record<string, any[]>>((acc, item) => {
			const k = String(item[discriminator]);

			(acc[k] ??= []).push(item);

			return acc;
		}, {});

		if (Object.keys(grouped).length === uniqueSchemas.size) {
			const discriminatedSchemas = [...inferUniqueArray(value, discriminator).values()].filter((s) => s instanceof z.ZodObject);

			if (discriminatedSchemas.length > 1) {
				return z.array(z.discriminatedUnion(discriminator, discriminatedSchemas as any));
			}
		}
	}

	return z.array(mergeSchemas([...uniqueSchemas.values()]));
}

/**
 * Merge an array of Zod schemas into one:
 * - object schemas merge property-by-property — present in ALL → required, in SOME → `.optional()`,
 *   nested objects merge recursively, type conflicts become `z.union([...])`;
 * - non-object schemas fall back to the first (or `z.unknown()` when empty).
 */
export function mergeSchemas(schemas: z.ZodType[]): z.ZodType {
	const objectSchemas = schemas.filter((s) => s instanceof z.ZodObject);

	if (objectSchemas.length === 0) {
		return schemas[0] ?? z.unknown();
	}

	if (objectSchemas.length === 1) {
		return objectSchemas[0];
	}

	const allProperties = new Map<string, { "schemas": z.ZodType[]; "count": number }>();

	for (const schema of objectSchemas) {
		for (const [key, value] of Object.entries((schema as any).shape as Record<string, z.ZodType>)) {
			const prop = allProperties.get(key);

			if (prop === undefined) {
				allProperties.set(key, { "schemas": [value], "count": 1 });
			} else {
				prop.schemas.push(value);
				prop.count += 1;
			}
		}
	}

	const mergedShape: Record<string, z.ZodType> = {};

	for (const [key, { "schemas": propSchemas, count }] of allProperties) {
		let mergedProp: z.ZodType;
		const areAllObjects = propSchemas.every((s) => s instanceof z.ZodObject);

		if (areAllObjects && propSchemas.length > 1) {
			mergedProp = mergeSchemas(propSchemas);
		} else if (propSchemas.length === 1) {
			mergedProp = propSchemas[0]!;
		} else if (new Set(propSchemas.map(getSchemaHash)).size === 1) {
			mergedProp = propSchemas[0]!;
		} else if (areAllObjects) {
			mergedProp = mergeSchemas(propSchemas);
		} else if (propSchemas.every((s) => s instanceof z.ZodArray)) {
			mergedProp = z.array(mergeSchemas(propSchemas.map((s) => (s as any).element)));
		} else {
			mergedProp = z.union(propSchemas as any);
		}

		// Present in every sample → required; otherwise optional.
		mergedShape[key] = count === objectSchemas.length ? mergedProp : mergedProp.optional();
	}

	return z.object(mergedShape);
}

/** Convert an inferred/merged schema to a JSON Schema — the persisted, interchange form. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema);
}
