/**
 * silo — which tests a change needs (pure, browser-portable): the selection by test and the vouches CI can take, from
 * silo README's *Tests by feature, in your face* and decisions 15–20.
 *
 * A test runs when nothing has recorded what it reaches, it's new, it failed or flaked lately, or the change reaches its
 * code and no current vouch says it passed. A vouch is a pass made where the code was written (an editor's commit flow,
 * a hook), kept in `.silo/vouches/<user>.jsonl`: the test, who, when, on what runtime, and the fingerprint of every
 * declaration it reached (./graph). It holds while the code still has every one of them as it was, so an edit after the
 * run lapses it, with nothing to forge around. CI takes one only when it has run the test itself within the window, the
 * runtime is its own or the two have agreed on the test before, and the test isn't one of the few audited at random.
 * A test the change doesn't reach rests once it's been green long enough; a full run (weekly) runs everything.
 *
 * Reach is by declaration: what a test ran, where a front end records it, else what its file reaches in the declaration
 * graph (`staticReach`, the floor: what it could run).
 */

import type { DeclarationGraph } from "./graph";
import type { TestStanding } from "./outcomes";
import { isEntry } from "@brianjenkins94/util/env";
import { reach, TOP } from "./graph";

/** A pass (or a failure) made where the code was written, for CI to take. */
export interface Vouch {
	/** The test: its file and titles, joined by ` › ` (`testId`). */
	"test": string;
	"outcome": "pass" | "fail";
	"by": string;
	/** ISO time. */
	"at": string;
	/** Where it ran: `node`, `tsval`, a browser's. */
	"runtime": string;
	/** The commit it was made for, when there is one. */
	"commit"?: string;
	/** Each declaration it reached, by id (`file#name`), with its fingerprint then. */
	"reached": Record<string, string>;
}

/** A test, by its file and titles. */
export const testId = (file: string, titles: readonly string[]): string => [file, ...titles].join(" › ");

/** `vouches`, a line each, as a `.silo/vouches/<user>.jsonl` holds them. */
export const vouchesText = (vouches: readonly Vouch[]): string => vouches.map((vouch) => JSON.stringify(vouch) + "\n").join("");

/** The vouches in a `.silo/vouches/<user>.jsonl`: a line each, one that doesn't parse left out. */
export function parseVouches(text: string): Vouch[] {
	return text.split("\n").flatMap((line) => {
		try {
			const vouch = JSON.parse(line) as Vouch;

			return typeof vouch.test === "string" && typeof vouch.reached === "object" ? [vouch] : [];
		} catch {
			return [];
		}
	});
}

/** What a test file reaches in the graph: its body and everything that leads to (`file#(top)`). */
export function staticReach(graph: DeclarationGraph, file: string): Set<string> {
	return reach(graph, [`${file}#${TOP}`]);
}

/** Each declaration of `reached` with its fingerprint now (for a vouch). */
export function fingerprintsOf(graph: DeclarationGraph, reached: Iterable<string>): Record<string, string> {
	return Object.fromEntries([...reached].flatMap((id) => {
		const fingerprint = graph.fingerprints.get(id);

		return fingerprint === undefined ? [] : [[id, fingerprint]];
	}));
}

/** Whether `vouch` holds of the code as `fingerprints` has it: every declaration it reached still there, unchanged. */
export function vouchHolds(vouch: Vouch, fingerprints: ReadonlyMap<string, string>): boolean {
	return Object.entries(vouch.reached).every(([id, fingerprint]) => fingerprints.get(id) === fingerprint);
}

/** What selection needs to know. */
export interface Selection {
	/** The tests CI would run, by id, with their files. */
	"tests": readonly { "id": string; "file": string }[];
	/** What each test reaches (declaration ids), or undefined where nothing's recorded. */
	"reach": (test: { "id": string; "file": string }) => ReadonlySet<string> | undefined;
	/** The declarations the change changed (./graph `changedDeclarations`). */
	"changed": ReadonlySet<string>;
	/** Every declaration's fingerprint at the change (what a vouch is held to). */
	"fingerprints": ReadonlyMap<string, string>;
	/** Each test's standing in CI's own runs (./outcomes `standings`), by id. */
	"standings": ReadonlyMap<string, TestStanding>;
	/** Everyone's vouches (whose count: decision 18, anyone who can push). */
	"vouches": readonly Vouch[];
	/** The runtime CI runs the tests on. */
	"runtime": string;
	/** Tests whose outcomes a vouch's runtime and CI's have agreed on before (decision 19): a vouch made on another
	 *  runtime counts for these only. */
	"agreed"?: ReadonlySet<string>;
	/** Run everything (the scheduled full run). */
	"full"?: boolean;
	/** Now, in ms. */
	"now": number;
	/** CI runs a vouched test itself when it hasn't within this long (decision 16: a week). */
	"windowMs"?: number;
	/** A test the change doesn't reach rests after this many green runs in a row. */
	"restAfter"?: number;
	/** Fewer runs than this, and a test is new. */
	"newUnder"?: number;
	/** The share of vouched tests run anyway, at random (decision 17: a setting, zero allowed). */
	"audit"?: number;
	"random"?: () => number;
}

/** A test, and whether CI runs it, with why. */
export interface Selected {
	"id": string;
	"file": string;
	"run": boolean;
	"why": "full run" | "untraced" | "new" | "failing" | "flaky" | "touched" | "audit" | "vouched" | "resting" | "not reached";
	/** The vouch taken (a skip it explains), or the one audited. */
	"vouch"?: { "by": string; "at": string; "runtime": string };
}

export const WEEK = 7 * 86_400_000;
export const REST_AFTER = 20;
export const NEW_UNDER = 3;

/** Each of the tests, run or not, and why. */
export function selectTests(selection: Selection): Selected[] {
	const { windowMs = WEEK, restAfter = REST_AFTER, newUnder = NEW_UNDER, audit = 0, random = Math.random } = selection;
	const current = new Map<string, Vouch>();

	// (the latest vouch for each test that holds of the code now and counts on CI's runtime)
	for (const vouch of selection.vouches) {
		const counts = vouch.outcome === "pass" && (vouch.runtime === selection.runtime || selection.agreed?.has(vouch.test) === true) && vouchHolds(vouch, selection.fingerprints);

		if (counts && (current.get(vouch.test)?.at ?? "") < vouch.at) {
			current.set(vouch.test, vouch);
		}
	}

	return selection.tests.map((test): Selected => {
		const chosen = (run: boolean, why: Selected["why"], vouch?: Vouch): Selected => ({ "id": test.id, "file": test.file, "run": run, "why": why, ...vouch === undefined ? {} : { "vouch": { "by": vouch.by, "at": vouch.at, "runtime": vouch.runtime } } });
		const standing = selection.standings.get(test.id);
		const reached = selection.reach(test);

		if (selection.full === true) {
			return chosen(true, "full run");
		}

		if (reached === undefined) {
			return chosen(true, "untraced");
		}

		if (standing === undefined || standing.runs < newUnder) {
			return chosen(true, "new");
		}

		const lately = standing.lastFailed !== undefined && selection.now - Date.parse(standing.lastFailed.at) < windowMs;

		if (standing.last.verdict === "fail" || standing.last.verdict === "flaky" || lately) {
			return chosen(true, standing.lastFailed?.verdict === "flaky" || standing.last.verdict === "flaky" ? "flaky" : "failing");
		}

		const touched = [...reached].some((id) => selection.changed.has(id));

		if (!touched) {
			return standing.streak.verdict === "pass" && standing.streak.runs >= restAfter ? chosen(false, "resting") : chosen(true, "not reached");
		}

		const vouch = current.get(test.id);
		const ranLately = selection.now - Date.parse(standing.last.at) < windowMs;

		if (vouch === undefined || !ranLately) {
			return chosen(true, "touched");
		}

		return random() < audit ? chosen(true, "audit", vouch) : chosen(false, "vouched", vouch);
	});
}

/** The files to run for `selected` (a test file runs whole: decision 15), in order. */
export function filesToRun(selected: readonly Selected[]): string[] {
	return [...new Set(selected.filter((test) => test.run).map((test) => test.file))].sort();
}

/** What `selected` says, a line each skipped and run, for a CI's log. */
export function selectionText(selected: readonly Selected[]): string {
	const counts = new Map<string, number>();

	for (const test of selected) {
		counts.set(`${test.run ? "run" : "skip"}: ${test.why}`, (counts.get(`${test.run ? "run" : "skip"}: ${test.why}`) ?? 0) + 1);
	}

	const files = filesToRun(selected);

	return [
		`${String(selected.filter((test) => test.run).length)} of ${String(selected.length)} tests run (${String(files.length)} files)`,
		...[...counts].sort(([one], [other]) => one.localeCompare(other)).map(([why, count]) => `  ${why}: ${String(count)}`),
		...selected.filter((test) => !test.run).map((test) => `  skipped ${test.id} (${test.why}${test.vouch === undefined ? "" : `, by ${test.vouch.by} at ${test.vouch.at} on ${test.vouch.runtime}`})`)
	].join("\n");
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const NOW = Date.parse("2026-11-22T12:00:00Z");
		const ago = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();
		// (a program: add.test.mjs reaches add.mjs#add; mul.test.mjs reaches mul.mjs#mul)
		const edges: Record<string, string[]> = { "add.test.mjs#(top)": ["add.mjs#add"], "mul.test.mjs#(top)": ["mul.mjs#mul"] };
		const graph = (add: string): DeclarationGraph => ({ "fingerprints": new Map([["add.test.mjs#(top)", "t1"], ["mul.test.mjs#(top)", "t2"], ["add.mjs#add", add], ["mul.mjs#mul", "m1"]]), "nodes": () => Object.keys(edges), "edges": (id) => edges[id] ?? [] });
		const before = graph("a1");
		const after = graph("a2");
		const standing = (id: string, streak: number, last = ago(1)): TestStanding => ({ "id": id, "runs": 30, "last": { "verdict": "pass", "run": "1", "commit": "c", "at": last }, "flakes": 0, "streak": { "verdict": "pass", "runs": streak } });
		const add = testId("add.test.mjs", ["adds"]);
		const mul = testId("mul.test.mjs", ["multiplies"]);
		const tests = [{ "id": add, "file": "add.test.mjs" }, { "id": mul, "file": "mul.test.mjs" }];
		const base: Selection = { "tests": tests, "reach": (test) => staticReach(after, test.file), "changed": new Set(["add.mjs#add"]), "fingerprints": after.fingerprints, "standings": new Map([[add, standing(add, 25)], [mul, standing(mul, 25)]]), "vouches": [], "runtime": "node", "now": NOW };
		const vouch = (graphThen: DeclarationGraph, runtime = "node"): Vouch => ({ "test": add, "outcome": "pass", "by": "brian", "at": ago(0), "runtime": runtime, "reached": fingerprintsOf(graphThen, staticReach(graphThen, "add.test.mjs")) });
		const why = (selected: Selected[]): string[] => selected.map((test) => `${test.run ? "run" : "skip"} ${test.why}`);

		assert.deepEqual([...staticReach(after, "add.test.mjs")].sort(), ["add.mjs#add", "add.test.mjs#(top)"]);
		// The change touches add's code: it runs; mul, green 25 runs, rests.
		assert.deepEqual(why(selectTests(base)), ["run touched", "skip resting"]);
		// Vouched for the code as it is now: skipped, saying whose; for the code before the change: lapsed, so it runs.
		assert.deepEqual(why(selectTests({ ...base, "vouches": [vouch(after)] })), ["skip vouched", "skip resting"]);
		assert.equal(selectTests({ ...base, "vouches": [vouch(after)] })[0]?.vouch?.by, "brian");
		assert.deepEqual(why(selectTests({ ...base, "vouches": [vouch(before)] })), ["run touched", "skip resting"]);
		// Another runtime's vouch counts only for a test they've agreed on; CI not having run it in a week, it runs anyway.
		assert.deepEqual(why(selectTests({ ...base, "vouches": [vouch(after, "tsval")] })), ["run touched", "skip resting"]);
		assert.deepEqual(why(selectTests({ ...base, "vouches": [vouch(after, "tsval")], "agreed": new Set([add]) })), ["skip vouched", "skip resting"]);
		assert.deepEqual(why(selectTests({ ...base, "vouches": [vouch(after)], "standings": new Map([[add, standing(add, 25, ago(8))], [mul, standing(mul, 25)]]) })), ["run touched", "skip resting"]);
		// Audited at random: run anyway; at zero, never.
		assert.deepEqual(why(selectTests({ ...base, "vouches": [vouch(after)], "audit": 0.5, "random": () => 0.1 })), ["run audit", "skip resting"]);
		// New, untraced, failing lately, not yet rested, and the full run.
		assert.deepEqual(why(selectTests({ ...base, "standings": new Map() })), ["run new", "run new"]);
		assert.deepEqual(why(selectTests({ ...base, "reach": () => undefined })), ["run untraced", "run untraced"]);
		assert.deepEqual(why(selectTests({ ...base, "standings": new Map([[add, standing(add, 25)], [mul, { ...standing(mul, 2), "lastFailed": { "verdict": "fail", "run": "0", "commit": "b", "at": ago(3) } }]]) })), ["run touched", "run failing"]);
		assert.deepEqual(why(selectTests({ ...base, "standings": new Map([[add, standing(add, 25)], [mul, standing(mul, 5)]]) })), ["run touched", "run not reached"]);
		assert.deepEqual(why(selectTests({ ...base, "full": true })), ["run full run", "run full run"]);
		assert.deepEqual(filesToRun(selectTests(base)), ["add.test.mjs"]);
		// A vouch file's lines, back.
		assert.deepEqual(parseVouches(vouchesText([vouch(after)]) + "not json\n"), [vouch(after)].map((each) => ({ ...each, "at": each.at })));
		console.log("select: ok");
	})();
}
