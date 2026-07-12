import type { Abortable } from "node:events";
import type { OpenMode } from "node:fs";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export { createReadStream, createWriteStream, existsSync, writeFileSync } from "node:fs";
export { appendFile, copyFile, cp, glob, mkdir, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";

interface ReadFileOptions {
	"encoding"?: BufferEncoding;
	"flag"?: OpenMode | undefined;
}

export function readFile(path, options: Omit<ReadFileOptions, "encoding"> & { "encoding"?: Exclude<BufferEncoding, "utf8" | "utf-8"> } & Abortable = {}) {
	return fs.promises.readFile(path, { "encoding": "utf8", ...options });
}

interface ReadFileSyncOptions {
	"encoding"?: BufferEncoding;
	"flag"?: string | undefined;
}

export function readFileSync(path, options: Omit<ReadFileSyncOptions, "encoding"> & { "encoding"?: Exclude<BufferEncoding, "utf8" | "utf-8"> } = {}) {
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
	/** Workspace directory, relative to `cwd` (POSIX, as git reports it). The repo root is `.`. */
	"dir": string;
	/** The package's `name`, or `undefined` if the manifest is unnamed/unreadable. */
	"name"?: string;
	/** `package.json` `private: true` — silo ignores private workspaces everywhere (build/install/audit). */
	"private": boolean;
}

/**
 * Discover the repo's workspace packages: git-tracked `package.json` files one or two directories deep.
 * Going through git keeps it gitignore-aware for free (build output and `node_modules` never appear), and
 * reading each manifest surfaces `name`/`private` so every consumer (build, postinstall, publish, audit)
 * can filter on `private` from one place instead of re-deriving it. The 1–2 level depth cap matches the
 * historical glob — lift it only when a deeper layout actually exists. Returns in git's order
 * (shallowest/lexical first).
 */
export function findWorkspaces(cwd: string = process.cwd()): Promise<Workspace[]> {
	return new Promise(function(resolve, reject) {
		const gitLs = spawn("git", ["ls-files", "*/package.json", "*/*/package.json"], { "cwd": cwd });

		const chunks: Buffer[] = [];

		gitLs.stdout.on("data", (chunk) => chunks.push(chunk));
		gitLs.on("error", reject);
		gitLs.on("close", function() {
			const manifests = Buffer.concat(chunks).toString().trim().split("\n").filter(Boolean);

			resolve(manifests.map(function(manifest) {
				let packageJson: { "name"?: string; "private"?: boolean } = {};

				try {
					packageJson = JSON.parse(fs.readFileSync(path.join(cwd, manifest), "utf8"));
				} catch { /* unreadable/invalid manifest → nameless, non-private */ }

				return { "dir": path.dirname(manifest), "name": packageJson["name"], "private": packageJson["private"] === true };
			}));
		});
	});
}
