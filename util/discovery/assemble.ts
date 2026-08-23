/**
 * Assemble accumulated endpoints into an OpenAPI 3.1 document — stage 3 of the API pipeline. OpenAPI
 * 3.1's schema object IS JSON Schema, so the schemas from accumulate() drop straight in — no Zod
 * round-trip. Per-endpoint metadata (summary/description/tags/operationId) is optional, keyed by
 * endpointKey, so a source adapter (httpyac, hand-authored notes) can enrich the observed shapes.
 */
import type { AccumulatedEndpoint } from "./accumulate";
import pluralize from "pluralize";

const PLACEHOLDER_SEGMENT = /^(?:ID|UUID|CALL_ID|api|v\d+)$/iu;
// A path-parameter segment — either a named template (`{partner}`, from templatize) or a legacy token.
const NAMED_PARAM = /^\{.+\}$/u;
const LEGACY_PARAM = /^(?:ID|UUID|CALL_ID)$/u;

function upperFirst(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

const STATUS_TEXT: Record<string, string> = {
	"200": "OK",
	"201": "Created",
	"202": "Accepted",
	"204": "No Content",
	"400": "Bad Request",
	"401": "Unauthorized",
	"403": "Forbidden",
	"404": "Not Found",
	"409": "Conflict",
	"422": "Unprocessable Entity",
	"429": "Too Many Requests",
	"500": "Server Error"
};

export interface EndpointMeta {
	"summary"?: string;
	"description"?: string;
	"tags"?: string[];
	"operationId"?: string;
	/** Per-parameter descriptions, keyed by param name (path or query) — surfaced on OpenAPI parameters. */
	"paramDocs"?: Record<string, string>;
}

export interface AssembleOptions {
	"title": string;
	"version": string;
	"description"?: string;
	"servers"?: string[];
	/** Per-endpoint metadata keyed by `${METHOD} ${pathPattern}` (see accumulate's endpointKey). */
	"meta"?: Record<string, EndpointMeta>;
}

/**
 * Convert a pattern to an OpenAPI path + its ordered param names. Handles both a named template from
 * templatize (`…/{partner}/…` → kept, name collected) and a legacy token pattern (`…/ID/…` → `…/{id}/…`).
 */
export function patternToOpenApiPath(pattern: string): { "path": string; "params": string[] } {
	const params: string[] = [];
	const path = pattern.split("/").map((segment) => {
		const named = /^\{(\w+)\}$/u.exec(segment);

		if (named !== null) {
			params.push(named[1]);

			return segment;
		}

		if (LEGACY_PARAM.test(segment)) {
			const name = params.length === 0 ? "id" : `id${params.length + 1}`;

			params.push(name);

			return `{${name}}`;
		}

		return segment;
	}).join("/");

	return { "path": path, "params": params };
}

/**
 * Derive a camelCase operationId, e.g. GET /api/partner/partners/{partner}/details → getPartnerPartnerDetails.
 * A resource segment immediately followed by a parameter is SINGULARIZED, so a collection (`GET /partners` →
 * getPartners) and its item (`GET /partners/{partner}` → getPartner) don't collapse to the same name.
 */
export function operationId(method: string, pattern: string): string {
	const segments = (pattern.split("?")[0] ?? "").split("/").filter((segment) => segment !== "");
	const words: string[] = [];

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];

		// skip reserved prefixes (api, v1) and parameter segments; a resource before a param is singularized
		if (!PLACEHOLDER_SEGMENT.test(segment) && !NAMED_PARAM.test(segment)) {
			const next = segments[index + 1];
			const followedByParam = next !== undefined && (NAMED_PARAM.test(next) || LEGACY_PARAM.test(next));

			words.push(followedByParam ? pluralize.singular(segment) : segment);
		}
	}

	const camel = words.map((word, index) => (index === 0 ? word : upperFirst(word))).join("").replace(/[^a-zA-Z0-9]/gu, "");

	return method.toLowerCase() + (camel === "" ? "Root" : upperFirst(camel));
}

/** Build an OpenAPI 3.1 document from accumulated endpoints. */
export function assemble(endpoints: AccumulatedEndpoint[], options: AssembleOptions): Record<string, unknown> {
	const paths: Record<string, Record<string, unknown>> = {};

	for (const endpoint of endpoints) {
		const key = `${endpoint.method.toUpperCase()} ${endpoint.pathPattern}`;
		const meta = options.meta?.[key] ?? {};
		const { path, params } = patternToOpenApiPath(endpoint.pathPattern);
		const method = endpoint.method.toLowerCase();

		const operation: Record<string, unknown> = {
			"operationId": meta.operationId ?? operationId(endpoint.method, endpoint.pathPattern),
			"summary": meta.summary ?? `${endpoint.method.toUpperCase()} ${endpoint.pathPattern}`
		};

		if (meta.description !== undefined) {
			operation["description"] = meta.description;
		}

		if (meta.tags !== undefined) {
			operation["tags"] = meta.tags;
		}

		const paramDocs = meta.paramDocs ?? {};
		const parameters = [
			...params.map((name) => ({ "name": name, "in": "path", "required": true, ...(paramDocs[name] !== undefined ? { "description": paramDocs[name] } : {}), "schema": { "type": "string" } })),
			...Object.entries(endpoint.queryParams ?? {}).map(([name, info]) => ({
				"name": name,
				"in": "query",
				"required": info.required,
				...(paramDocs[name] !== undefined ? { "description": paramDocs[name] } : {}),
				"schema": info.examples.length > 0 ? { "type": "string", "examples": info.examples } : { "type": "string" }
			}))
		];

		if (parameters.length > 0) {
			operation["parameters"] = parameters;
		}

		if (endpoint.paginated === true) {
			operation["x-paginated"] = true; // consumers (toMcpTools) route these through a fetch-all executor
		}

		if (endpoint.requestSchema !== undefined) {
			const json: Record<string, unknown> = { "schema": endpoint.requestSchema };

			if (endpoint.requestExample !== undefined) {
				json["example"] = endpoint.requestExample;
			}

			operation["requestBody"] = { "required": true, "content": { "application/json": json } };
		}

		const responses: Record<string, unknown> = {};

		for (const [status, schema] of Object.entries(endpoint.responses)) {
			responses[status] = {
				"description": STATUS_TEXT[status] ?? "Response",
				"content": { "application/json": { "schema": schema } }
			};
		}

		if (Object.keys(responses).length === 0) {
			responses["default"] = { "description": "No response body observed." };
		}

		operation["responses"] = responses;

		(paths[path] ??= {})[method] = operation;
	}

	const document: Record<string, unknown> = {
		"openapi": "3.1.0",
		"info": { "title": options.title, "version": options.version },
		"paths": paths
	};

	if (options.description !== undefined) {
		(document["info"] as Record<string, unknown>)["description"] = options.description;
	}

	if (options.servers !== undefined) {
		document["servers"] = options.servers.map((url) => ({ "url": url }));
	}

	return document;
}
