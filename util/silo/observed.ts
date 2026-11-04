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
		assert.equal(observedText({ "tests": [], "limit": 1, "few": [] }).split("\n")[0], "Each test against the features its file declares, by the statements at most 1 tests ran.");
	})();
}
