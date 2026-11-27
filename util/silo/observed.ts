/**
 * silo — declared against observed (pure, zero-dep): what each test ran, compared with the features its file is declared
 * for (silo README, *Declared against observed*). The ledger says whose code is whose (./ledger `ownersOf`); this says
 * where a test's reach disagrees, which is how a boundary drawn in the wrong place shows itself, and what sharing there
 * is to reassess. It says, it doesn't decide: much of what it shows is a dependency, not a mistake.
 *
 * By statement, not by file. A session loads nearly everything, so nearly every file looks shared, and what a test
 * caused is lost in what every test runs (measured on the editor's browser suites, 2026-11-03: a test's median share of
 * its own features' code was 6% by file, 40% by statement). A statement counts for a test only when few tests ran it:
 * at most RARE of them.
 */

import type { Ledger } from "./ledger";
import { isEntry } from "@brianjenkins94/util/env";
import { ownersOf } from "./ledger";

/** Of the tests, the share that may run a statement for it to say something about one of them. */
export const RARE = 0.1;
/** Below this many statements of its own, a test isn't told by a share. */
export const FEW = 20;

/** What one test ran. */
export interface TestReach {
	/** Its file, from the repository's root. */
	"file": string;
	"name": string;
	/** Each file it ran, with its statements, however they're named. */
	"reach": Record<string, unknown[]>;
}

/** One test against what its file declares. */
export interface TestObserved {
	"file": string;
	"name": string;
	/** The features whose `tests` name its file. */
	"declared": string[];
	/** The statements few tests ran, that it did. */
	"statements": number;
	/** Of those, the share in the code of the features it's declared for. */
	"share": number;
	/** Those statements by the feature that owns them, most first (`(none)`: code no feature owns). */
	"features": { "feature": string; "statements": number }[];
}

export interface Observed {
	"tests": TestObserved[];
	/** The most tests that may run a statement for it to count. */
	"limit": number;
	/** Tests with too few such statements to tell (FEW). */
	"few": { "file": string; "name": string; "statements": number }[];
}

/** What a browser suite's reach file holds (`{ [test]: { [file]: statements } }`), for its test file. */
export function parseReach(file: string, text: string): TestReach[] {
	return Object.entries(JSON.parse(text) as Record<string, Record<string, unknown[]>>).map(([name, reach]) => ({ "file": file, "name": name, "reach": reach }));
}

/** Tests by index, as runs: `3` is test 3, `[5, 9]` tests 5 to 9 (tests are sorted by file, so a file's are together). */
export type TestRuns = (number | [number, number])[];

/** What each test ran, by statement, kept in the repository (`.silo/last-run/reach.json`; the user, 2026-11-26: "time to
 *  get more granular"): its tests by file and name, and each file they ran with, for each statement any of them ran (by
 *  the line it starts on), the tests that ran it. So what no test ran is what's left of a file's statements, and which
 *  tests a line needs is there without the run. `commit`, when known, is the code they ran. */
export interface ReachRecord {
	"version": 3;
	"at": string;
	"commit"?: string;
	"tests": { "file": string; "name": string }[];
	"files": Record<string, Record<string, TestRuns>>;
}

/** The line a statement starts on, however a reach names it: `[line, column, endLine, endColumn]` (a coverage run's),
 *  `[line, endLine]` (an editor's kept reach), `[[line, column], [endLine, endColumn]]`, or `[line]`. */
export function startLine(statement: unknown): number | undefined {
	const first = Array.isArray(statement) ? statement[0] : statement;

	return typeof first === "number" ? first : Array.isArray(first) && typeof first[0] === "number" ? first[0] : undefined;
}

/** `indices`, sorted, as runs. */
function runsOf(indices: number[]): TestRuns {
	const runs: TestRuns = [];

	for (const index of [...new Set(indices)].sort((one, other) => one - other)) {
		const last = runs.at(-1);
		const end = Array.isArray(last) ? last[1] : last;

		if (end !== undefined && index === end + 1) {
			runs[runs.length - 1] = [Array.isArray(last) ? last[0] : end, index];
		} else {
			runs.push(index);
		}
	}

	return runs;
}

/** The tests in `runs`. */
export function testsIn(runs: TestRuns): number[] {
	return runs.flatMap((run) => (Array.isArray(run) ? Array.from({ "length": run[1] - run[0] + 1 }, (_, offset) => run[0] + offset) : [run]));
}

/** The record of `tests`' reach, read `at`, of the code at `commit`. */
export function reachRecord(tests: TestReach[], at: string, commit?: string): ReachRecord {
	const sorted = tests.toSorted((one, other) => one.file.localeCompare(other.file) || one.name.localeCompare(other.name));
	const files: Record<string, Map<number, number[]>> = {};

	for (const [index, test] of sorted.entries()) {
		for (const [file, statements] of Object.entries(test.reach)) {
			for (const statement of statements) {
				const line = startLine(statement);

				if (line !== undefined) {
					files[file] ??= new Map();

					const lines = files[file];

					lines.set(line, [...lines.get(line) ?? [], index]);
				}
			}
		}
	}

	return {
		"version": 3,
		"at": at,
		...commit === undefined ? {} : { "commit": commit },
		"tests": sorted.map(({ file, name }) => ({ "file": file, "name": name })),
		"files": Object.fromEntries(Object.entries(files).sort(([one], [other]) => one.localeCompare(other)).map(([file, lines]) => [file, Object.fromEntries([...lines].sort(([one], [other]) => one - other).map(([line, ran]) => [String(line), runsOf(ran)]))]))
	};
}

/** A reach record's `text` read, either version: each file's tests (by index) and, from version 3, each statement's. */
function readRecord(text: string | undefined): { "tests": { "file": string; "name": string }[]; "files": Record<string, { "tests": number[]; "lines"?: Record<string, number[]> }> } | undefined {
	let record: { "version"?: unknown; "tests"?: { "file": string; "name": string }[]; "files"?: Record<string, unknown> };

	try {
		record = JSON.parse(text ?? "") as typeof record;
	} catch {
		return undefined;
	}

	if ((record.version !== 2 && record.version !== 3) || record.tests === undefined || record.files === undefined) {
		return undefined;
	}

	return {
		"tests": record.tests,
		"files": Object.fromEntries(Object.entries(record.files).map(([file, ran]) => {
			if (record.version === 2) {
				return [file, { "tests": ran as number[] }];
			}

			const lines = Object.fromEntries(Object.entries(ran as Record<string, TestRuns>).map(([line, runs]) => [line, testsIn(runs)]));

			return [file, { "tests": [...new Set(Object.values(lines).flat())].sort((one, other) => one - other), "lines": lines }];
		}))
	};
}

/** For each file in a reach record's `text`, the lines its statements start on that some test ran, and which tests (by
 *  file and name); none from a record of version 2 (by file only), or none at all. */
export function ranByLine(text: string | undefined): Record<string, Record<number, { "file": string; "name": string }[]>> {
	const record = readRecord(text);

	return Object.fromEntries(Object.entries(record?.files ?? {}).flatMap(([file, { lines }]) => (lines === undefined ? [] : [[file, Object.fromEntries(Object.entries(lines).map(([line, ran]) => [Number(line), ran.flatMap((index) => record!.tests[index] ?? [])]))]])));
}

/** For each file in a reach record's `text`, the test files whose tests ran it (./ledger's ownership check's `ran`);
 *  none when there's no record, or it's another version. */
export function ranByFile(text: string | undefined): Record<string, string[]> {
	const record = readRecord(text);

	if (record === undefined) {
		return {};
	}

	return Object.fromEntries(Object.entries(record.files).map(([file, { tests }]) => [file, [...new Set(tests.flatMap((index) => (record.tests[index] === undefined ? [] : [record.tests[index].file])))]]));
}

/** Each test's reach against what the ledger declares, those least in their own features' code first. */
export function observedAgainstDeclared(ledger: Ledger, tests: TestReach[]): Observed {
	const statementsOf = (test: TestReach): string[] => Object.entries(test.reach).flatMap(([file, statements]) => statements.map((statement) => `${file}\0${JSON.stringify(statement)}`));
	const counts = new Map<string, number>();

	for (const test of tests) {
		for (const statement of new Set(statementsOf(test))) {
			counts.set(statement, (counts.get(statement) ?? 0) + 1);
		}
	}

	const limit = Math.max(1, Math.ceil(tests.length * RARE));
	const owners = new Map<string, string[]>();
	const ownerOf = (file: string): string[] => {
		if (!owners.has(file)) {
			owners.set(file, ownersOf(ledger, file));
		}

		return owners.get(file)!;
	};
	const told = tests.map((test): TestObserved => {
		const declared = Object.entries(ledger).filter(([, entry]) => entry.status !== "removed" && entry.status !== "stopped" && (entry.tests ?? []).some((path) => test.file === path.replace(/\/+$/u, "") || test.file.startsWith(path.replace(/\/+$/u, "") + "/"))).map(([name]) => name);
		const features = new Map<string, number>();
		let statements = 0;
		let own = 0;

		for (const statement of new Set(statementsOf(test))) {
			if (counts.get(statement)! <= limit) {
				const file = statement.slice(0, statement.indexOf("\0"));
				const whose = ownerOf(file);

				statements += 1;
				own += whose.some((name) => declared.includes(name)) ? 1 : 0;

				for (const name of whose.length === 0 ? ["(none)"] : whose) {
					features.set(name, (features.get(name) ?? 0) + 1);
				}
			}
		}

		return { "file": test.file, "name": test.name, "declared": declared, "statements": statements, "share": statements === 0 ? 0 : own / statements, "features": [...features].map(([feature, count]) => ({ "feature": feature, "statements": count })).sort((one, other) => other.statements - one.statements || one.feature.localeCompare(other.feature)) };
	});

	return {
		"tests": told.filter((test) => test.statements >= FEW).sort((one, other) => one.share - other.share || one.name.localeCompare(other.name)),
		"limit": limit,
		"few": told.filter((test) => test.statements < FEW).map(({ file, name, statements }) => ({ "file": file, "name": name, "statements": statements }))
	};
}

/** The comparison, as a table. */
export function observedText({ tests, limit, few }: Observed): string {
	const percent = (share: number): string => `${Math.round(share * 100)}%`;
	const middle = tests.map((test) => test.share).sort((one, other) => one - other)[Math.floor(tests.length / 2)];

	return [
		`Each test against the features its file declares, by the statements at most ${limit} tests ran${tests.length === 0 ? "." : ` (median ${percent(middle!)} in its own features' code):`}`,
		"",
		...tests.length === 0 ? [] : [
			"| Own | Statements | Test | Ran most of |",
			"|---|---|---|---|",
			...tests.map((test) => `| ${percent(test.share)} | ${test.statements} | ${test.file.split("/").at(-1)}: ${test.name.replaceAll("|", "\\|")} | ${test.features.slice(0, 3).map(({ feature, statements }) => `${feature} ${statements}`).join(", ").replaceAll("|", "\\|")} |`),
			""
		],
		...few.length === 0 ? [] : [`Too few of their own to tell: ${few.length}.`, ""]
	].join("\n");
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const today = "2026-11-03";
		const ledger: Ledger = {
			"Notes": { "status": "active", "why": "w", "since": today, "what": "N.", "paths": ["src/notes.ts"], "tests": ["test/notes.mjs"] },
			"Git": { "status": "active", "why": "w", "since": today, "what": "G.", "paths": ["src/git.ts"], "tests": ["test/git.mjs"] },
			"Boot": { "status": "active", "why": "w", "since": today, "what": "B.", "paths": ["src/boot.ts"] },
			"Old": { "status": "removed", "why": "w", "since": today, "paths": ["src/old.ts"], "tests": ["test/old.mjs"] }
		};
		const range = (from: number, to: number): number[][] => Array.from({ "length": to - from }, (_, index) => [from + index]);
		// What every test runs says nothing; ten tests so one in ten is rare.
		const boot = { "src/boot.ts": range(0, 50) };
		const quiet = Array.from({ "length": 7 }, (_, index): TestReach => ({ "file": "test/git.mjs", "name": `quiet ${String(index)}`, "reach": boot }));
		const tests: TestReach[] = [
			...quiet,
			// All its own.
			{ "file": "test/notes.mjs", "name": "right", "reach": { ...boot, "src/notes.ts": range(0, 30) } },
			// Declared for Git, ran Notes' and code nobody owns.
			{ "file": "test/git.mjs", "name": "wrong", "reach": { ...boot, "src/notes.ts": range(100, 120), "src/free.ts": range(0, 5), "src/git.ts": range(0, 5) } },
			// Too little of its own to say.
			{ "file": "test/git.mjs", "name": "small", "reach": { ...boot, "src/git.ts": range(50, 55) } }
		];
		const observed = observedAgainstDeclared(ledger, tests);

		assert.equal(observed.limit, 1);
		assert.deepEqual(observed.tests.map((test) => [test.name, test.declared, test.statements, test.share]), [["wrong", ["Git"], 30, 5 / 30], ["right", ["Notes"], 30, 1]]);
		assert.deepEqual(observed.tests[0]!.features, [{ "feature": "Notes", "statements": 20 }, { "feature": "(none)", "statements": 5 }, { "feature": "Git", "statements": 5 }]);
		assert.deepEqual(observed.few.map((test) => test.name), ["quiet 0", "quiet 1", "quiet 2", "quiet 3", "quiet 4", "quiet 5", "quiet 6", "small"]);

		const said = observedText(observed);

		assert.match(said, /by the statements at most 1 tests ran \(median 100% in its own features' code\):/u);
		assert.match(said, /\| 17% \| 30 \| git\.mjs: wrong \| Notes 20, \(none\) 5, Git 5 \|/u);
		assert.match(said, /Too few of their own to tell: 8\./u);
		assert.deepEqual(parseReach("test/a.mjs", JSON.stringify({ "t": { "src/a.ts": [[1, 0, 1, 2]] } })), [{ "file": "test/a.mjs", "name": "t", "reach": { "src/a.ts": [[1, 0, 1, 2]] } }]);
		assert.deepEqual(observedAgainstDeclared(ledger, []), { "tests": [], "limit": 1, "few": [] });

		// The record kept of what each test ran, by statement, and who ran each file and line, read back.
		const record = reachRecord([
			{ "file": "test/notes.mjs", "name": "b", "reach": { "src/shared.ts": [[1, 0, 1, 9], [4, 2, 6, 3]], "src/notes.ts": [[1, 3]] } },
			{ "file": "test/git.mjs", "name": "a", "reach": { "src/shared.ts": [[[1, 0], [1, 9]], [[2, 0], [2, 4]]], "src/git.ts": [] } },
			{ "file": "test/git.mjs", "name": "c", "reach": { "src/shared.ts": [[1]] } }
		], today, "0123abc");

		assert.deepEqual(record, { "version": 3, "at": today, "commit": "0123abc", "tests": [{ "file": "test/git.mjs", "name": "a" }, { "file": "test/git.mjs", "name": "c" }, { "file": "test/notes.mjs", "name": "b" }], "files": { "src/notes.ts": { "1": [2] }, "src/shared.ts": { "1": [[0, 2]], "2": [0], "4": [2] } } });
		assert.deepEqual(ranByFile(JSON.stringify(record)), { "src/notes.ts": ["test/notes.mjs"], "src/shared.ts": ["test/git.mjs", "test/notes.mjs"] });
		assert.deepEqual(ranByLine(JSON.stringify(record))["src/shared.ts"], { "1": [{ "file": "test/git.mjs", "name": "a" }, { "file": "test/git.mjs", "name": "c" }, { "file": "test/notes.mjs", "name": "b" }], "2": [{ "file": "test/git.mjs", "name": "a" }], "4": [{ "file": "test/notes.mjs", "name": "b" }] });
		assert.deepEqual(testsIn([0, [2, 4], 7]), [0, 2, 3, 4, 7]);
		assert.deepEqual(ranByFile(JSON.stringify({ "version": 2, "at": today, "tests": [{ "file": "test/a.mjs", "name": "t" }], "files": { "src/a.ts": [0] } })), { "src/a.ts": ["test/a.mjs"] }, "a record of version 2 still reads, by file");
		assert.deepEqual(ranByLine(JSON.stringify({ "version": 2, "at": today, "tests": [], "files": { "src/a.ts": [] } })), {}, "and has no lines");
		assert.deepEqual(ranByFile(JSON.stringify({ "version": 1, "tests": [], "reach": {} })), {});
		assert.deepEqual(ranByFile(undefined), {});
		assert.equal(observedText({ "tests": [], "limit": 1, "few": [] }).split("\n")[0], "Each test against the features its file declares, by the statements at most 1 tests ran.");
	})();
}
