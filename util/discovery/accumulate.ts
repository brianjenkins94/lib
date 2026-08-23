/**
 * Accumulate observed API traffic into per-endpoint typed schemas — stage 2 of the API pipeline.
 * Source-agnostic: feed it Observations from any adapter (CDP capture, OpenSearch replay, httpyac,
 * Postman) and it groups by endpoint and merges request + per-status response bodies into JSON Schemas
 * via the shared schema engine ([[../schema]]).
 */
import { inferFromValue, mergeSchemas, toJsonSchema } from "@brianjenkins94/util/schema";

/** One observed request/response pair, normalized across sources. */
export interface Observation {
	"method": string;
	/** The concrete path or URL actually hit — kept as a sample. */
	"path": string;
	/** Normalized path with volatile ids collapsed — the dedupe key together with `method`. */
	"pathPattern": string;
	"status": number;
	/** Observed query params (name → value), if any. */
	"query"?: Record<string, string>;
	/** The `Link` response header, if any — a pagination signal. */
	"link"?: string;
	"requestBody"?: unknown;
	"responseBody": unknown;
	"meta"?: Record<string, unknown>;
}

/** Per-endpoint accumulation: a merged request schema + one merged response schema per status code. */
export interface AccumulatedEndpoint {
	"method": string;
	"pathPattern": string;
	"samples": number;
	"sampleUrl": string;
	"requestSchema"?: Record<string, unknown>;
	"requestExample"?: unknown;
	"responses": Record<string, Record<string, unknown>>;
	/** Observed query params (name → required + example values); pagination params are excluded. */
	"queryParams"?: Record<string, { "required": boolean; "examples": string[] }>;
	/** True when the endpoint looks paginated (a next Link, or a { total, …: array } body). */
	"paginated"?: boolean;
}

/** Common pagination query params — hidden from modeled query inputs when an endpoint paginates. */
const PAGINATION_PARAMS = new Set(["page", "perpage", "per_page", "pagesize", "page_size", "offset", "limit", "cursor"]);

/** A response body shaped like a page: a numeric total/count field alongside an array field. */
function looksPaginatedBody(body: unknown): boolean {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return false;
	}

	const entries = Object.entries(body as Record<string, unknown>);
	const hasTotal = entries.some(([key, value]) => /^(?:total(?:count)?|count)$/iu.test(key) && typeof value === "number");

	return hasTotal && entries.some(([, value]) => Array.isArray(value));
}

/** True if a Link header advertises a next page. */
function hasNextLink(link: string | undefined): boolean {
	return link !== undefined && /rel="?next"?/iu.test(link);
}

/** Stable key for an endpoint — method + normalized path. */
export function endpointKey(method: string, pathPattern: string): string {
	return `${method.toUpperCase()} ${pathPattern}`;
}

/** Infer + merge a set of bodies into one JSON Schema (undefined when there are none). */
function mergedJsonSchema(bodies: unknown[]): Record<string, unknown> | undefined {
	return bodies.length === 0 ? undefined : toJsonSchema(mergeSchemas(bodies.map(inferFromValue)));
}

/** Group observations by endpoint and merge their bodies into typed JSON Schemas. */
export function accumulate(observations: Observation[]): AccumulatedEndpoint[] {
	const groups = new Map<string, Observation[]>();

	for (const observation of observations) {
		const key = endpointKey(observation.method, observation.pathPattern);
		let group = groups.get(key);

		if (group === undefined) {
			group = [];
			groups.set(key, group);
		}

		group.push(observation);
	}

	const result: AccumulatedEndpoint[] = [];

	for (const group of groups.values()) {
		const first = group[0];

		// Response schemas are grouped by status (200 and 404 have different shapes — OpenAPI models
		// them separately); the request schema merges every observed payload regardless of status.
		const byStatus = new Map<number, unknown[]>();

		for (const observation of group) {
			let bodies = byStatus.get(observation.status);

			if (bodies === undefined) {
				bodies = [];
				byStatus.set(observation.status, bodies);
			}

			bodies.push(observation.responseBody);
		}

		const responses: Record<string, Record<string, unknown>> = {};

		for (const [status, bodies] of byStatus) {
			const schema = mergedJsonSchema(bodies);

			if (schema !== undefined) {
				responses[String(status)] = schema;
			}
		}

		const requestBodies = group.map((observation) => observation.requestBody).filter((body) => body !== undefined);

		const paginated = group.some((observation) => hasNextLink(observation.link) || looksPaginatedBody(observation.responseBody));

		const queryParams: Record<string, { "required": boolean; "examples": string[] }> = {};

		for (const name of new Set(group.flatMap((observation) => Object.keys(observation.query ?? {})))) {
			if (paginated && PAGINATION_PARAMS.has(name.toLowerCase())) {
				continue; // the paginating tool manages page/limit itself
			}

			const present = group.filter((observation) => observation.query !== undefined && name in observation.query);

			queryParams[name] = {
				"required": present.length === group.length,
				"examples": [...new Set(present.map((observation) => observation.query[name]))].slice(0, 5)
			};
		}

		result.push({
			"method": first.method.toUpperCase(),
			"pathPattern": first.pathPattern,
			"samples": group.length,
			"sampleUrl": first.path,
			"requestSchema": mergedJsonSchema(requestBodies),
			"requestExample": requestBodies[0],
			"responses": responses,
			"queryParams": Object.keys(queryParams).length > 0 ? queryParams : undefined,
			"paginated": paginated || undefined
		});
	}

	return result;
}
