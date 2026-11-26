/**
 * silo — git's objects, for reading the program at a commit (Node): blobs read through one long-lived
 * `git cat-file --batch`, so reading a tree of thousands of files starts one process, not one per file.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { spawn } from "node:child_process";

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
