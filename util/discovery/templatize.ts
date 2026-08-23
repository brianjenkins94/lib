/**
 * Multi-sample path templatization — infer which URL path segments are PARAMETERS (ids) rather than constant
 * resource names, by looking across ALL observed paths at once. Adapted from Optic's path-inference
 * (https://github.com/opticdev/optic). A per-URL regex can only catch intrinsically-variable ids (numeric,
 * UUID); looking across samples additionally catches opaque/slug ids (`/users/alice`, `/users/bob` →
 * `/users/{user}`) — which is why this belongs downstream of the persisted corpus, not at capture time.
 *
 * Source-agnostic: feed it the concrete paths (or full URLs) and it returns a `path → template` map, where
 * a template collapses id segments to `{singular(parent)}` (e.g. `/api/partner/partners/{partner}`).
 */
import pluralize from "pluralize";

const RESERVED = /^(?:api|v\d+)$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PARAM = /^\{.+\}$/u;

// Min distinct sibling values before variation (rather than an intrinsic look) can imply a parameter, and
// the stronger spread required when those values are terminal (no subtree to corroborate them as an id space).
const COLLAPSE_N = 2;
const TERMINAL_SPREAD = 4;

interface Path {
	"original": string;
	"segments": string[];
}

/** A segment that intrinsically looks like an opaque id value, regardless of its siblings. */
function looksLikeId(segment: string): boolean {
	if (RESERVED.test(segment)) {
		return false;
	}

	return /^\d+$/u.test(segment) // numeric
		|| UUID.test(segment) // uuid
		|| /^[0-9a-f]{16,}$/iu.test(segment) // long hex hash
		|| (/^[\w-]{20,}$/u.test(segment) && /\d/u.test(segment)); // long mixed token
}

/** Split a URL (or path) into decoded, non-empty path segments. */
function toSegments(url: string): string[] {
	let pathname: string;

	try {
		({ pathname } = new URL(url));
	} catch {
		pathname = url.replace(/^[a-z]+:\/\/[^/]+/iu, "").replace(/\?.*$/u, "");
	}

	return pathname.split("/").filter((segment) => segment !== "").map((segment) => {
		try {
			return decodeURIComponent(segment);
		} catch {
			return segment;
		}
	});
}

/**
 * Decide whether the segment at `depth` is a parameter, given the paths that reached this node grouped by
 * their value at `depth`. Distinct id VALUES share a structurally-consistent subtree (`…/2/subs`, `…/5/subs`)
 * or spread widely when terminal; distinct RESOURCES branch into different subtrees (`…/partner/partners`,
 * `…/system/state`) and stay few — so the shape of the children, not just the count, is the tell.
 */
function isParameter(groups: Map<string, Path[]>, depth: number): boolean {
	const values = [...groups.keys()];

	if (values.length === 1 || values.some((value) => RESERVED.test(value))) {
		return false;
	}

	if (values.every((value) => looksLikeId(value))) {
		return true;
	}

	if (values.length < COLLAPSE_N) {
		return false;
	}

	const childKeySets = values.map((value) => new Set(
		(groups.get(value) ?? [])
			.map((path) => path.segments[depth + 1])
			.filter((segment) => segment !== undefined)
	));

	const nonEmpty = childKeySets.filter((set) => set.size > 0);

	if (nonEmpty.length === 0) {
		return values.length >= TERMINAL_SPREAD; // all terminal → only a real spread of values looks like ids
	}

	// A parameter's children share a common next segment across every value; distinct resources do not.
	return [...nonEmpty[0]].some((key) => nonEmpty.every((set) => set.has(key)));
}

/** The nearest constant (non-param, non-reserved) ancestor's singular — the natural name for the parameter. */
function parameterName(prefix: string[]): string {
	for (let index = prefix.length - 1; index >= 0; index--) {
		const segment = prefix[index];

		if (!PARAM.test(segment) && !RESERVED.test(segment)) {
			return pluralize.singular(segment).replace(/[^A-Za-z0-9]/gu, "") || "id";
		}
	}

	return "id";
}

/** Disambiguate a parameter name against ones already used in the same path (`{id}`, `{id2}`, …). */
function uniqueName(base: string, prefix: string[]): string {
	const used = new Set(prefix.filter((segment) => PARAM.test(segment)).map((segment) => segment.slice(1, -1)));

	if (!used.has(base)) {
		return base;
	}

	for (let suffix = 2; ; suffix++) {
		if (!used.has(base + suffix)) {
			return base + suffix;
		}
	}
}

/** Walk the paths depth-first, deciding param-vs-constant per position, emitting a template per original path. */
function assign(paths: Path[], depth: number, prefix: string[], out: Map<string, string>): void {
	for (const path of paths) {
		if (path.segments.length === depth) {
			out.set(path.original, "/" + prefix.join("/"));
		}
	}

	const active = paths.filter((path) => path.segments.length > depth);

	if (active.length === 0) {
		return;
	}

	const groups = new Map<string, Path[]>();

	for (const path of active) {
		const value = path.segments[depth];
		let group = groups.get(value);

		if (group === undefined) {
			group = [];
			groups.set(value, group);
		}

		group.push(path);
	}

	if (isParameter(groups, depth)) {
		const name = uniqueName(parameterName(prefix), prefix);

		assign(active, depth + 1, [...prefix, `{${name}}`], out);
	} else {
		for (const group of groups.values()) {
			assign(group, depth + 1, [...prefix, group[0].segments[depth]], out);
		}
	}
}

/** Infer a `concrete path → OpenAPI-style template` map from a set of observed URLs (or paths). */
export function templatize(urls: string[]): Map<string, string> {
	const out = new Map<string, string>();

	assign(urls.map((url) => ({ "original": url, "segments": toSegments(url) })), 0, [], out);

	return out;
}
