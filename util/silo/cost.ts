/**
 * silo — what deleting a feature frees: its price (silo README, *The feature ledger*: "Prices"). The code only it reaches
 * — what's reachable from the program's ways in with it, and not without it — by the declaration graph (`./graph`): the
 * declarations, the files that are nothing but those, and their bytes and lines. Code no way in reaches isn't priced
 * (it's no feature's), so a price never says more than deleting would free.
 *
 * An entry is the feature a ledger entry names: a way in's roots (`./features`), and its `paths` (files or folders, from
 * the root) — its own code, priced whether anything else reaches it or not, and never entered on the way to the rest.
 */

import type { DeclarationGraph } from "./graph";
import { isEntry } from "@brianjenkins94/util/env";

/** What deleting an entry frees. */
export interface Price {
	/** The declarations only it reaches (node ids, `file#name`), its own among them. */
	"declarations": string[];
	/** The files that are nothing but those: deleted whole. */
	"files": string[];
	/** The bytes and lines of those declarations, where the graph knows their ranges (and `textOf` their text). */
	"bytes": number;
	"lines": number;
}

const fileOf = (id: string): string => id.slice(0, id.indexOf("#"));

/** Whether `file` is one of `paths`, or in one of them (a folder). */
function inside(file: string, paths: string[]): boolean {
	return paths.some((each) => {
		const folder = each.replace(/\/+$/u, "");

		return file === folder || file.startsWith(folder + "/");
	});
}

/** Every declaration reachable from `roots` without entering `blocked`. */
function reachAvoiding(graph: DeclarationGraph, roots: Iterable<string>, blocked: (id: string) => boolean): Set<string> {
	const seen = new Set<string>();
	const queue = [...roots].filter((id) => !blocked(id));

	for (const id of queue) {
		if (!seen.has(id)) {
			seen.add(id);
			queue.push(...graph.edges(id).filter((next) => !blocked(next) && !seen.has(next)));
		}
	}

	return new Set([...seen].filter((id) => graph.fingerprints.has(id)));
}

/**
 * The price of `entry` (its ways in's roots, its paths) in a program whose ways in start at `roots` (every feature's,
 * the entry's own among them). `textOf`: a file's text, for counting lines.
 */
export function priceOf(graph: DeclarationGraph, roots: Iterable<string>, entry: { "roots"?: string[]; "paths"?: string[] }, textOf?: (file: string) => string | undefined): Price {
	const paths = entry.paths ?? [];
	const own = new Set([...entry.roots ?? [], ...[...graph.fingerprints.keys()].filter((id) => inside(fileOf(id), paths))]);
	const all = [...roots];
	const withIt = reachAvoiding(graph, [...all, ...own], () => false);
	const without = reachAvoiding(graph, all, (id) => own.has(id) || inside(fileOf(id), paths));
	const freed = [...new Set([...withIt, ...[...own].filter((id) => graph.fingerprints.has(id))])].filter((id) => !without.has(id)).toSorted();
	const freedSet = new Set(freed);
	const byFile = new Map<string, string[]>();

	for (const id of graph.fingerprints.keys()) {
		byFile.set(fileOf(id), [...byFile.get(fileOf(id)) ?? [], id]);
	}

	let bytes = 0;
	let lines = 0;

	for (const id of freed) {
		const range = graph.range?.(id);

		if (range !== undefined) {
			bytes += range.end - range.start;

			const text = textOf?.(range.file);

			if (text !== undefined) {
				const slice = text.slice(range.start, range.end);

				// (a declaration's lines: a newline ending it doesn't start another)
				lines += slice.split("\n").length - (slice.endsWith("\n") ? 1 : 0);
			}
		}
	}

	return {
		"declarations": freed,
		"files": [...byFile].filter(([, ids]) => ids.every((id) => freedSet.has(id))).map(([file]) => file).toSorted(),
		"bytes": bytes,
		"lines": lines
	};
}

/** A price in a few words: what deleting frees. */
export function priceText(price: Price): string {
	if (price.declarations.length === 0) {
		return "frees nothing: everything it reaches, something else does too";
	}

	const files = price.files.length === 0 ? "" : `, ${price.files.length} file${price.files.length === 1 ? "" : "s"} whole`;

	return `frees ${price.declarations.length} declaration${price.declarations.length === 1 ? "" : "s"}${files}` + (price.bytes > 0 ? ` — ${price.lines > 0 ? `${price.lines} lines, ` : ""}${(price.bytes / 1024).toFixed(1)} KB` : "");
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// A program: two ways in (a.ts#main, b.ts#other), a.ts using shared.ts#util and only-a.ts#helper; b.ts using util too.
		const edges: Record<string, string[]> = { "a.ts#main": ["only-a.ts#helper", "shared.ts#util"], "b.ts#other": ["shared.ts#util"], "only-a.ts#helper": ["only-a.ts#deep"], "only-a.ts#deep": [], "shared.ts#util": [], "dead.ts#unused": [] };
		const ranges: Record<string, [number, number]> = { "a.ts#main": [0, 10], "only-a.ts#helper": [0, 20], "only-a.ts#deep": [21, 41], "shared.ts#util": [0, 5], "b.ts#other": [0, 8], "dead.ts#unused": [0, 3] };
		const graph: DeclarationGraph = {
			"fingerprints": new Map(Object.keys(edges).map((id) => [id, id])),
			"nodes": () => Object.keys(edges),
			"edges": (id) => edges[id] ?? [],
			"range": (id) => (ranges[id] === undefined ? undefined : { "file": fileOf(id), "start": ranges[id][0], "end": ranges[id][1] })
		};
		const roots = ["a.ts#main", "b.ts#other"];

		// a's way in: its own code and what only it reaches — not shared.ts, which b reaches too.
		assert.deepEqual(priceOf(graph, roots, { "roots": ["a.ts#main"] }).declarations, ["a.ts#main", "only-a.ts#deep", "only-a.ts#helper"]);
		assert.deepEqual(priceOf(graph, roots, { "roots": ["a.ts#main"] }).files, ["a.ts", "only-a.ts"]);
		assert.equal(priceOf(graph, roots, { "roots": ["a.ts#main"] }).bytes, 50);
		// By its paths: only-a.ts, whatever reaches it — and a.ts#main isn't freed (it's a way in of its own).
		assert.deepEqual(priceOf(graph, roots, { "paths": ["only-a.ts"] }).declarations, ["only-a.ts#deep", "only-a.ts#helper"]);
		// Shared code frees nothing; dead code, by its paths, is its own price.
		assert.deepEqual(priceOf(graph, roots, { "paths": ["shared.ts"] }).declarations, ["shared.ts#util"]);
		assert.deepEqual(priceOf(graph, roots, { "paths": ["dead.ts"] }).declarations, ["dead.ts#unused"]);
		assert.deepEqual(priceOf(graph, roots, { "roots": ["b.ts#other"] }).declarations, ["b.ts#other"]);
		// Lines, given the text.
		assert.equal(priceOf(graph, roots, { "paths": ["only-a.ts"] }, () => "function helper() {\n\treturn deep();\n}\nfunction deep() {\n}\n").lines, 4);
		assert.equal(priceText(priceOf(graph, roots, { "roots": ["a.ts#main"] })), "frees 3 declarations, 2 files whole — 0.0 KB");
	})();
}
