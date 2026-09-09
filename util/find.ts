import * as path from "node:path";

import { mapAsync } from "@brianjenkins94/util/array";
import * as fs from "@brianjenkins94/util/fs";

/** One object-tree hit. `parent`/`key` are there so a caller can edit in place (`delete match.parent[match.key]`). */
export interface Match {
	/** JSON pointer (RFC 6901) from the root: `""` for the root itself, `"/paths/~1jobs/get"` below it. */
	"path": string;
	"key": string;
	"value": unknown;
	"parent": Record<string, unknown> | unknown[] | undefined;
}

/** RFC 6901: `~` → `~0` before `/` → `~1`. */
export function escapePointer(key: string): string {
	return key.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

/** RFC 6901: `~1` → `/` before `~0` → `~`. */
export function unescapePointer(token: string): string {
	return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

interface Criteria {
	"name"?: string;
	"type"?: "f" | "d";
	"maxDepth"?: number;
	"prune"?: (container: string) => boolean;
}

/**
 * The flags find(1) has, as a builder — the same four on a directory or an object tree. Terminal is `exec()`.
 *  - `name`: `-name`, a glob matched against the basename (files) or the key (objects): `"*.http"`, `"$ref"`.
 *  - `type`: `-type f`/`-type d`: files vs directories, or leaves (primitives) vs containers. With a `name` glob that
 *    carries an extension, `type("f")` is redundant (a directory named `x.ts` is the only thing it would exclude).
 *  - `maxDepth`: `-maxdepth`: 0 is the root itself, 1 its entries, …
 *  - `prune`: `-prune`: true for a container (directory path or JSON pointer) stops descent into it — the
 *    container itself is still a candidate, as with find.
 */
abstract class Finder<Item> {
	protected readonly criteria: Criteria = {};

	public name(glob: string): this {
		this.criteria.name = glob;

		return this;
	}

	public type(kind: "f" | "d"): this {
		this.criteria.type = kind;

		return this;
	}

	public maxDepth(depth: number): this {
		this.criteria.maxDepth = depth;

		return this;
	}

	public prune(predicate: (container: string) => boolean): this {
		this.criteria.prune = predicate;

		return this;
	}

	/**
	 * Run the search. Bare, it resolves the matches; given a callback it maps that over them like `mapAsync`
	 * (`concurrency` caps how many run at once) and resolves the callback's results — the "find … -exec" half,
	 * for the usual next step of reading, hashing, or copying each hit.
	 */
	public exec(): Promise<Item[]>;
	public exec<Mapped>(callback: (item: Item, index: number, items: Item[]) => Mapped | Promise<Mapped>, options?: { "concurrency"?: number }): Promise<Mapped[]>;
	public async exec<Mapped>(callback?: (item: Item, index: number, items: Item[]) => Mapped | Promise<Mapped>, options: { "concurrency"?: number } = {}): Promise<Item[] | Mapped[]> {
		const items = await Array.fromAsync(this);

		return callback === undefined ? items : mapAsync(items, callback, options);
	}

	/** Stream the matches instead of collecting them: `for await (const hit of find(root).name("*.log"))`. On the
	 *  filesystem the walk is lazy, so a `break` stops it early (find's `-quit`); an object walk yields what
	 *  object-scan already collected. */
	public [Symbol.asyncIterator](): AsyncIterator<Item> {
		return this.iterate();
	}

	protected abstract iterate(): AsyncGenerator<Item>;

	protected matchesType(isContainer: boolean): boolean {
		return this.criteria.type === undefined || (this.criteria.type === "d") === isContainer;
	}

	protected matchesName(candidate: string): boolean {
		return this.criteria.name === undefined || path.matchesGlob(candidate, this.criteria.name);
	}

	protected mayDescend(container: string, depth: number): boolean {
		return (this.criteria.maxDepth === undefined || depth < this.criteria.maxDepth) && !(this.criteria.prune?.(container) ?? false);
	}
}

/**
 * find over a directory. Paths come back the way find prints them — joined onto `root` exactly as given, so an
 * absolute root yields absolute paths and a relative one relative — in pre-order, each directory's entries
 * sorted so a run is deterministic without `| sort`. The root itself is a candidate (find lists it too);
 * symlinks are not followed. `fs.glob` covers "give me these files"; this is for "walk this tree with a
 * predicate" — `-type d`, `-maxdepth 1`, "don't descend into that" — which a pattern contorts.
 */
export class FileFinder extends Finder<string> {
	private readonly root: string;

	public constructor(root: string) {
		super();
		this.root = root;
	}

	protected async *iterate(): AsyncGenerator<string> {
		const rootIsDirectory = (await fs.stat(this.root)).isDirectory();

		if (this.matchesType(rootIsDirectory) && this.matchesName(path.basename(this.root))) {
			yield this.root;
		}

		if (rootIsDirectory && this.mayDescend(this.root, 0)) {
			yield* this.descend(this.root, 1);
		}
	}

	private async *descend(directory: string, depth: number): AsyncGenerator<string> {
		const entries = await fs.readdir(directory, { "withFileTypes": true });

		entries.sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of entries) {
			const candidate = path.join(directory, entry.name);
			const isDirectory = entry.isDirectory();

			if (this.matchesType(isDirectory) && this.matchesName(entry.name)) {
				yield candidate;
			}

			if (isDirectory && this.mayDescend(candidate, depth)) {
				yield* this.descend(candidate, depth + 1);
			}
		}
	}
}

/** A find-style glob (`*`, `?` wildcards) as an object-scan key selector: everything else object-scan
 *  treats as syntax is escaped, so `*.http` matches the key `a.http` and `$ref` matches literally. */
function globToNeedle(glob: string): string {
	return glob.replace(/[[\]{}(),.!+\\]/gu, "\\$&");
}

const pointerOf = (key: (string | number)[]): string => key.map((segment) => "/" + escapePointer(String(segment))).join("");

/**
 * find over an object tree, as a human-friendly face on object-scan (a util peer; imported lazily, like
 * redact does). The four flags compile to one needle plus callbacks; `needle()` bypasses that and hands
 * object-scan's own selectors straight through (`paths.*.get`, `**(^x-)`, `!**.internal`) when the flags
 * can't say it — see object-scan's README for the syntax. Results are `Match`es in document order, children
 * before their container (object-scan's traversal); the root is included (path `""`) unless a name or a
 * needle narrows the search. `name` globs the KEY, so `*` won't cross a `/` inside a key like `/taxonomy/jobs`.
 */
export class NodeFinder extends Finder<Match> {
	private readonly root: object;
	private readonly needles: string[] = [];

	public constructor(root: object) {
		super();
		this.root = root;
	}

	/** object-scan selectors, verbatim; replaces the `name`-derived needle. */
	public needle(...needles: string[]): this {
		this.needles.push(...needles);

		return this;
	}

	protected async *iterate(): AsyncGenerator<Match> {
		const { "default": objectScan } = await import(/*! @external */ "object-scan");
		const { name, maxDepth, prune } = this.criteria;
		const needles = this.needles.length > 0 ? this.needles : [name === undefined ? "**" : `**.${globToNeedle(name)}`];

		// object-scan never reports the root; find does, so add it under the same criteria (no key to glob).
		if (this.needles.length === 0 && name === undefined && this.matchesType(true)) {
			yield { "path": "", "key": "", "value": this.root, "parent": undefined };
		}

		if (!this.mayDescend("", 0)) {
			return;
		}

		// `isCircular` stops a cycle (structuredClone preserves them) — the same guard redact.ts uses.
		yield* objectScan(needles, {
			"reverse": false,
			"breakFn": ({ key, depth, isCircular }) => isCircular || (maxDepth !== undefined && depth >= maxDepth) || (prune?.(pointerOf(key)) ?? false),
			"filterFn": ({ isLeaf }) => this.matchesType(!isLeaf),
			"rtn": ({ key, value, property, parent }) => ({ "path": pointerOf(key), "key": String(property), "value": value, "parent": parent })
		})(this.root) as Match[];
	}
}

export function find(root: string): FileFinder;
export function find(root: object): NodeFinder;
export function find(root: string | object): FileFinder | NodeFinder {
	return typeof root === "string" ? new FileFinder(root) : new NodeFinder(root);
}
