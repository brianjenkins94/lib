/**
 * silo — a run's trace (pure, zero-dep): what one run of a file did, line by line — the values things were, the calls it
 * made, how it ended — kept so the runs of a file stay (the editor's balls: editor LIVE-VALUES.md, *Runs kept, as
 * balls*), deduped, and the ones that match the file as it is shared in git.
 *
 *   .silo/local/traces/<file>.jsonl          every run kept on this machine: its values as they were, and the text it ran
 *   .silo/traces/<user>/<file>.jsonl         SHARED · the runs of the file as it's saved now (by its blob oid), one person's
 *
 * A value can hold a secret, so what's shared is only what can't: a run that read no inputs is determined by its code,
 * which is in git already, so its values are shared as they were. "Read no inputs" is decided on the safe side: none in
 * its `inputs` (what the runtime saw it read — not every runtime tells every read), no argument read, and code that
 * can't read from outside at all (`mayRead`: no import or require, nothing of `process`, `fetch`, sockets, storage or the
 * page). Any other run shares each value's type alone (`committable`),
 * the inputs it read by capability and resource (a URL without its query or fragment), and how it ended without the
 * message (an error's text can quote a value). The values stay on this machine.
 *
 * A run is the same run as another (`traceKey`) when it ran the same text (`oid`) to the same values, inputs and end:
 * kept once (`withRun`), counted. A file's shared runs are the ones of its text as it's saved (`current`): when the file
 * changes, the runs of the text before it leave the file — git keeps them, in the commit whose code they match.
 */

import { isEntry } from "@brianjenkins94/util/env";
import type { Trigger } from "./policy.js";

/** A value a run put on a line (the editor's live values): where (`line`, its offsets in the text that ran `at`), whose
 *  (`name`), what kind (bound, returned, a branch, a call skipped or given…), in which call and loop turns — and the
 *  value as previewed, or, shared from a run that read inputs, its type alone. */
export interface TraceValue { "line": number; "name": string; "kind": string; "call": number; "turns": number[]; "at"?: [number, number]; "value"?: string; "type"?: string }

/** A call a run made of one of its functions (its first line, and offsets). */
export interface TraceCall { "id": number; "name": string; "line": number; "at"?: [number, number] }

/** How a run ended short: crashed or stopped, on a line — and, kept locally, what it said. */
export interface TraceEnd { "kind": "crashed" | "stopped"; "line": number; "at"?: [number, number]; "message"?: string }

/** One run of a file. */
export interface RunTrace {
	/** The run's id (its first, of the runs it stands for). */
	"id": string;
	/** The file, from the workspace root, and the git blob oid of the text that ran. */
	"file": string;
	"oid": string;
	/** Who started it. */
	"trigger": Trigger;
	/** When it (last) ran, ISO; how many runs it stands for. */
	"at": string;
	"count": number;
	"end"?: TraceEnd;
	/** What it read from outside, as `<capability> <resource>` (sorted): none, and its values are its code's. */
	"inputs": string[];
	"values": TraceValue[];
	"calls": TraceCall[];
	/** The text that ran: kept locally, for placing its values; never shared (the oid names it in git). */
	"source"?: string;
}

/** Whether `source` could read from outside — so its values may hold what it read: any import or require (a module can
 *  read), anything of `process` (env, argv, stdin), the network, storage, the page. A heuristic on the safe side: code
 *  that can't, can't; code that could is treated as if it did. */
export function mayRead(source: string): boolean {
	return /\b(?:import|require|process|fetch|XMLHttpRequest|WebSocket|EventSource|navigator|localStorage|sessionStorage|indexedDB|caches|document|location|Deno|Bun|globalThis|self|window|eval|Function)\b/u.test(source);
}

/** A value's type, from its preview: what a run that read inputs shares in place of it. */
export function typeOf(preview: string | undefined): string {
	if (preview === undefined) {
		return "undefined";
	}

	if (/^['"`]/u.test(preview)) {
		return "string";
	}

	if (/^(?:-?\d|NaN$|-?Infinity$)/u.test(preview)) {
		return "number";
	}

	if (preview === "true" || preview === "false") {
		return "boolean";
	}

	if (preview === "null" || preview === "undefined") {
		return preview;
	}

	if (preview.startsWith("ƒ")) {
		return "function";
	}

	return preview.startsWith("[") ? "array" : "object";
}

/** An input as shared: a URL without its query and fragment (a token rides there), anything else as it is. */
export function inputOf(capability: string, resource: string): string {
	const shown = capability.startsWith("net") ? resource.replace(/[?#].*$/u, "") : resource;

	return `${capability} ${shown}`.trim();
}

/** A string's hash, 64-bit FNV-1a as hex: a key, not a secret's. */
function hash(text: string): string {
	let value = 0xcbf29ce484222325n;

	for (let index = 0; index < text.length; index += 1) {
		value ^= BigInt(text.charCodeAt(index));
		value = (value * 0x100000001b3n) & 0xffffffffffffffffn;
	}

	return value.toString(16).padStart(16, "0");
}

/** What makes a run the same run as another: the text it ran, its inputs, its values (or their types) and its end. */
export function traceKey(trace: RunTrace): string {
	return hash(JSON.stringify([trace.oid, trace.inputs, trace.values.map((each) => [each.line, each.name, each.kind, each.call, each.turns, each.value ?? null, each.type ?? null]), trace.end === undefined ? null : [trace.end.kind, trace.end.line]]));
}

/** `traces` with `run` kept: the same run as one kept counts there (and is the latest), else it's added; the oldest past
 *  `keep` go. */
export function withRun(traces: RunTrace[], run: RunTrace, keep = 8): RunTrace[] {
	const key = traceKey(run);
	const same = traces.find((each) => traceKey(each) === key);
	const others = traces.filter((each) => each !== same);
	const kept = same === undefined ? run : { ...same, "at": same.at > run.at ? same.at : run.at, "count": same.count + run.count, ...run.source === undefined ? {} : { "source": run.source } };

	return [...others, kept].slice(-keep);
}

/** A run as it's shared in git: never its text; and unless it surely read nothing (`inputs` none, no argument read, and
 *  its text unable to read — `mayRead`), its values' types alone and its end without what it said. */
export function committable(trace: RunTrace): RunTrace {
	const { "source": _source, ...shared } = trace;

	// (its text decides it: without it, as if it read)
	if (trace.inputs.length === 0 && !trace.values.some((each) => each.kind === "input") && trace.source !== undefined && !mayRead(trace.source)) {
		return shared;
	}

	return {
		...shared,
		"values": trace.values.map(({ value, ...rest }) => ({ ...rest, "type": rest.type ?? typeOf(value) })),
		...trace.end === undefined ? {} : { "end": { "kind": trace.end.kind, "line": trace.end.line, ...trace.end.at === undefined ? {} : { "at": trace.end.at } } }
	};
}

/** The runs of the text `oid` names — the file as it is. */
export function current(traces: RunTrace[], oid: string): RunTrace[] {
	return traces.filter((each) => each.oid === oid);
}

/** A traces file's runs (one a line; a line that isn't one is skipped), the same run twice — two branches' — kept once. */
export function parseTraces(text: string): RunTrace[] {
	let traces: RunTrace[] = [];

	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			continue;
		}

		try {
			const parsed = JSON.parse(line) as RunTrace;

			if (typeof parsed.id === "string" && typeof parsed.oid === "string" && Array.isArray(parsed.values)) {
				traces = withRun(traces, parsed, Number.POSITIVE_INFINITY);
			}
		} catch {
			// not a run
		}
	}

	return traces;
}

/** A traces file's text: a run a line, oldest first (so a merge keeps both sides' lines, and the reader folds them). */
export function tracesText(traces: RunTrace[]): string {
	return traces.map((each) => JSON.stringify(each) + "\n").join("");
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const run = (id: string, values: TraceValue[], inputs: string[] = [], at = "2026-10-22T10:00:00.000Z"): RunTrace => ({ "id": id, "file": "src/a.js", "oid": "abc", "trigger": "edit", "at": at, "count": 1, "inputs": inputs, "values": values, "calls": [], "source": "const x = 1;" });
		const x = (value: string): TraceValue => ({ "line": 0, "name": "x", "kind": "bind", "call": 0, "turns": [], "value": value });

		// Types from previews.
		assert.deepEqual(["'a'", "12", "-1.5", "true", "null", "undefined", "ƒ sum", "[1, 2]", "{ a: 1 }", "Map(1) { … }"].map(typeOf), ["string", "number", "number", "boolean", "null", "undefined", "function", "array", "object", "object"]);
		assert.equal(inputOf("net", "https://api.example.com/rates?key=SECRET#x"), "net https://api.example.com/rates");
		assert.equal(inputOf("fs:read", "/workspace/.env"), "fs:read /workspace/.env");

		// The same run twice: kept once, counted, the latest time.
		const twice = withRun(withRun([], run("1", [x("1")])), run("2", [x("1")], [], "2026-10-22T11:00:00.000Z"));

		assert.equal(twice.length, 1);
		assert.equal(twice[0].count, 2);
		assert.equal(twice[0].id, "1");
		assert.equal(twice[0].at, "2026-10-22T11:00:00.000Z");
		// Another value is another run; the oldest past `keep` go.
		assert.equal(withRun(twice, run("3", [x("2")])).length, 2);
		assert.deepEqual(withRun(withRun(withRun([], run("a", [x("1")])), run("b", [x("2")]), 2), run("c", [x("3")]), 2).map((each) => each.id), ["b", "c"]);

		// Shared: never the text; a run with no inputs as it was, one with inputs by types alone and its end without its message.
		const pure = committable(run("p", [x("1")]));

		assert.equal(pure.source, undefined);
		assert.equal(pure.values[0].value, "1");

		const read = committable({ ...run("r", [x("'sk-live-123'")], ["net https://api.example.com/rates"]), "end": { "kind": "crashed", "line": 0, "message": "bad key sk-live-123" } });

		assert.equal(read.values[0].value, undefined);
		assert.equal(read.values[0].type, "string");
		assert.deepEqual(read.end, { "kind": "crashed", "line": 0 });
		assert.ok(!JSON.stringify(read).includes("sk-live"), "nothing of the value left");
		// Its code could read (a require, process.env…) though the runtime told no input: as if it read. No text: likewise.
		const reads = committable({ ...run("q", [x("'sk-live-123'")]), "source": "const key = require('fs').readFileSync('.env', 'utf8');" });

		assert.equal(reads.values[0].value, undefined);
		assert.equal(committable({ ...run("e", [x("'abc'")]), "source": "const key = process.env.KEY;" }).values[0].value, undefined);
		assert.equal(committable({ ...run("n", [x("1")]), "source": undefined }).values[0].value, undefined);
		assert.equal(mayRead("const items = [1, 2, 3];\nlet total = 0;\nfor (const item of items) total += item;\nconsole.log(total);\n"), false);
		// process.argv read: an input too.
		assert.equal(committable(run("v", [{ ...x("'--token=abc'"), "kind": "input" }])).values[0].value, undefined);

		// The file as it is: its text's runs; a file's lines read back, a merge's duplicate folded.
		assert.deepEqual(current([run("1", [x("1")]), { ...run("2", [x("2")]), "oid": "def" }], "def").map((each) => each.id), ["2"]);

		const text = tracesText([pure, read]);

		assert.equal(parseTraces(text + text).length, 2);
		assert.equal(parseTraces(text + text)[0].count, 2);
		assert.equal(parseTraces("not json\n").length, 0);
	})();
}
