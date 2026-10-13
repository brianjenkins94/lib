/**
 * silo — what runs say about a feature (pure, browser-portable): whether its code ran. A feature's own code is where it's
 * registered (its inline handler) and the declarations its registration names; what ran is runtime evidence placed in
 * the files as they are now (RUNTIME-EVIDENCE.md: each `reached` observation is on a BABLR span, found in the current text
 * by the editor's resolver — the join with BABLR happens there, at the edge; this only compares ranges).
 *
 *   exercised   a statement in its own code ran — how many runs saw it, and when last;
 *   dormant     its file ran (a run ran it, or evidence was kept for it) but its own code never did;
 *   unobserved  no run ever ran its file: nothing to say yet.
 *
 * What it reaches beyond its own code doesn't count (a helper many features share would make them all look exercised),
 * nor does the statement that registers it, which runs whether or not it's ever used: only code strictly inside counts.
 */

import type { Feature } from "./features";
import type { DeclarationGraph } from "./graph";
import { isEntry } from "@brianjenkins94/util/env";
import { TOP } from "./graph";

/** A range of a file. */
export interface Range { "file": string; "start": number; "end": number }

/** A span that ran, where it is in its file now, and how much: what every run's `reached` observations of it add up to. */
export interface Ran extends Range {
	/** Runs it ran in, since its span last changed (strict). */
	"ever": number;
	/** The faded run count behind it. */
	"runs": number;
	"lastAt": string;
}

export type Exercise =
	| { "status": "exercised"; "runs": number; "lastAt": string }
	| { "status": "dormant"; "files": string[] }
	| { "status": "unobserved" };

/** A feature's own code: its registrations, and the declarations its roots name (an import followed to what it names;
 *  a module's body isn't its own). */
export function codeOf(feature: Feature, graph: DeclarationGraph): Range[] {
	const code: Range[] = [...feature.ranges];
	const seen = new Set<string>();
	const pending = [...feature.roots];

	while (pending.length > 0) {
		const id = pending.pop()!;

		if (seen.has(id) || id.endsWith("#" + TOP)) {
			continue;
		}

		seen.add(id);

		const range = graph.fingerprints.has(id) ? graph.range?.(id) : undefined;

		if (range !== undefined) {
			code.push(range);
		} else if (!graph.fingerprints.has(id)) {
			// An import: on to what it names.
			pending.push(...graph.edges(id));
		}
	}

	return code;
}

/**
 * What runs say of a feature: `ran` is every span that ran, by file, as placed now; `observed` the files some run ran or
 * kept evidence for.
 */
export function exerciseOf(feature: Feature, graph: DeclarationGraph, ran: ReadonlyMap<string, Ran[]>, observed: ReadonlySet<string>): Exercise {
	const code = codeOf(feature, graph);
	let runs = 0;
	let lastAt = "";

	for (const range of code) {
		for (const span of ran.get(range.file) ?? []) {
			// Strictly inside: the statement that registers it (run when it's registered), or a declaration's own statement
			// (run when its module loads), isn't its code running.
			if (span.ever > 0 && range.start <= span.start && span.end <= range.end && (range.start < span.start || span.end < range.end)) {
				runs = Math.max(runs, span.runs);
				lastAt = span.lastAt > lastAt ? span.lastAt : lastAt;
			}
		}
	}

	if (lastAt !== "") {
		return { "status": "exercised", "runs": Math.round(runs * 10) / 10, "lastAt": lastAt };
	}

	const files = [...new Set(code.map((range) => range.file))].filter((file) => observed.has(file)).sort();

	return files.length > 0 ? { "status": "dormant", "files": files } : { "status": "unobserved" };
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const { featuresOf } = await import("./features");

		// app.ts:  [0, 100) registers "go" — its handler at [40, 90), a statement in it at [50, 60) — and "stay" at [100, 200),
		// whose handler calls `helper`, imported from helper.ts, where it's declared at [0, 50) with a statement at [20, 30).
		const features = featuresOf([{ "file": "app.ts", "ways": [
			{ "facet": "command", "id": "go", "label": "", "range": [0, 100], "roots": [] },
			{ "facet": "command", "id": "stay", "label": "", "range": [100, 200], "roots": ["app.ts#helper"] },
			{ "facet": "command", "id": "away", "label": "", "range": [200, 300], "roots": [] }
		] }]);
		const graph: DeclarationGraph = {
			"fingerprints": new Map([["helper.ts#helper", "f"]]),
			"nodes": () => ["helper.ts#helper", "app.ts#helper"],
			"edges": (id) => (id === "app.ts#helper" ? ["helper.ts#helper", "helper.ts#(top)"] : []),
			"range": (id) => (id === "helper.ts#helper" ? { "file": "helper.ts", "start": 0, "end": 50 } : undefined)
		};
		const at = "2026-10-12T00:00:00Z";
		const ran = new Map<string, Ran[]>([
			// "go"'s handler statement ran; the statement registering "stay" ran (it's registered at load) — not its code.
			["app.ts", [{ "file": "app.ts", "start": 50, "end": 60, "ever": 3, "runs": 2.5, "lastAt": at }, { "file": "app.ts", "start": 100, "end": 200, "ever": 1, "runs": 1, "lastAt": at }]],
			["helper.ts", []]
		]);

		assert.deepEqual(exerciseOf(features.get("command|go")!, graph, ran, new Set(["app.ts"])), { "status": "exercised", "runs": 2.5, "lastAt": at });
		assert.deepEqual(exerciseOf(features.get("command|stay")!, graph, ran, new Set(["app.ts"])), { "status": "dormant", "files": ["app.ts"] }, "its registration ran, its code didn't");
		assert.deepEqual(codeOf(features.get("command|stay")!, graph).map((range) => range.file + ":" + String(range.start)), ["app.ts:100", "helper.ts:0"], "its root, through the import, to the declaration");

		// The helper's body ran: "stay" ran, through what its registration names.
		ran.set("helper.ts", [{ "file": "helper.ts", "start": 20, "end": 30, "ever": 1, "runs": 1, "lastAt": at }]);
		assert.equal(exerciseOf(features.get("command|stay")!, graph, ran, new Set(["app.ts", "helper.ts"])).status, "exercised");
		assert.deepEqual(exerciseOf(features.get("command|away")!, graph, new Map(), new Set()), { "status": "unobserved" }, "no run ran its file");
	})();
}
