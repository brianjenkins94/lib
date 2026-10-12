/**
 * silo — a git history as snapshots for `./history` (Node). A commit's tree is listed with `git ls-tree`; blobs are
 * read through one long-lived `git cat-file --batch`, so replaying hundreds of commits starts one process per commit,
 * not one per file. Commit messages are never read.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { Snapshot } from "./history";
import { execFileSync, spawn } from "node:child_process";

export interface GitSnapshotsOptions {
	/** What to walk back from (default `HEAD`). */
	"ref"?: string;
	/** Follow only first parents — the branch's own line, a merge counted once (default true). */
	"firstParent"?: boolean;
	/** Only commits at or after this date (anything `git log --since` takes), after the last commit before it as the
	 *  baseline they're compared with. */
	"since"?: string;
	/** Only commits at or before this date (anything `git log --until` takes). */
	"until"?: string;
}

/** Objects read over one `git cat-file --batch`. */
export interface GitObjects {
	"read": (oid: string) => Promise<string>;
	"close": () => void;
}

export function gitObjects(repo: string): GitObjects {
	const cat: ChildProcessWithoutNullStreams = spawn("git", ["cat-file", "--batch"], { "cwd": repo });
	const waiting: ((body: string) => void)[] = [];
	let buffered = Buffer.alloc(0);

	cat.stdout.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);

		while (waiting.length > 0) {
			const newline = buffered.indexOf(10);

			if (newline < 0) {
				return;
			}

			const header = buffered.subarray(0, newline).toString().split(" ");

			if (header[1] === "missing") {
				buffered = buffered.subarray(newline + 1);
				waiting.shift()("");
				continue;
			}

			const size = Number(header[2]);

			if (buffered.length < newline + 1 + size + 1) {
				return;
			}

			const body = buffered.subarray(newline + 1, newline + 1 + size).toString("utf8");

			buffered = buffered.subarray(newline + 1 + size + 1);
			waiting.shift()(body);
		}
	});

	return {
		"read": async (oid) => new Promise<string>((resolve) => {
			waiting.push(resolve);
			cat.stdin.write(oid + "\n");
		}),
		"close": () => {
			cat.stdin.end();
		}
	};
}

/** The commits from `ref` back, oldest first, each as a snapshot of its tree. */
export async function *gitSnapshots(repo: string, options: GitSnapshotsOptions = {}): AsyncGenerator<Snapshot> {
	const args = ["log", "--reverse", "--format=%H%x09%cI", ...options.firstParent === false ? [] : ["--first-parent"], ...options.since === undefined ? [] : ["--since=" + options.since], ...options.until === undefined ? [] : ["--until=" + options.until], options.ref ?? "HEAD"];
	const commits = execFileSync("git", args, { "cwd": repo, "encoding": "utf8", "maxBuffer": 1 << 28 }).trim().split("\n").filter(Boolean);

	// A span starts from the last commit before it, so its first commit has something to be compared with.
	if (options.since !== undefined) {
		const baseline = execFileSync("git", ["log", "-1", "--format=%H%x09%cI", ...options.firstParent === false ? [] : ["--first-parent"], "--before=" + options.since, options.ref ?? "HEAD"], { "cwd": repo, "encoding": "utf8" }).trim();

		if (baseline !== "") {
			commits.unshift(baseline);
		}
	}

	for (const line of commits) {
		const [id, date] = line.split("\t") as [string, string];
		const tree = execFileSync("git", ["ls-tree", "-r", id], { "cwd": repo, "encoding": "utf8", "maxBuffer": 1 << 28 });
		const files = tree.split("\n").filter(Boolean).flatMap((entry) => {
			const [meta, path] = entry.split("\t") as [string, string];
			const [, type, oid] = meta.split(" ") as [string, string, string];

			return type === "blob" ? [{ "path": path, "oid": oid }] : [];
		});

		yield { "id": id, "date": date, "files": files };
	}
}
