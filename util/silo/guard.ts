/**
 * The guard primitive (pure, zero-dep) — extracted from the `silo` prototype's `enforce/guard.ts`, which
 * earmarked itself for this hoist ("lives in silo until a second repo outside silo actually consumes it, at
 * which point it earns a hoist to lib").
 *
 * Check a value against a runtime predicate at a boundary, and react via a PLUGGABLE handler. One primitive,
 * one policy knob — the same instrumentation whether you throw (assert), record (observe), or hand off to a
 * broker:
 *   - `record` (default) — tally the violation and KEEP GOING. Non-crashing; accumulates "verified" evidence.
 *   - `strict` — throw. Dev / CI. `typia.assert`-style.
 *   - (a broker-prompt handler can gate on it, same as a capability broker.)
 *
 * The predicate is hand-written today; the design is for it to be GENERATED from the declared TS type and
 * INJECTED at boundaries by a transform — this module is the runtime target that transform emits calls to.
 *
 * The sink is module-global for now (fine for a single run); a real deployment may want a per-context sink so
 * concurrent runs don't co-mingle.
 */

export interface Mismatch {
	/** Where the check fired, e.g. `"builtinCaps#members"`. */
	"site": string;
	/** The declared type the value failed, e.g. `"string[]"`. */
	"type": string;
	/** The offending runtime value. */
	"value": unknown;
}

export type GuardHandler = (mismatch: Mismatch) => void;

const sink = {
	"matched": 0,
	"mismatched": 0,
	"incidents": [] as Mismatch[]
};

function describe(value: unknown): string {
	return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** Default handler: record the violation and keep going (never crash the host app). */
export function record(mismatch: Mismatch): void {
	sink.mismatched += 1;
	sink.incidents.push(mismatch);
}

/** Strict handler: throw on violation (dev / CI). */
export function strict(mismatch: Mismatch): never {
	throw new TypeError(`guard[${mismatch.site}]: expected ${mismatch.type}, got ${describe(mismatch.value)}`);
}

/**
 * Check `value` against `predicate` at a boundary. On pass, tally a match and return the value unchanged. On
 * fail, invoke `onMismatch` (default `record`) and still return the value — in record mode the app proceeds;
 * a throwing handler is what stops it.
 */
export function guard<T>(value: T, predicate: (value: unknown) => boolean, meta: { "site": string; "type": string }, onMismatch: GuardHandler = record): T {
	if (predicate(value)) {
		sink.matched += 1;

		return value;
	}

	onMismatch({ "site": meta.site, "type": meta.type, "value": value });

	return value;
}

/** Snapshot the accumulated observations — the "verified" evidence a review score reads. */
export function report(): { "matched": number; "mismatched": number; "incidents": Mismatch[] } {
	return { "matched": sink.matched, "mismatched": sink.mismatched, "incidents": [...sink.incidents] };
}

/** Clear the sink (between runs). */
export function reset(): void {
	sink.matched = 0;
	sink.mismatched = 0;
	sink.incidents.length = 0;
}
