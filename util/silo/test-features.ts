/**
 * silo — features from tests (pure, zero-dep): a repository's tests grouped by the code they execute, each group a
 * feature named by its tests, and its code the declarations they reach (the editor's Features view: editor RUNNING.md,
 * *Tests*). A test is a way in every repository has, and its file and titles say what it's for; nothing here is a list
 * written for one repository (silo README, *Derived history*: why the ways-in layer is parked).
 *
 * What a test reaches is its traces (traces.ts' `test`): on each file it ran, the top-level declarations it executed,
 * by BABLR span. Its own file's are its test code, not the feature's, so they're left out. Code most tests reach
 * (`ambient`: at least AMBIENT_SHARE of them, once there are AMBIENT_MIN tests) is what any test runs — setup, helpers,
 * logging — and says nothing about which feature a test is: it's set apart, not clustered on. Then tests whose code
 * overlaps (the average Jaccard similarity between two groups' tests, at least JOIN) are one feature, joined most
 * similar first. A feature is named by what its tests share: the suites they all have, else their most common own
 * title. A declaration can belong to several features.
 */

import { isEntry } from "@brianjenkins94/util/env";
import type { RunTrace } from "./traces.js";

/** Of the tests, the share that makes code ambient — and how many tests there must be before any is. (Half: a feature
 *  can be a third of a repository's unit tests. The spike's 30% was for end-to-end suites, where everything shares a
 *  boot — silo README, *Which tests reach what*.) */
export const AMBIENT_SHARE = 0.5;
export const AMBIENT_MIN = 10;
/** How alike two groups of tests must be (their tests' average Jaccard similarity) to be one feature. */
export const JOIN = 0.5;

/** A declaration of a file: its path, and its BABLR span id. */
export interface Declaration { "file": string; "id": string }

/** A feature: its name, its tests (ids, as traces have them) and how each last came out, and its code. */
export interface TestFeature { "name": string; "tests": { "id": string; "outcome": string }[]; "declarations": Declaration[] }

const key = (declaration: Declaration): string => `${declaration.file}#${declaration.id}`;
const fileOf = (test: string): string => test.split(" › ")[0];

/** The features `traces`' tests make, largest first, and the code set apart as ambient. Traces other than tests' are
 *  ignored; a test's latest trace on each file counts. */
export function featuresFromTests(traces: RunTrace[]): { "features": TestFeature[]; "ambient": Declaration[] } {
	const reach = new Map<string, Map<string, Declaration>>();
	const outcomes = new Map<string, { "outcome": string; "at": string }>();
	const latest = new Map<string, RunTrace>();

	for (const trace of traces) {
		if (trace.test === undefined) {
			continue;
		}

		const at = `${trace.test.id}\u0000${trace.file}`;
		const seen = latest.get(at);

		if (seen === undefined || seen.at < trace.at) {
			latest.set(at, trace);
		}
	}

	for (const trace of latest.values()) {
		const test = trace.test!;
		const known = outcomes.get(test.id);

		if (known === undefined || known.at < trace.at) {
			outcomes.set(test.id, { "outcome": test.outcome, "at": trace.at });
		}

		const reached = reach.get(test.id) ?? new Map<string, Declaration>();

		reach.set(test.id, reached);

		// (its own file's code is the test's)
		if (trace.file === fileOf(test.id)) {
			continue;
		}

		for (const id of trace.declarations ?? []) {
			reached.set(key({ "file": trace.file, "id": id }), { "file": trace.file, "id": id });
		}
	}

	const tests = [...reach.keys()].toSorted();
	const counts = new Map<string, { "declaration": Declaration; "tests": number }>();

	for (const reached of reach.values()) {
		for (const [name, declaration] of reached) {
			counts.set(name, { "declaration": declaration, "tests": (counts.get(name)?.tests ?? 0) + 1 });
		}
	}

	const ambient = new Set(tests.length < AMBIENT_MIN ? [] : [...counts].filter(([, { "tests": many }]) => many >= AMBIENT_SHARE * tests.length).map(([name]) => name));
	const own = new Map(tests.map((test) => [test, new Set([...reach.get(test)!.keys()].filter((name) => !ambient.has(name)))]));
	const similarity = (left: string, right: string): number => {
		const a = own.get(left)!;
		const b = own.get(right)!;
		const shared = [...a].filter((name) => b.has(name)).length;
		const all = a.size + b.size - shared;

		return all === 0 ? 0 : shared / all;
	};
	// Groups, joined most similar first while any two are alike enough (average linkage).
	let groups = tests.filter((test) => own.get(test)!.size > 0).map((test) => [test]);
	const linkage = (left: string[], right: string[]): number => left.reduce((sum, a) => sum + right.reduce((inner, b) => inner + similarity(a, b), 0), 0) / (left.length * right.length);

	for (;;) {
		let best: { "i": number; "j": number; "score": number } | undefined;

		for (let i = 0; i < groups.length; i += 1) {
			for (let j = i + 1; j < groups.length; j += 1) {
				const score = linkage(groups[i], groups[j]);

				if (score >= JOIN && (best === undefined || score > best.score)) {
					best = { "i": i, "j": j, "score": score };
				}
			}
		}

		if (best === undefined) {
			break;
		}

		const { i, j } = best;

		groups = [...groups.filter((_, index) => index !== i && index !== j), [...groups[i], ...groups[j]].toSorted()];
	}

	const features = groups.map((group): TestFeature => {
		const declarations = new Map<string, Declaration>();

		for (const test of group) {
			for (const name of own.get(test)!) {
				declarations.set(name, counts.get(name)!.declaration);
			}
		}

		return {
			"name": nameOf(group),
			"tests": group.map((test) => ({ "id": test, "outcome": outcomes.get(test)?.outcome ?? "pass" })),
			"declarations": [...declarations.values()].toSorted((left, right) => key(left).localeCompare(key(right)))
		};
	});

	return {
		"features": features.toSorted((left, right) => right.tests.length - left.tests.length || left.name.localeCompare(right.name)),
		"ambient": [...ambient].map((name) => counts.get(name)!.declaration)
	};
}

/** A lone test's own titles; a group's: the suites its tests all share, else their most common own title (the first,
 *  of a tie). */
function nameOf(tests: string[]): string {
	const titles = tests.map((test) => test.split(" › "));

	if (tests.length === 1) {
		return titles[0].slice(1).join(" › ") || titles[0][0];
	}

	const shared: string[] = [];

	for (let index = 0; index < Math.min(...titles.map((each) => each.length - 1)); index += 1) {
		if (titles.every((each) => each[index] === titles[0][index])) {
			shared.push(titles[0][index]);
		} else {
			break;
		}
	}

	// (a file alone isn't a name: several features can share one)
	if (shared.length > 1) {
		return shared.slice(1).join(" › ");
	}

	const leaves = new Map<string, number>();

	for (const each of titles) {
		leaves.set(each.at(-1)!, (leaves.get(each.at(-1)!) ?? 0) + 1);
	}

	return [...leaves].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		let n = 0;
		const ran = (test: string, file: string, declarations: string[], outcome: "pass" | "fail" = "pass", at = "2026-10-23T10:00:00.000Z"): RunTrace => ({ "id": String(n += 1), "file": file, "oid": "x", "declarations": declarations, "trigger": "you", "test": { "id": test, "outcome": outcome }, "at": at, "count": 1, "inputs": [], "values": [], "calls": [] });

		// calc: three tests run add (one of them in another file), one runs subtract — two features; each test's own file's
		// code isn't counted; a feature's name is its tests' suite, else their commonest title — a lone test's, its titles.
		const calc = featuresFromTests([
			ran("calc.test.js › calc › adds", "calc.js", ["add"]),
			ran("calc.test.js › calc › adds", "calc.test.js", ["describe"]),
			ran("calc.test.js › calc › subtracts", "calc.js", ["subtract"]),
			ran("calc.test.js › fails", "calc.js", ["add"], "fail"),
			ran("calc-add.test.js › adds", "calc.js", ["add"])
		]);

		assert.deepEqual(calc.features.map((feature) => [feature.name, feature.tests.length, feature.declarations.map((each) => each.id)]), [["adds", 3, ["add"]], ["calc › subtracts", 1, ["subtract"]]]);
		assert.equal(calc.features[0].tests.find((test) => test.id === "calc.test.js › fails")?.outcome, "fail");
		assert.deepEqual(featuresFromTests([ran("a.test.js › parser › reads", "p.js", ["read"]), ran("a.test.js › parser › writes", "p.js", ["read", "write"])]).features.map((feature) => feature.name), ["parser"], "a shared suite names it");

		// Ambient: code most of enough tests run is set apart, so it doesn't make them one feature.
		const many = Array.from({ "length": 12 }, (_, index) => ran(`t.test.js › t${index}`, "lib.js", ["log", ["parse", "render", "format"][index % 3]]));
		const split = featuresFromTests(many);

		assert.deepEqual(split.ambient.map((each) => each.id), ["log"]);
		assert.deepEqual(split.features.map((feature) => feature.declarations.map((each) => each.id)), [["parse"], ["render"], ["format"]]);
		// A test's latest trace on a file counts; one that reached only its own file is in no feature.
		assert.deepEqual(featuresFromTests([ran("x.test.js › x", "a.js", ["old"], "pass", "2026-10-22T00:00:00.000Z"), ran("x.test.js › x", "a.js", ["new"])]).features[0].declarations.map((each) => each.id), ["new"]);
		assert.deepEqual(featuresFromTests([ran("y.test.js › y", "y.test.js", ["own"])]).features, []);
	})();
}
