/**
 * silo — every test's outcomes, from a CI's own history (silo README, *Tests by feature, in your face*: "A test
 * ledger"). Nothing is recorded for it: a CI already keeps each run, its attempts, and each job's log for its retention
 * window, and a runner's report in that log says how each test came out. This reads that history and answers per test
 * — its last outcome, when it last failed, how often it flaked, its streak — so "green for 20 runs" and "flaky" are
 * read, not remembered. It reaches back as far as the CI keeps its logs.
 *
 * - **A runner's report, read**: `nodeTestOutcomes` reads node:test's spec reporter (what `node --test` prints), in a
 *   log or not. Another runner is another reader with the same answer.
 * - **A CI's history, fetched**: `githubRuns` reads a GitHub Actions workflow's runs, their attempts and their jobs'
 *   logs (a rerun is an attempt), through a `fetch` and a token given to it, and a cache for the logs (a finished
 *   job's log never changes). Another CI is another adapter with the same answer.
 * - **The standings**: `standings` folds runs into each test's. In one run, a test that failed on an attempt and passed
 *   on a later one flaked; one whose last attempt failed failed.
 *
 * A test is its job's name (its suite, a CI shard) and its titles, joined by ` › `.
 */

import { isEntry } from "@brianjenkins94/util/env";

/** How one test came out once. */
export interface TestOutcome {
	/** Its titles, outermost first (a suite's, then its own). */
	"titles": string[];
	"outcome": "pass" | "fail" | "skip" | "todo";
	/** How long it took, when the report says. */
	"ms"?: number;
}

/** One run of a CI's workflow: its commit, when, and each attempt's jobs, each with the tests its log reported. */
export interface CiRun {
	"id": string;
	"commit": string;
	"at": string;
	"url"?: string;
	"attempts": {
		"attempt": number;
		"jobs": { "name": string; "conclusion": string | null; "tests": TestOutcome[] }[];
	}[];
}

/** How a test came out in one run, its attempts taken together. */
export type Verdict = "pass" | "fail" | "flaky" | "skip";

/** Where a test stands, over the runs read. */
export interface TestStanding {
	/** Its job's name and its titles, joined by ` › `. */
	"id": string;
	/** The runs it was in. */
	"runs": number;
	/** Its latest run's verdict, and that run. */
	"last": { "verdict": Verdict; "run": string; "commit": string; "at": string };
	/** The latest run it failed in, on any attempt (a flake too). */
	"lastFailed"?: { "verdict": "fail" | "flaky"; "run": string; "commit": string; "at": string };
	/** The runs it flaked in. */
	"flakes": number;
	/** Its latest verdict, and how many runs in a row, latest back, had it. */
	"streak": { "verdict": Verdict; "runs": number };
	/** Its median time, over the attempts that said one. */
	"ms"?: number;
}

/** A test line of node:test's spec reporter: its indent, mark, title and time (a log's timestamp before it, if any). */
const SPEC_LINE = /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?( *)([✔✖﹣▶]) (.+?)(?: \((\d+(?:\.\d+)?)ms\))?(?: # (SKIP|TODO)\b.*)?$/u;

/** What a test line's mark says, and what a `# SKIP` / `# TODO` after it says instead. */
const MARKS: Record<string, TestOutcome["outcome"]> = { "✔": "pass", "✖": "fail", "﹣": "skip" };
const DIRECTIVES: Record<string, TestOutcome["outcome"]> = { "SKIP": "skip", "TODO": "todo" };

/** Where node:test's spec reporter starts saying the failures again, at its end. */
const RECAP = /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?✖ failing tests:$/u;

/**
 * The tests node:test's spec reporter reported in `text` (what `node --test` prints, or a CI's log of it), each with its
 * suites' titles (by indentation: a suite's line comes after its tests, two spaces out). The failures it says again at
 * the end are left out.
 */
export function nodeTestOutcomes(text: string): TestOutcome[] {
	const outcomes: (TestOutcome & { "indent": number })[] = [];

	for (const line of text.split(/\r?\n/u)) {
		if (RECAP.test(line)) {
			break;
		}

		const match = SPEC_LINE.exec(line);

		if (match === null) {
			continue;
		}

		const [, spaces, mark, title, ms, directive] = match;
		const indent = spaces.length;

		if (mark === "▶") {
			// (a suite, closing: the tests just before it, further in and not yet placed, are its)
			for (let index = outcomes.length - 1; index >= 0 && outcomes[index].indent > indent; index -= 1) {
				outcomes[index].titles.unshift(title);
				outcomes[index].indent = indent;
			}

			continue;
		}

		const outcome = directive === undefined ? MARKS[mark] : DIRECTIVES[directive];

		outcomes.push({ "titles": [title], "outcome": outcome, ...ms === undefined ? {} : { "ms": Number(ms) }, "indent": indent });
	}

	return outcomes.map(({ titles, outcome, ms }) => ({ "titles": titles, "outcome": outcome, ...ms === undefined ? {} : { "ms": ms } }));
}

/** How a test came out in one run, from its attempts' outcomes in order. */
function verdictOf(outcomes: TestOutcome["outcome"][]): Verdict {
	const tried = outcomes.filter((outcome) => outcome === "pass" || outcome === "fail");

	if (tried.length === 0) {
		return "skip";
	}

	if (tried.at(-1) === "fail") {
		return "fail";
	}

	return tried.includes("fail") ? "flaky" : "pass";
}

/** Each test's standing over `runs` (in any order: they're read by `at`). */
export function standings(runs: CiRun[]): Map<string, TestStanding> {
	const ordered = [...runs].sort((left, right) => left.at.localeCompare(right.at));
	const verdicts = new Map<string, { "run": CiRun; "verdict": Verdict }[]>();
	const times = new Map<string, number[]>();

	for (const run of ordered) {
		const seen = new Map<string, TestOutcome["outcome"][]>();

		for (const { jobs } of [...run.attempts].sort((left, right) => left.attempt - right.attempt)) {
			for (const job of jobs) {
				for (const test of job.tests) {
					const id = [job.name, ...test.titles].join(" › ");

					seen.set(id, [...seen.get(id) ?? [], test.outcome]);

					if (test.ms !== undefined) {
						times.set(id, [...times.get(id) ?? [], test.ms]);
					}
				}
			}
		}

		for (const [id, outcomes] of seen) {
			verdicts.set(id, [...verdicts.get(id) ?? [], { "run": run, "verdict": verdictOf(outcomes) }]);
		}
	}

	const answer = new Map<string, TestStanding>();

	for (const [id, history] of verdicts) {
		const latest = history.at(-1);
		const failed = history.findLast(({ verdict }) => verdict === "fail" || verdict === "flaky");
		let streak = 0;

		while (streak < history.length && history[history.length - 1 - streak].verdict === latest.verdict) {
			streak += 1;
		}

		const sorted = [...times.get(id) ?? []].sort((left, right) => left - right);
		const at = (run: CiRun): { "run": string; "commit": string; "at": string } => ({ "run": run.id, "commit": run.commit, "at": run.at });

		answer.set(id, {
			"id": id,
			"runs": history.length,
			"last": { "verdict": latest.verdict, ...at(latest.run) },
			...failed === undefined ? {} : { "lastFailed": { "verdict": failed.verdict as "fail" | "flaky", ...at(failed.run) } },
			"flakes": history.filter(({ verdict }) => verdict === "flaky").length,
			"streak": { "verdict": latest.verdict, "runs": streak },
			...sorted.length === 0 ? {} : { "ms": sorted[Math.floor(sorted.length / 2)] }
		});
	}

	return answer;
}

/** What GitHub's API answers of a workflow's runs, and of an attempt's jobs: the fields read here. */
interface GithubRun { "id": number; "head_sha": string; "created_at": string; "html_url"?: string; "run_attempt"?: number }
interface GithubJob { "id": number; "name": string; "status": string; "conclusion": string | null }

/** Where a finished job's tests are kept between reads (a job's log never changes once it's done). */
export interface OutcomeCache {
	"get": (job: string) => Promise<TestOutcome[] | undefined>;
	"set": (job: string, tests: TestOutcome[]) => Promise<void>;
}

/**
 * A GitHub Actions workflow's completed runs on `branch`, the latest `limit` of them, with each attempt's jobs and the
 * tests each job's log reported (`read`: the runner's reader, node:test's by default). A log past its retention reads
 * as no tests. `fetch` and `token` are the caller's (a token with the repository's read access); `cache` keeps what a
 * finished job's log said.
 */
export async function githubRuns(options: {
	"repository": string;
	"workflow": string;
	"branch"?: string;
	"limit"?: number;
	"token"?: string;
	"fetch"?: typeof globalThis.fetch;
	"cache"?: OutcomeCache;
	"read"?: (log: string) => TestOutcome[];
	"api"?: string;
}): Promise<CiRun[]> {
	const { repository, workflow, branch = "main", limit = 50, token, cache, read = nodeTestOutcomes, api = "https://api.github.com" } = options;
	const fetching = options.fetch ?? globalThis.fetch;
	const headers = { "Accept": "application/vnd.github+json", ...token === undefined ? {} : { "Authorization": `Bearer ${token}` } };
	const json = async <Answer>(path: string): Promise<Answer> => {
		const response = await fetching(`${api}/repos/${repository}${path}`, { "headers": headers });

		if (!response.ok) {
			throw new Error(`GitHub answered ${response.status} for ${path}`);
		}

		return response.json() as Promise<Answer>;
	};

	const testsOf = async (job: GithubJob): Promise<TestOutcome[]> => {
		const key = String(job.id);
		const kept = await cache?.get(key);

		if (kept !== undefined) {
			return kept;
		}

		const response = await fetching(`${api}/repos/${repository}/actions/jobs/${key}/logs`, { "headers": headers });
		const tests = response.ok ? read(await response.text()) : [];

		// (only a finished job's: one still running says more later; a log past its retention says nothing again)
		if (job.status === "completed" && (response.ok || response.status === 410)) {
			await cache?.set(key, tests);
		}

		return tests;
	};

	const runs: CiRun[] = [];

	for (let page = 1; runs.length < limit; page += 1) {
		const listed = await json<{ "workflow_runs"?: GithubRun[] }>(`/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${String(Math.min(100, limit))}&page=${String(page)}`);

		for (const run of listed.workflow_runs ?? []) {
			if (runs.length >= limit) {
				break;
			}

			const attempts: CiRun["attempts"] = [];

			for (let attempt = 1; attempt <= (run.run_attempt ?? 1); attempt += 1) {
				const { jobs } = await json<{ "jobs"?: GithubJob[] }>(`/actions/runs/${String(run.id)}/attempts/${String(attempt)}/jobs?per_page=100`);

				attempts.push({ "attempt": attempt, "jobs": await Promise.all((jobs ?? []).map(async (job) => ({ "name": job.name, "conclusion": job.conclusion, "tests": await testsOf(job) }))) });
			}

			runs.push({ "id": String(run.id), "commit": run.head_sha, "at": run.created_at, "url": run.html_url, "attempts": attempts });
		}

		if ((listed.workflow_runs ?? []).length === 0) {
			break;
		}
	}

	return runs;
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert = (await import("node:assert")).strict;

		// node:test's spec reporter, in a CI's log: a suite's line after its tests, and the failures' recap left out.
		const log = [
			"2026-10-29T21:48:23.9506864Z ✔ node script: a task runs (60703.83ms)",
			"2026-10-29T21:48:24.0000000Z   ✔ adds (1.5ms)",
			"2026-10-29T21:48:24.0000001Z   ✖ subtracts (2ms)",
			"2026-10-29T21:48:24.0000002Z ▶ calc (4ms)",
			"2026-10-29T21:48:25.0000000Z ﹣ later (0.1ms) # SKIP",
			"2026-10-29T21:48:26.0000000Z ✖ failing tests:",
			"2026-10-29T21:48:26.0000001Z ✖ subtracts (2ms)"
		].join("\n");

		assert.deepEqual(nodeTestOutcomes(log), [
			{ "titles": ["node script: a task runs"], "outcome": "pass", "ms": 60703.83 },
			{ "titles": ["calc", "adds"], "outcome": "pass", "ms": 1.5 },
			{ "titles": ["calc", "subtracts"], "outcome": "fail", "ms": 2 },
			{ "titles": ["later"], "outcome": "skip", "ms": 0.1 }
		]);

		// Folded: a failure that passed on the rerun is a flake; the streak is the latest verdict's, latest back.
		const job = (tests: [string, TestOutcome["outcome"]][]): CiRun["attempts"][number]["jobs"][number] => ({ "name": "tour", "conclusion": null, "tests": tests.map(([title, outcome]) => ({ "titles": [title], "outcome": outcome, "ms": 10 })) });
		const run = (id: string, ...attempts: [string, TestOutcome["outcome"]][][]): CiRun => ({ "id": id, "commit": "c" + id, "at": `2026-10-2${id}T00:00:00Z`, "attempts": attempts.map((tests, index) => ({ "attempt": index + 1, "jobs": [job(tests)] })) });
		const standing = standings([
			run("3", [["a", "pass"], ["b", "pass"]]),
			run("1", [["a", "fail"], ["b", "pass"]]),
			run("2", [["a", "fail"], ["b", "fail"]], [["a", "pass"], ["b", "fail"]]),
			run("4", [["a", "pass"], ["b", "pass"]])
		]);

		assert.deepEqual(standing.get("tour › a")?.streak, { "verdict": "pass", "runs": 2 });
		assert.equal(standing.get("tour › a")?.flakes, 1);
		assert.deepEqual(standing.get("tour › a")?.lastFailed, { "verdict": "flaky", "run": "2", "commit": "c2", "at": "2026-10-22T00:00:00Z" });
		assert.deepEqual(standing.get("tour › b")?.lastFailed?.verdict, "fail", "b failed on its rerun too");
		assert.equal(standing.get("tour › b")?.runs, 4);
		assert.equal(standing.get("tour › b")?.ms, 10);

		console.log("outcomes: ok");
	})();
}
