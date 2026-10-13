/**
 * silo — a program's declaration graph (pure, browser-portable): which of its top-level declarations use which, across
 * its files' imports. What a feature REACHES (`./history`): from its registration, the declarations it uses, and theirs
 * in turn — so a change to any of them is a change to the feature, wherever in the program it was made.
 *
 * A node is a name in a file, `file#name`: a top-level declaration (a function, a class, a variable, an enum, the
 * default export) or an import. A declaration's edges are the names its code uses that the file declares or imports; an
 * import's one edge is what it resolves to — a relative import, or one of the program's own packages by name (a
 * workspace's, through its package.json `exports`) — through `export … from` re-exports, to the declaration that module
 * exports (`import * as ns` then `ns.name`: that export; `ns` alone: every declaration of the module). Any other
 * package (`vscode`, a dependency) is outside the program and ends the walk.
 *
 * A module's body — its top-level statements that aren't declarations — is a node too, `file#(top)`: importing a module
 * runs it, and it runs every module it imports, so an import leads to its module's body as well as to what it exports.
 * (A registry filled as its modules load is reached this way; a program's entry, which nothing imports, isn't — its
 * boot isn't any one feature's.) Left out: types (a type changes no behavior), and a name shadowed by a local of the
 * same name (counted as the top-level one).
 * Each declaration carries a fingerprint — its AST without positions — so a change in comments or whitespace isn't one.
 *
 * `oxc` + pure AST logic only, the same portability contract as `./features`: no fs, git or network.
 */

import type { WayIn } from "./features";

/** A module's body: its top-level statements that aren't declarations. */
export const TOP = "(top)";

/** One of the program's own packages: where it is, and the file each of its entry points (`.`, `./sub`) names. */
export interface Package {
	"name": string;
	"dir": string;
	"exports": Record<string, string>;
}

/** A package.json's package — if it names one with an entry point — for `./graph`'s resolution of imports by name. */
export function packageOf(manifest: string, text: string): Package | undefined {
	let json: Record<string, any>;

	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}

	if (typeof json["name"] !== "string") {
		return undefined;
	}

	// An export's file: a path, or the condition a bundler takes (`import`, else `default`, else the first path).
	const pick = (value: unknown): string | undefined => typeof value === "string" ? value : typeof value === "object" && value !== null ? pick((value as Record<string, unknown>)["import"] ?? (value as Record<string, unknown>)["default"] ?? Object.values(value).find((each) => typeof each === "string")) : undefined;
	const raw = json["exports"] ?? json["main"];
	const exports: Record<string, string> = {};

	if (typeof raw === "string" || (typeof raw === "object" && raw !== null && !Object.keys(raw).some((key) => key.startsWith(".")))) {
		const file = pick(raw);

		if (file !== undefined) {
			exports["."] = file;
		}
	} else if (typeof raw === "object" && raw !== null) {
		for (const [subpath, value] of Object.entries(raw)) {
			const file = pick(value);

			if (file !== undefined && !subpath.includes("*")) {
				exports[subpath] = file;
			}
		}
	}

	return Object.keys(exports).length === 0 ? undefined : { "name": json["name"], "dir": manifest.slice(0, Math.max(0, manifest.lastIndexOf("/"))), "exports": exports };
}

/** The node id of `name` in `file`. */
export const nodeId = (file: string, name: string): string => file + "#" + name;

/** The files a module specifier, imported from `from`, can be (a relative one; a package import is none). */
export function candidates(from: string, specifier: string): string[] {
	if (!specifier.startsWith(".")) {
		return [];
	}

	const parts = from.split("/").slice(0, -1);

	for (const part of specifier.split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== ".") {
			parts.push(part);
		}
	}

	const base = parts.join("/");
	// TypeScript's own spelling: `./x.js` names `./x.ts`.
	const stem = base.replace(/\.[cm]?js$/u, "");

	return [base, ...[".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"].map((extension) => stem + extension), ...["/index.ts", "/index.tsx", "/index.js"].map((index) => base + index)];
}

// ── the seam ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What reach and history need of a program, whoever analyzed it: its declarations (by node id, `file#name`, each with
 * the fingerprint of its code), and where each node leads. Node ids are a file's own names — its declarations, its body
 * (`TOP`) and its imports by local name — so a feature's roots (`./features`) name nodes in any analyzer's graph.
 */
export interface DeclarationGraph {
	/** Each declaration's fingerprint, by node id. */
	readonly "fingerprints": ReadonlyMap<string, string>;
	/** Every node with edges: the declarations and the imports. */
	nodes(): Iterable<string>;
	/** Where a node leads: the declarations (or imports) its code uses, or what an import resolves to. */
	edges(id: string): string[];
}

/** What an analyzer makes of a snapshot: its declaration graph, and each file's ways in (`./features`). */
export interface Analysis {
	"graph": DeclarationGraph;
	/** Each file's ways in, by path (a file with none may be missing). */
	"ways": ReadonlyMap<string, WayIn[]>;
}

/**
 * Reads a snapshot of the program: its ways in and its declaration graph, from one reading of each file. Called once per
 * snapshot, oldest first, so one may build each from the last. `files`: the program's files by path, each by the id of
 * its content; `read` gets a content. oxc's (`./oxc`) is the default; TypeScript's read the same over its own tree
 * (`./ts-analysis`): TypeScript 7's in Node (`./typescript`), and a TypeScript server's (the editor's history plugin).
 */
export interface Analyzer {
	analyze(files: ReadonlyMap<string, string>, read: (oid: string) => Promise<string>): Promise<Analysis>;
	/** Let go of what it holds (a compiler process). */
	close?(): void;
}

/** Every declaration reachable from `roots` (node ids: declarations or imports), the roots' own included. */
export function reach(graph: DeclarationGraph, roots: Iterable<string>): Set<string> {
	const seen = new Set<string>();
	const queue = [...roots];

	while (queue.length > 0) {
		const id = queue.pop()!;

		if (seen.has(id)) {
			continue;
		}

		seen.add(id);
		queue.push(...graph.edges(id));
	}

	return new Set([...seen].filter((id) => graph.fingerprints.has(id)));
}

const reverses = new WeakMap<DeclarationGraph, Map<string, string[]>>();

/**
 * Every node that reaches one of `targets`, each with the target it reaches (the nearest, by the walk back). The other
 * direction of `reach`: from a few changed declarations to everything that uses them.
 */
export function reachers(graph: DeclarationGraph, targets: Iterable<string>): Map<string, string> {
	let reverse = reverses.get(graph);

	if (reverse === undefined) {
		const built = new Map<string, string[]>();

		for (const from of graph.nodes()) {
			for (const to of graph.edges(from)) {
				built.set(to, [...built.get(to) ?? [], from]);
			}
		}

		reverse = built;
		reverses.set(graph, built);
	}

	const origin = new Map<string, string>();
	const queue: string[] = [];

	for (const target of targets) {
		origin.set(target, target);
		queue.push(target);
	}

	// (The queue grows as it's walked: a for-of sees what's pushed.)
	for (const id of queue) {
		for (const from of reverse.get(id) ?? []) {
			if (!origin.has(from)) {
				origin.set(from, origin.get(id)!);
				queue.push(from);
			}
		}
	}

	return origin;
}

/** The declarations that changed from one program to the next: new, or with a different fingerprint — but not one
 *  that only moved (its name and code were somewhere in the program before). */
export function changedDeclarations(before: DeclarationGraph, after: DeclarationGraph): string[] {
	const existed = new Set<string>();

	for (const [id, fingerprint] of before.fingerprints) {
		existed.add(id.slice(id.lastIndexOf("#") + 1) + "\u0000" + fingerprint);
	}

	return [...after.fingerprints].filter(([id, fingerprint]) => before.fingerprints.get(id) !== fingerprint && !existed.has(id.slice(id.lastIndexOf("#") + 1) + "\u0000" + fingerprint)).map(([id]) => id);
}
