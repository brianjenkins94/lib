/**
 * A small, spec-faithful applier for the OpenAPI Overlay Specification (1.x) — the standard way to express
 * CORRECTIONS to an OpenAPI document as a separate, portable artifact (so mechanically-derived spec + human
 * fixes stay decoupled, and the fixes re-apply over each fresh derivation).
 *
 * Node TARGETING is delegated to jsonpath-plus (the RFC-9535-style JSONPath the spec requires); this module
 * only owns the Overlay action semantics — `update` (deep-merge) and `remove` (delete). Pure — mutates the
 * document in place and returns it. Overlay spec: https://spec.openapis.org/overlay/latest.html
 */
import { JSONPath } from "jsonpath-plus";

type Json = Record<string, any>;

export interface OverlayAction {
	"target": string;
	"description"?: string;
	"update"?: unknown;
	"remove"?: boolean;
}

export interface Overlay {
	"overlay"?: string;
	"info"?: Json;
	"actions"?: OverlayAction[];
}

interface JsonPathMatch {
	"value": any;
	"parent": any;
	"parentProperty": string;
}

function isPlainObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(target: Json, source: Json): void {
	for (const [key, value] of Object.entries(source)) {
		if (isPlainObject(value) && isPlainObject(target[key])) {
			deepMerge(target[key], value);
		} else {
			target[key] = structuredClone(value);
		}
	}
}

function find(document: Json, target: string): JsonPathMatch[] {
	return JSONPath({ "path": target, "json": document, "resultType": "all" }) as JsonPathMatch[];
}

function applyUpdate(document: Json, action: OverlayAction): void {
	const update = action.update;

	// The root selector has no parent to reassign, so it is always a merge.
	if (action.target === "$") {
		if (isPlainObject(update)) {
			deepMerge(document, update);
		}

		return;
	}

	for (const { value, parent, parentProperty } of find(document, action.target)) {
		if (isPlainObject(value) && isPlainObject(update)) {
			deepMerge(value, update);
		} else if (parent !== null && parent !== undefined) {
			parent[parentProperty] = structuredClone(update);
		}
	}
}

function applyRemove(document: Json, action: OverlayAction): void {
	// Re-query after each deletion so array indices can never go stale when a target matches multiple
	// siblings. Bounded to fail loudly on a pathological overlay rather than spin forever.
	for (let guard = 0; guard < 100_000; guard += 1) {
		const matches = find(document, action.target);

		if (matches.length === 0) {
			return;
		}

		const { parent, parentProperty } = matches[0];

		if (parent === null || parent === undefined) {
			return;
		}

		if (Array.isArray(parent)) {
			parent.splice(Number(parentProperty), 1);
		} else {
			delete parent[parentProperty];
		}
	}

	throw new Error(`Overlay remove for "${action.target}" did not converge`);
}

/** Apply an overlay to an OpenAPI document IN PLACE, returning the same object. */
export function applyOverlay(document: Json, overlay: Overlay): Json {
	for (const action of overlay.actions ?? []) {
		if (action.remove) {
			applyRemove(document, action);
		} else if (action.update !== undefined) {
			applyUpdate(document, action);
		} else {
			throw new Error(`Overlay action for "${action.target}" declares neither "update" nor "remove"`);
		}
	}

	return document;
}
