/**
 * silo — the run ledger's Node side. The ledger is `./evidence`'s: one envelope per run, in
 * `.silo/runs/<user>.jsonl` when it's shared (committed — the same files the editor writes) or
 * `.silo/local/runs/<user>.jsonl` when it stays on this machine (`RunScope`). This reads and appends them from a Node
 * process (a command line, an MCP server) and says what such a process runs on and who runs it. How far to trust what
 * an entry does is `./evidence`'s `confidence`, over the envelopes read here. (What a person allows always is a rule in
 * their policy — `.silo/policy/<user>.json`, ./policy — and what they answer at a call is recorded in the run.)
 */

import type { Environment, RunEnvelope } from "./evidence.js";
import type { RunScope } from "./layout.js";
import type { SiloPaths } from "./paths.js";

import * as os from "node:os";
import * as path from "node:path";

import { isEntry } from "@brianjenkins94/util/env";
import * as fs from "@brianjenkins94/util/fs";

import { envelopeLine, parseRuns, userSlug } from "./evidence.js";
import { runsPath } from "./layout.js";
import { ensureSiloDir, siloPaths } from "./paths.js";

/** Every run in the ledger this machine has: every user's shared runs, and the runs kept local here. */
export function loadRuns(paths: SiloPaths): RunEnvelope[] {
	return [paths.runs, paths.localRuns].filter((folder) => fs.existsSync(folder)).flatMap((folder) => fs.readdirSync(folder).filter((name) => name.endsWith(".jsonl")).flatMap((name) => parseRuns(fs.readFileSync(path.join(folder, name)))));
}

/** Append one run's envelope to its user's file, shared or kept local (creating `.silo/` if needed). */
export async function appendRun(paths: SiloPaths, envelope: RunEnvelope, scope: RunScope = "shared"): Promise<void> {
	await ensureSiloDir(paths);
	await fs.mkdir(scope === "local" ? paths.localRuns : paths.runs, { "recursive": true });
	await fs.appendFile(path.join(paths.root, runsPath(envelope.user, scope)), envelopeLine(envelope));
}

/** What this Node process runs on: Node's major version, the OS family, its cores and memory, and the machine's name
 *  (`SILO_MACHINE`, else `default` — a name its user chose, never a fingerprint). */
export function nodeEnvironment(): Environment {
	const family: Record<string, string> = { "darwin": "macos", "win32": "windows", "linux": "linux", "android": "android" };

	return {
		"runtime": "node",
		"engine": "node-" + process.versions.node.split(".")[0],
		"os": family[process.platform] ?? "unknown",
		"cores": os.availableParallelism(),
		"memoryGb": Math.round(os.totalmem() / 2 ** 30),
		"name": process.env["SILO_MACHINE"] ?? "default"
	};
}

/** Who runs things in `root`, as git knows them (`userSlug`): the repo's own config first, then the user's global one. */
export function gitUser(root: string): string | undefined {
	const repo = fs.closest(root, (directory) => fs.existsSync(path.join(directory, ".git")));
	const configs = [repo === undefined ? undefined : path.join(repo, ".git", "config"), path.join(os.homedir(), ".gitconfig")];

	for (const config of configs) {
		try {
			const user = config === undefined ? undefined : userSlug(fs.readFileSync(config));

			if (user !== undefined) {
				return user;
			}
		} catch { /* no such config */ }
	}

	return undefined;
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

		const root = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-runs-"));
		const paths = siloPaths(root);
		const run = (id: string, user: string): RunEnvelope => ({ "type": "run", "id": id, "title": "fetch_page", "entry": "tool:fetch_page", "cwd": "", "startedAt": "2026-10-12T00:00:00.000Z", "endedAt": "2026-10-12T00:00:01.000Z", "exit": 0, "user": user, "environment": nodeEnvironment(), "files": { "tool:fetch_page": "abc123" } });

		try {
			// Nothing yet: no ledger.
			assert.deepEqual(loadRuns(paths), []);

			// Each user's shared runs go to their own file (collaborators never write the same one); reading takes every user's.
			await appendRun(paths, run("a", "ada"));
			await appendRun(paths, run("b", "ada"));
			await appendRun(paths, run("c", "grace"));
			assert.deepEqual(fs.readdirSync(paths.runs).toSorted(), ["ada.jsonl", "grace.jsonl"]);

			// A run kept local goes under local/ — out of git, so no collaborator sees it — and this machine still reads it.
			await appendRun(paths, run("d", "ada"), "local");
			assert.deepEqual(fs.readdirSync(paths.localRuns), ["ada.jsonl"]);
			assert.deepEqual(loadRuns(paths).map((each) => each.id).toSorted(), ["a", "b", "c", "d"]);
			assert.deepEqual(loadRuns({ ...paths, "localRuns": path.join(root, "elsewhere") }).map((each) => each.id).toSorted(), ["a", "b", "c"], "a collaborator's clone has only the shared runs");

			// `.silo/` is seeded as the editor seeds it: `/local/` ignored, JSONL merged by line.
			assert.ok(fs.readFileSync(path.join(paths.siloDir, ".gitignore")).split("\n").includes("/local/"));
			assert.equal(fs.readFileSync(path.join(paths.siloDir, ".gitattributes")), "*.jsonl merge=union\n");

			// A Node process's environment: its class, never a fingerprint.
			const environment = nodeEnvironment();

			assert.equal(environment.runtime, "node");
			assert.match(environment.engine, /^node-\d+$/u);
			assert.equal(environment.name, process.env["SILO_MACHINE"] ?? "default");

			// Who runs things: the repo's own git config first.
			await fs.mkdir(path.join(root, ".git"), { "recursive": true });
			fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n\tbare = false\n[user]\n\tname = Ada Lovelace\n\temail = ada.l@example.com\n");
			assert.equal(gitUser(root), "ada.l");
		} finally {
			await fs.rm(root, { "recursive": true, "force": true });
		}
	})();
}
