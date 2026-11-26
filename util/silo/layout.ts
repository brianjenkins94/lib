/**
 * silo — the `.silo/` layout (pure, zero-dep): every file silo keeps, where it goes, and whether it's shared. One place
 * for all of it, so every writer (the editor, the command line, an MCP server) agrees.
 *
 *   .silo/
 *     .gitignore                          `/local/` — what stays on this machine
 *     .gitattributes                      `*.jsonl merge=union` — line files merge by keeping both sides
 *     policy.json                         SHARED · the contract: rules people wrote and review
 *     policy/<user>.json                  SHARED · one person's rules, layered over the contract
 *     runs/<user>.jsonl                   SHARED · one person's runs, an envelope a line (./evidence)
 *     vouches/<user>.jsonl                SHARED · one person's test passes, for CI's choice of tests (./select)
 *     evidence/<user>/<env>/<file>.jsonl  SHARED · what one person's runs observed of a file (./evidence)
 *     <collection>/<user>/<file>.jsonl    SHARED · one person's annotations of a file: notes, … (./annotations)
 *     baseline.json                       SHARED · the dependency-capability baseline (derived, regenerated: ./audit)
 *     features.json                       SHARED · the feature ledger: what's been decided about features (./ledger)
 *     versions.json                       SHARED · the exact version each dependency loads at, when no lockfile says
 *                                                  (the editor's: each range resolved a week old, kept until it changes)
 *     last-run/reach.json                 SHARED · what each test ran, by file, as the last coverage read had it
 *                                                  (./observed)
 *     local/                              LOCAL  · this machine's alone, never committed:
 *       runs/<user>.jsonl                   runs too frequent or personal to share (an MCP server's tool calls)
 *       samples/<file>.jsonl                value samples (a real value can hold secrets)
 *       traces/<file>.jsonl                 every run of a file kept here: its values as they were, the text it ran
 *                                             (never shared: a value can hold anything a run read — ./traces)
 *       …                                   caches and raw detail (CPU profiles, recorded results, parse caches)
 *
 * Designed for collaborators. Anything a person writes goes in a file only they write, named for them (`<kind>/<user>`),
 * so two people never edit the same file and a merge never conflicts; line files (`.jsonl`) also merge by line across
 * one person's branches. The few files everyone shares — the contract, the derived surfaces — are written sorted, one
 * entry a line, so unrelated changes touch different lines. Whatever is frequent, private (a recorded response can hold
 * secrets) or this machine's own goes under `local/`, which is the only thing `.gitignore` names.
 *
 * Paths here are repo-relative, with `/`; a Node caller joins them to its root (./paths).
 *
 * Each file says what version of its shape it is, where a meaning can change (`VERSIONS`): a line file on each line, a
 * whole file once. A version changes only when a reader of the old one would misread the new; a new field or kind
 * doesn't change it. A reader skips a line of a version it doesn't know and refuses a whole file of one (it would
 * otherwise write over what it can't read), and a writer keeps the lines, kinds and fields it doesn't know.
 */

import { isEntry } from "@brianjenkins94/util/env";

/** silo's folder, at the repo root. */
export const SILO_DIR = ".silo";

/** What stays on this machine. */
export const LOCAL_DIR = `${SILO_DIR}/local`;

/** What `.silo/.gitignore` says: `/local/` stays on this machine; everything else goes in git. Anchored: a bare `local/`
 *  would also ignore any folder named `local` deeper down — `evidence/local/`, the evidence of a user named `local`. */
export const GITIGNORE = "/local/\n";

/** Lines silo seeded once and no longer means, taken out when it seeds: the unanchored `local/`. */
const RETIRED = new Set(["local/"]);

/** What `.silo/.gitattributes` says: line files merge line by line, keeping both sides. */
export const GITATTRIBUTES = "*.jsonl merge=union\n";

/** A safe file-name part: lowercase letters, digits, `.`, `_`, `-`. Undefined for nothing usable. */
export function slug(value: string): string | undefined {
	const result = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");

	return result === "" ? undefined : result;
}

/** A user as a file name: their slug, or `local` when there's none. */
const userFile = (user: string): string => slug(user) ?? "local";

/** `existing` with each of `wanted`'s lines it lacks added at the end, and any line silo retired taken out, or undefined
 *  when there's nothing to change. For seeding `.gitignore` and `.gitattributes` without dropping what a person added. */
export function withLines(existing: string, wanted: string): string | undefined {
	const lines = existing.split(/\r?\n/u);
	const kept = lines.filter((line) => !RETIRED.has(line.trim()));
	const have = new Set(kept.map((line) => line.trim()));
	const missing = wanted.split("\n").filter((line) => line !== "" && !have.has(line));

	if (missing.length === 0 && kept.length === lines.length) {
		return undefined;
	}

	const text = kept.join("\n");

	return (text === "" || text.endsWith("\n") ? text : text + "\n") + missing.map((line) => line + "\n").join("");
}

/** The contract: the rules people wrote and review. */
export const policyPath = (): string => `${SILO_DIR}/policy.json`;

/** One person's rules, layered over the contract. */
export const userPolicyPath = (user: string): string => `${SILO_DIR}/policy/${userFile(user)}.json`;

/** Every policy file — the contract and each person's — as a workspace glob, for a file watcher. */
export const POLICY_GLOB = `**/${SILO_DIR}/{policy.json,policy/*.json}`;

/** The exact version each dependency loads at, where no lockfile says — the editor's resolver: each range resolved to
 *  the newest version at least a week old, and kept until the range changes (a lockfile's way: shared, so every
 *  collaborator loads what the baseline was made from). */
export const versionsPath = (): string => `${SILO_DIR}/versions.json`;

/**
 * Who a run is evidence for. `shared` runs are committed — each user writes only their own file, and `*.jsonl
 * merge=union` keeps everyone's lines across branches, so collaborators never conflict — and they're the runs a
 * teammate sees. `local` runs stay on this machine (under `local/`): what's too frequent or too personal to put in
 * everyone's history, such as every call an MCP server's tools take.
 */
export type RunScope = "shared" | "local";

/** Where `user`'s vouches go (./select): committed, a file a person, merged by line as runs are. */
export const vouchesPath = (user: string): string => `${SILO_DIR}/vouches/${userFile(user)}.jsonl`;

/** Where everyone's vouches are. */
export const VOUCHES_DIR = `${SILO_DIR}/vouches`;

/** Where `user`'s run envelopes go: shared runs in `runs/`, local ones in `local/runs/`. */
export function runsPath(user: string, scope: RunScope = "shared"): string {
	return `${scope === "local" ? LOCAL_DIR : SILO_DIR}/runs/${userFile(user)}.jsonl`;
}

/** Where `user`'s runs in an environment (`environmentKey`, ./evidence) keep what they observed of `file`. */
export const evidencePathFor = (user: string, environmentKey: string, file: string): string => `${SILO_DIR}/evidence/${userFile(user)}/${environmentKey}/${file}.jsonl`;

/** Where `user`'s annotations of `collection` (notes, …) on `file` go. */
export const annotationsPath = (collection: string, user: string, file: string): string => `${SILO_DIR}/${slug(collection) ?? "annotations"}/${userFile(user)}/${file}.jsonl`;

/** The dependency-capability baseline (./audit). */
export const baselinePath = (): string => `${SILO_DIR}/baseline.json`;

/** The feature ledger (./ledger): decisions about features — shared, one entry a few sorted lines. */
export const ledgerPath = (): string => `${SILO_DIR}/features.json`;

/** What each test ran, as the last coverage read had it (./observed `reachRecord`): shared, so a check can hold the
 *  ledger to real coverage. */
export const lastRunReachPath = (): string => `${SILO_DIR}/last-run/reach.json`;

/** Where this machine keeps every run of `file` it has, values and all (./traces). */
export const localTracesPath = (file: string): string => `${LOCAL_DIR}/traces/${file}.jsonl`;

/** Where this machine keeps the value samples of `file` (./evidence). */
export const samplesPath = (file: string): string => `${LOCAL_DIR}/samples/${file}.jsonl`;

/** The version of each file's shape this silo writes and reads (the header). `policy.json` and `last-run/reach.json`
 *  keep theirs as they always have (./policy, ./observed); evidence and annotations name how their spans are made
 *  (`"key": "bablr1"`) instead. A file or line written before it had one is version 1. */
export const VERSIONS = { "features": 1, "baseline": 1, "runs": 1, "vouches": 1 } as const;

/** Whether `value` (a parsed line or file) is of `version` or none (written before versions): what a reader may read. */
export function readable(value: unknown, version: number): boolean {
	const stated = typeof value === "object" && value !== null ? (value as { "version"?: unknown }).version : undefined;

	return stated === undefined || stated === version;
}

/** An error saying `file` is of a version this silo doesn't know, for a reader of a whole file to throw: it must not
 *  read it as its own, nor write over it. */
export const unreadable = (file: string, stated: unknown, version: number): Error => new Error(`${file} is version ${String(stated)}; this silo reads version ${String(version)}. Update silo to read or write it.`);

/** A whole file's parsed value, if it's of `version` or none; else it throws (`unreadable`). */
export function checked<Value>(file: string, value: Value, version: number): Value {
	if (!readable(value, version)) {
		throw unreadable(file, (value as { "version"?: unknown }).version, version);
	}

	return value;
}

/** `value` with its `version` first, the rest as it was (a field this silo doesn't know kept): what a writer writes. */
export function versioned<Value extends object>(value: Value, version: number): Value & { "version": number } {
	return { "version": version, ...value, ...{ "version": version } };
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

		// Each person's files are their own, a folder per kind; machine-only files under local/.
		assert.equal(userPolicyPath("Ada L"), ".silo/policy/ada-l.json");
		assert.equal(vouchesPath(""), ".silo/vouches/local.jsonl", "no usable name: `local`");
		assert.equal(lastRunReachPath(), ".silo/last-run/reach.json");
		assert.equal(runsPath("ada"), ".silo/runs/ada.jsonl");
		assert.equal(versionsPath(), ".silo/versions.json");
		assert.equal(runsPath("ada", "local"), ".silo/local/runs/ada.jsonl");
		assert.equal(evidencePathFor("ada", "laptop.tsval.chromium-140.macos", "src/a.ts"), ".silo/evidence/ada/laptop.tsval.chromium-140.macos/src/a.ts.jsonl");
		assert.equal(annotationsPath("Notes", "ada", "src/a.ts"), ".silo/notes/ada/src/a.ts.jsonl");
		assert.equal(localTracesPath("src/a.ts"), ".silo/local/traces/src/a.ts.jsonl");
		assert.equal(POLICY_GLOB, "**/.silo/{policy.json,policy/*.json}");
		assert.ok(GITIGNORE.split("\n").filter(Boolean).every((line) => line === "/local/"), "/local/ is all .gitignore names");

		// Seeding keeps a person's lines and adds only what's missing.
		assert.equal(withLines("", GITIGNORE), "/local/\n");
		assert.equal(withLines("node_modules", GITIGNORE), "node_modules\n/local/\n");
		assert.equal(withLines("/local/\n*.log\n", GITIGNORE), undefined, "nothing missing: nothing to write");

		// The unanchored `local/` silo once seeded is replaced, a person's lines kept.
		assert.equal(withLines("local/\n", GITIGNORE), "/local/\n");
		assert.equal(withLines("*.log\nlocal/\n", GITIGNORE), "*.log\n/local/\n");
		assert.equal(withLines("*.jsonl merge=union\n", GITATTRIBUTES), undefined);

		// A version: none is the first; another isn't this silo's to read.
		assert.ok(readable({ "test": "a" }, 1));
		assert.ok(readable({ "version": 1 }, 1));
		assert.ok(!readable({ "version": 2 }, 1));
		assert.match(unreadable(".silo/features.json", 2, 1).message, /version 2; this silo reads version 1/u);
		assert.deepEqual(Object.keys(versioned({ "packages": {}, "version": 0, "later": true }, 1)), ["version", "packages", "later"]);
		assert.throws(() => checked(".silo/baseline.json", { "version": 2 }, 1), /baseline\.json is version 2/u);
	})();
}
