/**
 * silo — features from the code alone (pure, zero-dep): a program's ways in (./features) grouped so each group may be
 * one feature, knowing nothing about the repository, each grouping scored against the features the ledger declares
 * (`scoreGrouping`): how near a derivation is to what people declared (silo README, *The feature manifest*). A grouping
 * is each way in's group, by its key; a way in it can't place is in none.
 *
 *   byFile     the file that registers it: a baseline, what a derivation has to beat
 *   byFolder   that file's folder: a baseline the other way, fewer and larger groups
 *   byReach    what it reaches in the declaration graph, less what many ways in reach (ambient: setup, the hub,
 *              logging), joined by overlap (./test-features `joinAlike`); one reaching nothing of its own (a handler
 *              written inline, where it's registered) by its file
 *   byTests    the tests' clusters (features from tests), from CI's records of what each test ran (./ledger
 *              CI_RECORDS); each way in in the cluster its own reach overlaps most, none when it overlaps none
 *
 * And a join over any of them, `linkedBySubjects`: a hub request or subscription is joined to a way in whose
 * registration quotes its subject — the edge between realms the declaration graph doesn't have (an agent tool and the
 * request it makes, served elsewhere). Only a registration's own code: a subject quoted further off (in what it calls)
 * is as often a catalog of subjects or a composition root, which joins features that aren't one.
 */

import type { Feature } from "./features";
import type { DeclarationGraph } from "./graph";
import type { Declared } from "./ledger";
import { isEntry } from "@brianjenkins94/util/env";
import { nodeId, reach, TOP } from "./graph";
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

/** `grouping` with each hub way in's group joined to the groups of the ways in whose registration quotes its subject (a
 *  literal one: `"files.read"`); `textOf` reads a file. */
export function linkedBySubjects(grouping: Grouping, features: Iterable<Feature>, textOf: (file: string) => string | undefined): Grouping {
	const all = [...features];
	const served = all.filter((feature) => (feature.facet === "hub request" || feature.facet === "hub subscription") && /^[\w.-]+$/u.test(feature.id)).map((feature) => ({ "feature": feature, "quoted": new RegExp(`["'\`]${feature.id.replaceAll(".", "\\.")}["'\`]`, "u") }));
	const parent = new Map<string, string>();
	const find = (group: string): string => {
		const up = parent.get(group);

		return up === undefined || up === group ? group : find(up);
	};

	for (const feature of all) {
		const registration = feature.ranges.map((range) => textOf(range.file)?.slice(range.start, range.end) ?? "").join("\n");

		for (const { "feature": server, quoted } of served) {
			if (server.key !== feature.key && grouping.has(server.key) && grouping.has(feature.key) && quoted.test(registration)) {
				const [left, right] = [find(grouping.get(feature.key)!), find(grouping.get(server.key)!)];

				if (left !== right) {
					parent.set(left, right);
				}
			}
		}
	}

	return new Map([...grouping].map(([key, group]) => [key, find(group)]));
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

/** How near a grouping of the ways in is to the features the ledger declares (./ledger `declaredFeatures`). Of the features that own ways in: `whole`
 *  ones are one group with nothing else in it; `split` ones are in more than one group, `merged` ones share a group with
 *  another feature (`splitAndMerged`, both); `partly` ones are whole but for ways in the grouping placed nowhere;
 *  `unseen` ones have none placed. `precision` and `recall` are B-cubed, each way in's: how much of its group is its
 *  feature, and how much of its feature is in its group (a way in placed nowhere has none) — and `f`, their harmonic
 *  mean. */
export interface GroupingScore {
	"features": number;
	"ways": number;
	"placed": number;
	"groups": number;
	"whole": number;
	"split": number;
	"merged": number;
	"splitAndMerged": number;
	"partly": number;
	"unseen": number;
	"precision": number;
	"recall": number;
	"f": number;
}

/** `grouping` (each way in's group, by its key) scored against `declared`'s features. */
export function scoreGrouping(declared: Declared[], grouping: ReadonlyMap<string, string>): GroupingScore {
	const truth = new Map(declared.flatMap(([name, feature]) => (feature.ways ?? []).map((key): [string, string] => [key, name])));
	const members = (of: Iterable<[string, string]>): Map<string, string[]> => {
		const by = new Map<string, string[]>();

		for (const [key, group] of of) {
			by.set(group, [...by.get(group) ?? [], key]);
		}

		return by;
	};
	const byFeature = members([...truth].map(([key, feature]): [string, string] => [key, feature]));
	const byGroup = members([...grouping].filter(([key]) => truth.has(key)));
	const score: GroupingScore = { "features": byFeature.size, "ways": truth.size, "placed": 0, "groups": byGroup.size, "whole": 0, "split": 0, "merged": 0, "splitAndMerged": 0, "partly": 0, "unseen": 0, "precision": 0, "recall": 0, "f": 0 };

	for (const [feature, keys] of byFeature) {
		const groups = new Set(keys.flatMap((key) => (grouping.has(key) ? [grouping.get(key)!] : [])));
		const split = groups.size > 1;
		const merged = [...groups].some((group) => byGroup.get(group)!.some((key) => truth.get(key) !== feature));

		if (groups.size === 0) {
			score.unseen += 1;
		} else if (split && merged) {
			score.splitAndMerged += 1;
		} else if (split) {
			score.split += 1;
		} else if (merged) {
			score.merged += 1;
		} else if (keys.some((key) => !grouping.has(key))) {
			score.partly += 1;
		} else {
			score.whole += 1;
		}
	}

	let precision = 0;
	let recall = 0;

	for (const [key, feature] of truth) {
		const group = grouping.has(key) ? byGroup.get(grouping.get(key)!)! : undefined;

		if (group !== undefined) {
			const same = group.filter((each) => truth.get(each) === feature).length;

			score.placed += 1;
			precision += same / group.length;
			recall += same / byFeature.get(feature)!.length;
		}
	}

	score.precision = score.placed === 0 ? 0 : precision / score.placed;
	score.recall = truth.size === 0 ? 0 : recall / truth.size;
	score.f = score.precision + score.recall === 0 ? 0 : 2 * score.precision * score.recall / (score.precision + score.recall);

	return score;
}

/**
 * The code each of `declared`'s features owns, by node id, each feature by its name. A feature owns what its ways in
 * reach, and what registers them: the declaration each registration is written in (an `install…`, an `activate`, a
 * module's body) and what its own code reaches; and every declaration in its `paths`, with what they reach (code no way
 * in leads to: a route, a library's export). A handler's code is its way's, not that declaration's (./ts-analysis), so a
 * declaration that registers many features leads to its setup, not into theirs. A declaration several features reach is
 * each one's.
 */
export function codeOwners(declared: Declared[], features: ReadonlyMap<string, Feature>, graph: DeclarationGraph): Map<string, Set<string>> {
	const declarations = new Map<string, { "id": string; "start": number; "end": number }[]>();

	for (const id of graph.fingerprints.keys()) {
		const range = graph.range?.(id);

		if (range !== undefined) {
			declarations.set(range.file, [...declarations.get(range.file) ?? [], { "id": id, "start": range.start, "end": range.end }]);
		}
	}

	/** The declaration a registration is written in: the narrowest that holds it, else its module's body. */
	const holder = ({ file, start, end }: { "file": string; "start": number; "end": number }): string[] => {
		const held = (declarations.get(file) ?? []).filter((each) => each.start <= start && end <= each.end).toSorted((left, right) => (left.end - left.start) - (right.end - right.start))[0];

		return held !== undefined ? [held.id] : graph.fingerprints.has(nodeId(file, TOP)) ? [nodeId(file, TOP)] : [];
	};
	const owners = new Map<string, Set<string>>();
	const ids = [...graph.fingerprints.keys()];

	for (const [name, feature] of declared) {
		const ways = (feature.ways ?? []).flatMap((key) => (features.has(key) ? [features.get(key)!] : []));
		const under = (id: string): boolean => (feature.paths ?? []).some((path) => {
			const file = id.slice(0, id.lastIndexOf("#"));
			const at = path.replace(/\/+$/u, "");

			return file === at || file.startsWith(at + "/");
		});

		for (const id of reach(graph, [...ways.flatMap((way) => [...way.roots, ...way.ranges.flatMap(holder)]), ...ids.filter(under)])) {
			owners.set(id, (owners.get(id) ?? new Set()).add(name));
		}
	}

	return owners;
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
		// Subjects: the agent tool in tools.ts quotes "files.read", served in workspace.ts — joined; "files.write", quoted
		// only by what the tool calls, isn't.
		const hub = (key: string, id: string, file: string, start: number, end: number): Feature => ({ ...way(key, file, []), "facet": key.startsWith("hub") ? "hub request" : "agent tool", "id": id, "ranges": [{ "file": file, "start": start, "end": end }] });
		const texts: Record<string, string> = { "tools.ts": `tool("files_read", () => request("files.read")); helper();`, "workspace.ts": `serve("files.read", read); serve("files.write", write);` };
		const linked = linkedBySubjects(new Map([["tool", "tools.ts"], ["read", "workspace.ts#read"], ["write", "workspace.ts#write"]]), [hub("tool", "files_read", "tools.ts", 0, 45), hub("hub read", "files.read", "workspace.ts", 0, 26), hub("hub write", "files.write", "workspace.ts", 27, 55)].map((each, index) => ({ ...each, "key": ["tool", "read", "write"][index] })), (file) => texts[file]);

		assert.equal(linked.get("tool"), linked.get("read"));
		assert.notEqual(linked.get("write"), linked.get("read"));
		{
			// Scoring a grouping: notes whole; commit split over two groups; push merged with pull; tags unseen.
			const truth: Declared[] = [["notes", { "ways": ["n1", "n2"] }], ["commit", { "ways": ["c1", "c2"] }], ["push", { "ways": ["p1"] }], ["pull", { "ways": ["l1"] }], ["tags", { "ways": ["t1"] }]];
			const scored = scoreGrouping(truth, new Map([["n1", "g1"], ["n2", "g1"], ["c1", "g2"], ["c2", "g3"], ["p1", "g4"], ["l1", "g4"], ["elsewhere", "g5"]]));

			assert.deepEqual({ ...scored, "precision": undefined, "recall": undefined, "f": undefined }, { "features": 5, "ways": 7, "placed": 6, "groups": 4, "whole": 1, "split": 1, "merged": 2, "splitAndMerged": 0, "partly": 0, "unseen": 1, "precision": undefined, "recall": undefined, "f": undefined });
			// (precision: n1 n2 c1 c2 1 each, p1 l1 ½ each → 5/6; recall: n 1+1, c ½+½, p 1, l 1, t 0 → 5/7)
			assert.equal(scored.precision.toFixed(4), (5 / 6).toFixed(4));
			assert.equal(scored.recall.toFixed(4), (5 / 7).toFixed(4));
			// The features grouped as themselves are whole.
			assert.equal(scoreGrouping(truth, new Map([["n1", "n"], ["n2", "n"], ["c1", "c"], ["c2", "c"], ["p1", "p"], ["l1", "l"], ["t1", "t"]])).f, 1);
			// Owners: activate registers both commands (offsets 10–40 and 50–80 inside it) and sets up with `connect`; each
			// handler uses its own helper. Each feature owns its helper; both own activate and connect; `unused` is no one's.
			const edges: Record<string, string[]> = { "a.ts#activate": ["a.ts#connect"], "a.ts#connect": [], "a.ts#open": [], "a.ts#save": [], "a.ts#unused": [] };
			const ranges: Record<string, [number, number]> = { "a.ts#activate": [0, 100], "a.ts#connect": [100, 120], "a.ts#open": [120, 140], "a.ts#save": [140, 160], "a.ts#unused": [160, 180] };
			const graph: DeclarationGraph = { "fingerprints": new Map(Object.keys(edges).map((id) => [id, id])), "nodes": () => Object.keys(edges), "edges": (id) => edges[id] ?? [], "range": (id) => (ranges[id] === undefined ? undefined : { "file": "a.ts", "start": ranges[id]![0], "end": ranges[id]![1] }) };
			const command = (id: string, root: string, start: number): [string, Feature] => [`command|${id}`, { "key": `command|${id}`, "facet": "command", "id": id, "label": "", "files": ["a.ts"], "sides": ["registered"], "code": [], "roots": [root], "ranges": [{ "file": "a.ts", "start": start, "end": start + 30 }] }];
			const owned = codeOwners([["open", { "ways": ["command|open"] }], ["save", { "ways": ["command|save"] }]], new Map([command("open", "a.ts#open", 10), command("save", "a.ts#save", 50)]), graph);

			assert.deepEqual(Object.fromEntries([...owned].map(([id, of]) => [id, [...of].toSorted()])), { "a.ts#open": ["open"], "a.ts#activate": ["open", "save"], "a.ts#connect": ["open", "save"], "a.ts#save": ["save"] });
			// A feature's paths own what's in them, a file or a folder: `unused` by its file, and nothing in a file that only
			// starts with the path's name.
			assert.deepEqual([...codeOwners([["by file", { "paths": ["a.ts"] }], ["by folder", { "paths": ["a"] }]], new Map(), graph).keys()].toSorted(), ["a.ts#activate", "a.ts#connect", "a.ts#open", "a.ts#save", "a.ts#unused"]);
		}
	})();
}
