/**
 * silo — a run's trace (pure, zero-dep): what one run of a file did, line by line — the values things were, the calls it
 * made, how it ended — kept so the runs of a file stay (the editor's balls: editor RUNTIME-EVIDENCE.md, *Runs kept, as
 * balls*), deduped. On this machine only: a run's values can hold anything it read, so they never go in git (decided
 * 2026-10-26) — what runs observed is shared as evidence, summed (evidence.ts).
 *
 *   .silo/local/traces/<file>.jsonl          every run kept on this machine: its values as they were, and the text it ran
 *
 * A run is identified by its code: the BABLR span ids of the top-level declarations it executed (`declarations`) — content
 * hashes, so a reformat, a comment or an edit to code it didn't run leaves them as they were, and an edit inside one
 * changes it — and each value by the span around it. It's the same run as another (`traceKey`) when those, its inputs,
 * values and end are the same: kept once (`withRun`), counted. (A run without its declarations — its text couldn't be
 * parsed — is identified by its text's blob oid and lines.)
 */

import { isEntry } from "@brianjenkins94/util/env";
import type { Trigger } from "./policy.js";

/** A value a run put on a line (the editor's live values): where (`line`, its offsets in the text that ran `at`, and
 *  `span`, the id of the BABLR span around it — the same through a reformat, an edit elsewhere or a move), whose
 *  (`name`), what kind (bound, returned, a branch, a call skipped or given…), in which call and loop turns — and the
 *  value as previewed. */
export interface TraceValue { "line": number; "name": string; "kind": string; "call": number; "turns": number[]; "at"?: [number, number]; "span"?: string; "value"?: string }

/** A call a run made of one of its functions (its first line, and offsets). */
export interface TraceCall { "id": number; "name": string; "line": number; "at"?: [number, number] }

/** How a run ended short: crashed or stopped, on a line — and, kept locally, what it said. */
export interface TraceEnd { "kind": "crashed" | "stopped"; "line": number; "at"?: [number, number]; "message"?: string }

/** The test a run was (a test file's `node --test`): its id — the test file, and its suites' and its own titles, by
 *  ` › ` — and how it came out. A test's trace is kept on each file it executed, so a file's traces say which tests
 *  reach it, by the same declarations a run's do. */
export interface TraceTest { "id": string; "outcome": "pass" | "fail" | "skip" | "todo" }

/** One run of a file. */
export interface RunTrace {
	/** The run's id (its first, of the runs it stands for). */
	"id": string;
	/** The file, from the workspace root, and the git blob oid of the text that ran (where it came from: the run is
	 *  identified by `declarations`, when it has them). */
	"file": string;
	"oid": string;
	/** The BABLR span ids of the file's top-level declarations the run executed (sorted): its code. Content hashes — a
	 *  reformat or a comment doesn't change one, an edit inside it does — so the run is the same run, and still current,
	 *  for as long as each of them is in the text. */
	"declarations"?: string[];
	/** Who started it. */
	"trigger": Trigger;
	/** The test it was, when it was one: what of this file one test executed. */
	"test"?: TraceTest;
	/** The program it was a run of, from the workspace root, when that's another file: what of this file the run executed
	 *  (its values are on the runs of the files they're in) — kept as a test's is, that program's latest, so an edit here
	 *  can select it. */
	"program"?: string;
	/** When it (last) ran, ISO; how many runs it stands for. */
	"at": string;
	"count": number;
	"end"?: TraceEnd;
	/** What it read from outside, as `<capability> <resource>` (sorted): none, and its values are its code's. */
	"inputs": string[];
	"values": TraceValue[];
	"calls": TraceCall[];
	/** The text that ran, for placing its values. */
	"source"?: string;
}

/** A span of a text (BABLR's, as the editor's `annotations.spans` gives them): its content-addressed id and range. */
export interface Span { "id": string; "start": number; "end": number }

/** The text's top-level declarations: the spans nothing but the whole program contains. */
export function topLevel(spans: Span[]): Span[] {
	const sorted = spans.toSorted((left, right) => left.start - right.start || right.end - left.end);
	const root = sorted.find((span) => sorted.every((other) => other.start >= span.start && other.end <= span.end));
	const tops: Span[] = [];

	for (const span of sorted) {
		if (span !== root && (tops.length === 0 || span.start >= tops[tops.length - 1].end)) {
			tops.push(span);
		}
	}

	return tops;
}

/** The smallest span around `[start, end)`, if one is (what a value keeps, to be found through edits elsewhere). */
export function spanAround(spans: Span[], start: number, end: number): Span | undefined {
	let best: Span | undefined;

	for (const span of spans) {
		if (span.start <= start && end <= span.end && (best === undefined || span.end - span.start < best.end - best.start)) {
			best = span;
		}
	}

	return best;
}

/** The top-level declarations (ids, sorted) holding any of `ranges` — what a run's executed statements were in. */
export function declarationsHolding(spans: Span[], ranges: [number, number][]): string[] {
	const tops = topLevel(spans);
	const ids = new Set<string>();

	for (const [start] of ranges) {
		const top = tops.find((span) => span.start <= start && start < span.end);

		if (top !== undefined) {
			ids.add(top.id);
		}
	}

	return [...ids].toSorted();
}

/** An input as a run lists it: a URL without its query and fragment (a token rides there), anything else as it is. */
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

/** What makes a run the same run as another: the text it ran, its inputs, its values and its end. */
export function traceKey(trace: RunTrace): string {
	// By its code's spans when it has them — a reformat, a comment or an edit to code it didn't run leaves it the same
	// run — else by the exact text and lines.
	if (trace.declarations !== undefined && trace.declarations.length > 0) {
		return hash(JSON.stringify([trace.test === undefined ? null : [trace.test.id, trace.test.outcome], ...trace.program === undefined ? [] : [trace.program], trace.declarations, trace.inputs, trace.values.map((each) => [each.span ?? each.line, each.name, each.kind, each.call, each.turns, each.value ?? null]), trace.end === undefined ? null : [trace.end.kind]]));
	}

	return hash(JSON.stringify([trace.test === undefined ? null : [trace.test.id, trace.test.outcome], ...trace.program === undefined ? [] : [trace.program], trace.oid, trace.inputs, trace.values.map((each) => [each.line, each.name, each.kind, each.call, each.turns, each.value ?? null]), trace.end === undefined ? null : [trace.end.kind, trace.end.line]]));
}

/** What reached a file, when a trace is only that: a test, or a run of another program — undefined for the file's own runs. */
function reachOf(trace: RunTrace): string | undefined {
	if (trace.test !== undefined) {
		return `test ${trace.test.id}`;
	}

	return trace.program === undefined ? undefined : `program ${trace.program}`;
}

/** `traces` with `run` kept: the same run as one kept counts there (and is the latest), else it's added; the oldest past
 *  `keep` go. A test's run — or another program's, on a file it imported — is that test's (that program's) latest,
 *  whatever came before (its `keep` is one), and doesn't count toward the others' — a file many tests reach keeps each
 *  test's, and its own runs. */
export function withRun(traces: RunTrace[], run: RunTrace, keep = 8): RunTrace[] {
	const key = traceKey(run);
	const same = traces.find((each) => traceKey(each) === key);
	const kept = same === undefined ? run : { ...same, "at": same.at > run.at ? same.at : run.at, "count": same.count + run.count, ...run.source === undefined ? {} : { "source": run.source } };
	const reach = reachOf(run);

	if (reach !== undefined) {
		return [...traces.filter((each) => each !== same && reachOf(each) !== reach), kept];
	}

	const reached = traces.filter((each) => reachOf(each) !== undefined);
	const runs = traces.filter((each) => reachOf(each) === undefined && each !== same);

	return [...reached, ...[...runs, kept].slice(-keep)];
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

		// A test's run: that test's latest on the file, apart from the runs (another test's, or a run, doesn't displace it).
		const tested = (id: string, test: string, outcome: TraceTest["outcome"] = "pass"): RunTrace => ({ ...run(id, []), "declarations": ["fnA"], "test": { "id": test, "outcome": outcome } });
		const withTests = withRun(withRun(withRun(withRun([], tested("t1", "a.test.js › adds")), tested("t2", "a.test.js › subtracts")), run("r1", [x("1")]), 1), run("r2", [x("2")]), 1);

		assert.deepEqual(withTests.map((each) => each.id), ["t1", "t2", "r2"]);
		assert.deepEqual(withRun(withTests, tested("t3", "a.test.js › adds", "fail")).map((each) => each.id), ["t2", "r2", "t3"], "a test's newer run replaces its older");
		assert.equal(withRun(withTests, tested("t4", "a.test.js › adds")).find((each) => each.test?.id === "a.test.js › adds")?.count, 2, "the same again: counted");

		// Another program's run on a file it imported: that program's latest, as a test's — not counted among the file's own.
		const reached = (id: string, program: string, declarations = ["fnA"]): RunTrace => ({ ...run(id, []), "declarations": declarations, "program": program });
		const withPrograms = withRun(withRun(withRun(withTests, reached("p1", "main.js")), reached("p2", "other.js")), reached("p3", "main.js", ["fnA", "fnB"]), 1);

		assert.deepEqual(withPrograms.map((each) => each.id), ["t1", "t2", "r2", "p2", "p3"], "main.js's newer reach replaces its older; the file's own runs keep their own count");
		assert.notEqual(traceKey(reached("p4", "main.js")), traceKey(reached("p4", "other.js")), "two programs' reach of the same code: two traces");
		assert.equal(traceKey(run("same", [x("1")])), traceKey({ ...run("same", [x("1")]) }), "a trace with no program keeps its key");
		assert.notEqual(traceKey(tested("a", "x › one")), traceKey(tested("a", "x › two")), "two tests that ran the same code are two");

		// Spans: a program [0,40) of two declarations, [0,15) (with a statement [2,10) and a value [4,6) in it) and [20,38).
		const spans: Span[] = [{ "id": "prog", "start": 0, "end": 40 }, { "id": "fnA", "start": 0, "end": 15 }, { "id": "stmt", "start": 2, "end": 10 }, { "id": "val", "start": 4, "end": 6 }, { "id": "fnB", "start": 20, "end": 38 }];

		assert.deepEqual(topLevel(spans).map((span) => span.id), ["fnA", "fnB"]);
		assert.equal(spanAround(spans, 4, 6)?.id, "val");
		assert.equal(spanAround(spans, 3, 9)?.id, "stmt");
		assert.deepEqual(declarationsHolding(spans, [[3, 9], [25, 30], [16, 18]]), ["fnA", "fnB"], "what's between declarations holds nothing");

		// Identified by its code: its lines moved (an edit above, a reformat) — the same run; a declaration it ran changed —
		// another.
		const placed = (line: number, declarations = ["fnA"]): RunTrace => ({ ...run("s", [{ ...x("1"), "line": line, "span": "val" }]), "declarations": declarations });

		assert.equal(traceKey(placed(0)), traceKey({ ...placed(7), "oid": "moved" }));
		assert.notEqual(traceKey(placed(0)), traceKey(placed(0, ["fnA2"])));
		assert.notEqual(traceKey(run("a", [x("1")])), traceKey({ ...run("a", [x("1")]), "oid": "other" }), "no declarations: by its text");

		// A file's lines read back, a merge's duplicate folded.
		const text = tracesText([run("1", [x("1")]), run("2", [x("2")])]);

		assert.equal(parseTraces(text + text).length, 2);
		assert.equal(parseTraces(text + text)[0].count, 2);
		assert.equal(parseTraces("not json\n").length, 0);
	})();
}
