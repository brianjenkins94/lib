/**
 * silo — features from the code alone (pure, zero-dep): a program's ways in (./features) grouped so each group may be
 * one feature, knowing nothing about the repository, each grouping scored against its manifest (./manifest
 * `scoreGrouping`): how near a derivation is to taking the hand-written manifest's place (silo README, *The feature
 * manifest*). A grouping is each way in's group, by its key; a way in it can't place is in none.
 *
 *   byFile     the file that registers it: a baseline, what a derivation has to beat
 *   byFolder   that file's folder: a baseline the other way, fewer and larger groups
 *   byReach    what it reaches in the declaration graph, less what many ways in reach (ambient: setup, the hub,
 *              logging), joined by overlap (./test-features `joinAlike`); one reaching nothing of its own (a handler
 *              written inline, where it's registered) by its file
 *   byTests    the tests' clusters (features from tests), from CI's records of what each test ran (./ledger
 *              CI_RECORDS); each way in in the cluster its own reach overlaps most, none when it overlaps none
 */

import type { Feature } from "./features";
import type { DeclarationGraph } from "./graph";
import { isEntry } from "@brianjenkins94/util/env";
import { reach, TOP } from "./graph";
import { AMBIENT_MIN, joinAlike } from "./test-features";

/** Each way in's group, by its key. */
export type Grouping = Map<string, string>;

/** Of the ways in, the share that makes a declaration ambient for `byReach`. */
export const REACH_AMBIENT = 0.1;
/** How alike two groups' reach must be to be one feature (their ways' average Jaccard similarity). */
export const REACH_JOIN = 0.5;
/** Of the tests, the share that makes a declaration ambient for `byTests` (as ./test-features' AMBIENT_SHARE). */
export const TESTS_AMBIENT = 0.5;
/** How alike two groups of tests must be to be one cluster (./test-features' JOIN). */
export const TESTS_JOIN = 0.5;

/** The file that registers a way in: its code's, else its manifest's. */
export const registeredIn = (feature: Pick<Feature, "files">): string => feature.files.find((file) => !/(^|\/)package\.json$/u.test(file)) ?? feature.files[0] ?? "";

export function byFile(features: Iterable<Feature>): Grouping {
	return new Map([...features].map((feature) => [feature.key, registeredIn(feature)]));
}

export function byFolder(features: Iterable<Feature>): Grouping {
	return new Map([...features].map((feature) => [feature.key, registeredIn(feature).split("/").slice(0, -1).join("/")]));
}

/** `sets` less what at least `share` of them hold — once there are AMBIENT_MIN of them (./test-features). */
function lessAmbient(sets: ReadonlyMap<string, ReadonlySet<string>>, share: number): Map<string, Set<string>> {
	if (sets.size < AMBIENT_MIN) {
		return new Map([...sets].map(([item, set]) => [item, new Set(set)]));
	}

	const counts = new Map<string, number>();

	for (const set of sets.values()) {
		for (const each of set) {
			counts.set(each, (counts.get(each) ?? 0) + 1);
		}
	}

	return new Map([...sets].map(([item, set]) => [item, new Set([...set].filter((each) => (counts.get(each) ?? 0) < share * sets.size))]));
}

/** Each way in's own reach: what it reaches in `graph`, less what REACH_AMBIENT of the ways in reach. */
function ownReach(features: Feature[], graph: DeclarationGraph): Map<string, Set<string>> {
	return lessAmbient(new Map(features.map((feature) => [feature.key, reach(graph, feature.roots)])), REACH_AMBIENT);
}

export function byReach(features: Iterable<Feature>, graph: DeclarationGraph): Grouping {
	const all = [...features];
	const groups = joinAlike(ownReach(all, graph), REACH_JOIN);
	const grouping: Grouping = new Map(groups.flatMap((group, index) => group.map((key) => [key, `reach ${index}`])));

	for (const feature of all) {
		if (!grouping.has(feature.key)) {
			grouping.set(feature.key, registeredIn(feature));
		}
	}

	return grouping;
}

/** What each test ran, in CI's records (`{ tests, reach: { file: { "name, name": [test…] } } }`): its declarations as
 *  node ids, by its index — a method by its class, a file's body as TOP, as ./ledger `reachedFromRecords` reads them. */
export function testsFromRecords(text: string | undefined): Map<string, Set<string>> {
	const tests = new Map<string, Set<string>>();

	try {
		const { reach: ran } = JSON.parse(text ?? "{}") as { "reach"?: Record<string, Record<string, number[]>> };

		for (const [file, names] of Object.entries(ran ?? {})) {
			for (const [name, indexes] of Object.entries(names)) {
				for (const each of name.split(", ")) {
					for (const index of indexes) {
						const set = tests.get(String(index)) ?? new Set<string>();

						set.add(`${file}#${each === "(top level)" ? TOP : each.split(".")[0]}`);
						tests.set(String(index), set);
					}
				}
			}
		}
	} catch {
		// (not records: no tests)
	}

	return tests;
}

export function byTests(features: Iterable<Feature>, graph: DeclarationGraph, tests: ReadonlyMap<string, ReadonlySet<string>>): Grouping {
	const all = [...features];
	const own = lessAmbient(tests, TESTS_AMBIENT);
	const clusters = joinAlike(own, TESTS_JOIN).map((cluster) => new Set(cluster.flatMap((test) => [...own.get(test)!])));
	const reaches = ownReach(all, graph);
	const grouping: Grouping = new Map();

	for (const feature of all) {
		const mine = [...reaches.get(feature.key)!];
		let best = -1;
		let most = 0;

		for (const [index, code] of clusters.entries()) {
			const shared = mine.filter((id) => code.has(id)).length;

			if (shared > most) {
				most = shared;
				best = index;
			}
		}

		if (best !== -1) {
			grouping.set(feature.key, `tests ${best}`);
		}
	}

	return grouping;
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// Two features' ways in, a.ts's two commands sharing parse; b.ts's own; log everything reaches; c.ts's inline.
		const edges: Record<string, string[]> = { "a.ts#open": ["a.ts#parse", "log.ts#log"], "a.ts#save": ["a.ts#parse", "log.ts#log"], "b.ts#draw": ["b.ts#paint", "log.ts#log"], "a.ts#parse": [], "b.ts#paint": [], "log.ts#log": [] };
		const graph: DeclarationGraph = { "fingerprints": new Map(Object.keys(edges).map((id) => [id, id])), "nodes": () => Object.keys(edges), "edges": (id) => edges[id] ?? [] };
		const way = (key: string, file: string, roots: string[]): Feature => ({ "key": key, "facet": "command", "id": key, "label": key, "files": [file, "package.json"], "sides": [], "code": [], "roots": roots, "ranges": [] });
		const ways = [way("open", "src/a.ts", ["a.ts#open"]), way("save", "src/a.ts", ["a.ts#save"]), way("draw", "src/b/b.ts", ["b.ts#draw"]), way("inline", "src/c.ts", [])];

		assert.deepEqual([...byFile(ways)], [["open", "src/a.ts"], ["save", "src/a.ts"], ["draw", "src/b/b.ts"], ["inline", "src/c.ts"]]);
		assert.deepEqual([...byFolder(ways).values()], ["src", "src", "src/b", "src"]);
		const reached = byReach(ways, graph);

		assert.equal(reached.get("open"), reached.get("save"));
		assert.notEqual(reached.get("open"), reached.get("draw"));
		assert.equal(reached.get("inline"), "src/c.ts");
		// Tests: one ran open's code and save's, one draw's; the inline way in overlaps no cluster.
		const tests = testsFromRecords(JSON.stringify({ "reach": { "a.ts": { "open, save": [0], "parse": [0] }, "b.ts": { "draw": [1], "paint": [1] } } }));

		assert.deepEqual([...tests.get("0")!].toSorted(), ["a.ts#open", "a.ts#parse", "a.ts#save"]);
		const tested = byTests(ways, graph, tests);

		assert.equal(tested.get("open"), tested.get("save"));
		assert.notEqual(tested.get("open"), tested.get("draw"));
		assert.equal(tested.has("inline"), false);
		assert.equal(testsFromRecords("not json").size, 0);
	})();
}
