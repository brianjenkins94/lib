import type { Abortable } from "node:events";
import type { OpenMode } from "node:fs";
import type { FileFinder } from "@brianjenkins94/util/find";
import type { Ignore } from "ignore";
import * as fs from "node:fs";
import * as path from "node:path";

export { createReadStream, createWriteStream, existsSync, writeFileSync } from "node:fs";
export { appendFile, copyFile, cp, glob, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
// The OS temp directory (where mkdtemp-based scratch dirs go) — colocated here so a consumer needing a
// temp file reaches for one fs facade rather than mixing in node:os.
export { tmpdir } from "node:os";

// utf8 is the default, so naming it is redundant (and rejected); any OTHER text encoding is allowed, and
// `{ "encoding": null }` asks for the raw bytes — the one case where the return type is a Buffer.
type TextEncoding = Exclude<BufferEncoding, "utf8">;

interface ReadFileOptions {
	"flag"?: OpenMode | undefined;
}

export function readFile(path, options: ReadFileOptions & { "encoding": null } & Abortable): Promise<Buffer>;
export function readFile(path, options?: ReadFileOptions & { "encoding"?: TextEncoding } & Abortable): Promise<string>;
export function readFile(path, options: ReadFileOptions & { "encoding"?: TextEncoding | null } & Abortable = {}): Promise<string | Buffer> {
	return fs.promises.readFile(path, { "encoding": "utf8", ...options });
}

interface ReadFileSyncOptions {
	"flag"?: string | undefined;
}

export function readFileSync(path, options: ReadFileSyncOptions & { "encoding": null }): Buffer;
export function readFileSync(path, options?: ReadFileSyncOptions & { "encoding"?: TextEncoding }): string;
export function readFileSync(path, options: ReadFileSyncOptions & { "encoding"?: TextEncoding | null } = {}): string | Buffer {
	return fs.readFileSync(path, { "encoding": "utf8", ...options });
}

/** A directory match for `closest`/`parents`: a string is taken as the path to return; `true` returns the
 *  directory itself; falsy means "no match here, keep walking up". */
type ClosestTarget = string | ((directory: string) => string | boolean | undefined | null);

function matchDirectory(directory: string, target: ClosestTarget): string | undefined {
	if (typeof target === "function") {
		const hit = target(directory);

		return typeof hit === "string" ? hit : hit ? directory : undefined;
	}

	const candidate = path.join(directory, target);

	return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * The filesystem analogue of jQuery / DOM `Element.closest()`: walk parent directories from `start`
 * upward and return the FIRST match (or `undefined`). `target` is a filename to look for in each
 * directory, or a predicate (return a path to yield it, `true` to yield the directory). `until` bounds
 * the climb (inclusive); otherwise it stops at the filesystem root. Like `.closest()`, `start` itself is
 * eligible — e.g. `closest(dir, "package.json")`.
 */
export function closest(start: string, target: ClosestTarget, options: { "until"?: string } = {}): string | undefined {
	const until = options.until === undefined ? undefined : path.resolve(options.until);

	for (let directory = path.resolve(start); ; directory = path.dirname(directory)) {
		const hit = matchDirectory(directory, target);

		if (hit !== undefined) {
			return hit;
		}

		if (directory === until || directory === path.dirname(directory)) {
			return undefined;
		}
	}
}

/** Like `closest`, but collects EVERY match up the tree (nearest first) — the analogue of jQuery
 *  `.parents()` (except, like `.closest()`, `start` itself is included). */
export function parents(start: string, target: ClosestTarget, options: { "until"?: string } = {}): string[] {
	const until = options.until === undefined ? undefined : path.resolve(options.until);
	const matches: string[] = [];

	for (let directory = path.resolve(start); ; directory = path.dirname(directory)) {
		const hit = matchDirectory(directory, target);

		if (hit !== undefined) {
			matches.push(hit);
		}

		if (directory === until || directory === path.dirname(directory)) {
			return matches;
		}
	}
}

export interface Workspace {
	/** Workspace directory, relative to `cwd`, POSIX-separated (`packages/tsval`); never the repo root itself. */
	"dir": string;
	/** The package's `name`, or `undefined` if the manifest is unnamed/unreadable. */
	"name"?: string;
	/** `package.json` `private: true` — gates PUBLISHING only (util-publish skips it); install/build/audit
	 *  still process private workspaces (a private, deployable app still needs installing and building). */
	"private": boolean;
}

// findWorkspaces' deps, loaded once on first use (import() caches the module; `??=` memoises the unwrap).
// `find` is dynamic to avoid a static cycle (find imports this module); `ignore` is an on-demand peer dep (as
// object-scan is in find). Each is assigned right before it's used below, so TS keeps it narrowed (it drops an
// outer let's narrowing across an await).
let find: ((root: string) => FileFinder) | undefined;
let ignore: (() => Ignore) | undefined;

/**
 * Discover the repo's workspace packages: `package.json` files one or two directories deep, found by WALKING
 * the working tree (via `find`) rather than `git ls-files`. Reading the real filesystem means only workspaces
 * that actually EXIST are returned — a tracked-but-absent manifest (a staged-but-uncommitted deletion, a
 * sparse/partial checkout, a `skip-worktree` file) can never surface as a phantom workspace whose dir a
 * consumer would `cd` into (postinstall) — and there's no `git` dependency, so it works in a tarball or a
 * checkout without git. Gitignore-awareness is KEPT (build output like `dist/`/`docs/` and `node_modules` are
 * pruned) by honouring the repo's own root `.gitignore` in the prune predicate — no hardcoded ignore list;
 * `.git` (the VCS dir, never a workspace) is the one fixed special case. The two-level depth cap matches the
 * historical one- and two-level `package.json` globs (lift it only when a deeper layout exists) and excludes
 * the repo-root manifest, as those globs did. Each manifest is read to surface `name`/`private` so the one
 * consumer that needs it (publish) can filter on `private` from one place; a manifest that fails to PARSE is
 * kept as nameless/non-private (a real package with malformed JSON). Returns in lexical dir order.
 */
export async function findWorkspaces(cwd: string = process.cwd()): Promise<Workspace[]> {
	// The prune list is the repo's own .gitignore, so it tracks whatever the repo already ignores.
	ignore ??= (await import("ignore")).default;

	const ignorer = ignore();

	try {
		ignorer.add(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"));
	} catch { /* no root .gitignore → nothing extra to prune */ }

	find ??= (await import("@brianjenkins94/util/find")).find;

	// A manifest one dir deep sits at find-depth 2 (`foo/package.json`), two dirs deep at depth 3
	// (`packages/tsval/package.json`); maxDepth 3 descends far enough to reach the latter and no further.
	const manifests = await find(cwd)
		.name("package.json")
		.type("f")
		.maxDepth(3)
		.prune(function(container) {
			const relative = path.relative(cwd, container).split(path.sep).join("/");

			return path.basename(container) === ".git" || (relative !== "" && ignorer.ignores(relative));
		})
		.exec();

	return manifests.flatMap(function(manifest) {
		// POSIX-separated so consumers stay consistent on Windows, as git's output was — release globs
		// (`packages/*`) and build's `dir.split("/")` depend on it.
		const dir = path.relative(cwd, path.dirname(manifest)).split(path.sep).join("/");

		if (dir === "") {
			return []; // the repo-root manifest is not a workspace (those one-/two-level globs never matched it)
		}

		let packageJson: { "name"?: string; "private"?: boolean } = {};

		try {
			packageJson = JSON.parse(fs.readFileSync(manifest, "utf8"));
		} catch { /* present but invalid JSON → nameless, non-private */ }

		return [{ "dir": dir, "name": packageJson["name"], "private": packageJson["private"] === true }];
	}).sort((left, right) => left.dir.localeCompare(right.dir));
}
