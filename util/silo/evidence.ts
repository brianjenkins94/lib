/**
 * silo — runtime evidence (pure, zero-dep): what running a program teaches about its code, in the shape silo keeps it.
 *
 * A run is evidence about one version of the code in one environment. Its ENVELOPE says whose run it was, where it ran
 * and on what code; what it observed (coverage, time, values, capabilities) attaches to spans of that code and joins the
 * envelope by its run id. Everything lives in git under `.silo/`, so it travels with the repo:
 *
 *   .silo/runs/<user>.jsonl                      one envelope per run, appended
 *   .silo/evidence/<user>/<env>/<file>.jsonl     what that user's runs in that environment observed of <file>: one
 *                                                line per (span, kind), sorted, summaries that fade as runs go by
 *   .silo/.gitattributes                         `*.jsonl merge=union`: a branch merge keeps both sides' lines,
 *                                                and the reader folds a span's duplicates
 *   .silo/local/                                 what stays on this machine (raw CPU profiles, full per-run detail):
 *                                                `.silo/.gitignore` keeps it out of git; everything else goes in
 *
 * No fs, no vscode, no node: whatever runs the program (the editor, a CLI, CI) gathers the facts and writes the lines
 * through its own file system; this decides their shape and where they go.
 */

/** Where a run ran — a coarse class detected automatically, plus a name its user chose (never a fingerprint). */
export interface Environment {
	/** What ran the code: tsval's interpreter, the almostnode runtime, or the browser (a preview). */
	"runtime": "tsval" | "almostnode" | "preview";
	/** The engine under it, major version only: `chromium-140`, `firefox-131`, `node-24`. */
	"engine": string;
	/** The OS family: `macos`, `windows`, `linux`, `android`, `ios`, or `unknown`. */
	"os": string;
	/** Logical cores, and memory in GB where the platform says (it rounds: 0.25 to 8). */
	"cores": number;
	"memoryGb"?: number;
	/** The machine's name, as its user set it; `default` until they do. */
	"name": string;
}

/** One run, as `.silo/runs/<user>.jsonl` keeps it. */
export interface RunEnvelope {
	"type": "run";
	/** The run's id: what its observations carry to join it. A UUID — records outlive the session that made them. */
	"id": string;
	/** What was run, as typed (`node app.ts`, `npm run dev`), and the file or folder it ran (repo-relative). */
	"title": string;
	"entry": string;
	"cwd": string;
	/** ISO timestamps. */
	"startedAt": string;
	"endedAt": string;
	"exit": number;
	/** Stopped by its user (Ctrl-C, Stop) rather than ending by itself. */
	"stopped"?: true;
	/** Who ran it (a slug of their git identity: userSlug). */
	"user": string;
	"environment": Environment;
	/** The commit checked out when it ran, if any, and the blob oid of each file it ran (repo-relative path → git blob
	 *  oid) — exact for uncommitted code, and the version its observations describe. */
	"commit"?: string;
	"files": Record<string, string>;
}

/** silo's folder, at the repo root. */
export const SILO_DIR = ".silo";

/** A safe file-name part: lowercase letters, digits, `.`, `_`, `-`. Undefined for nothing usable. */
export function slug(value: string): string | undefined {
	const result = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");

	return result === "" ? undefined : result;
}

/** The user a git config names, as a slug: its `[user]` section's email local part, else its name. */
export function userSlug(gitConfig: string): string | undefined {
	let inUser = false;
	let email: string | undefined;
	let name: string | undefined;

	for (const raw of gitConfig.split(/\r?\n/u)) {
		const line = raw.trim();

		if (line.startsWith("[")) {
			inUser = /^\[user(\s|\]|")/u.test(line); // `[user]` or `[user "x"]`, not `[remote …]`

			continue;
		}

		const eq = line.indexOf("=");

		if (!inUser || eq === -1) {
			continue;
		}

		const key = line.slice(0, eq).trim().toLowerCase();
		const value = line.slice(eq + 1).trim();

		if (key === "email") {
			email = value;
		} else if (key === "name") {
			name = value;
		}
	}

	const source = email === undefined ? name : email.split("@")[0];

	return source === undefined ? undefined : slug(source);
}

/** Where `user`'s run envelopes go, from the repo root. */
export function runsPath(user: string): string {
	return `${SILO_DIR}/runs/${slug(user) ?? "local"}.jsonl`;
}

/** An environment's key — its name and class — for partitioning what it observed: `laptop.tsval.chromium-140.macos`.
 *  Cores and memory are left out: they don't change what a run observes, only how fast. */
export function environmentKey(environment: Environment): string {
	return [environment.name, environment.runtime, environment.engine, environment.os].map((part) => slug(part) ?? "unknown").join(".");
}

/** An envelope as one line of `.silo/runs/<user>.jsonl`. */
export function envelopeLine(envelope: RunEnvelope): string {
	return JSON.stringify(envelope) + "\n";
}

/** The envelopes in a runs file — a line that isn't one (a merge's leftovers, a hand edit) is skipped — each run once
 *  (a branch merge can bring the same line in from both sides). */
export function parseRuns(text: string): RunEnvelope[] {
	const runs = new Map<string, RunEnvelope>();

	for (const line of text.split("\n")) {
		try {
			const value = JSON.parse(line) as Partial<RunEnvelope>;

			if (value.type === "run" && typeof value.id === "string") {
				runs.set(value.id, value as RunEnvelope);
			}
		} catch { /* not a line of ours */ }
	}

	return [...runs.values()];
}

/** What runs observed at one span of one file. Spans are BABLR `spanAnchors` ids — content-addressed, so a span keeps
 *  its id when code around it moves or changes, and gets a new one when it's edited itself (its evidence stays behind
 *  and fades). `key` names the scheme that made the id, so a change of scheme is explicit. Each kind keeps two sorts of
 *  number: faded ones (`w`, `runs`), which say how strong and how recent the evidence is, and strict ones, counted since
 *  the span last changed and never faded (a quick fix needs a strict claim, not a weighted guess). */
interface Observed {
	"span": string;
	"key": "bablr1";
	/** The faded total behind the kind's evidence (how often it ran, values seen, arms taken): each run of its file
	 *  multiplies it by 2^(−1/halfLife) and adds that run's. */
	"w": number;
	/** How many runs reported it, faded the same way — the evidence behind `w`. */
	"runs": number;
	/** How many runs observed it since its span last changed (strict): for `reached`, the runs it ran in. */
	"ever": number;
	/** The last run that reported it, and when. */
	"lastRun": string;
	"lastAt": string;
}

/** Whether, and how often, a statement ran. */
export interface ReachedObservation extends Observed { "kind": "reached" }

/** What went through a value site (`a?.b`'s `a`, `a ?? b`'s `a`, a parameter, a return): strict counts of values seen,
 *  of nullish ones, and of each type tag (RUNTIME-EVIDENCE.md, the second slice). */
export interface ValueObservation extends Observed {
	"kind": "value";
	"seen": number;
	"nullish": number;
	"tags": Record<string, number>;
}

/** Which way a branch went (an `if`, a conditional, `&&`, `||`): a strict count of each arm taken. */
export interface BranchObservation extends Observed {
	"kind": "branch";
	"arms": number[];
}

export type Observation = ReachedObservation | ValueObservation | BranchObservation;

/** The kinds an evidence file holds. */
const KINDS = new Set<string>(["reached", "value", "branch"]);

/** At most this many type tags a value observation keeps; the rest count as `other`. */
export const MAX_TAGS = 8;

/** How many runs of a file halve the weight of what earlier runs observed in it (RUNTIME-EVIDENCE.md, D2). */
export const HALF_LIFE_RUNS = 20;

/** Below this many faded runs, a span no run reports any more (its code changed or went) is dropped. */
const FORGOTTEN = 0.05;

/** Where `user`'s runs in `environment` keep what they observed of `file` (repo-relative), from the repo root. */
export function evidencePath(user: string, environment: Environment, file: string): string {
	return `${SILO_DIR}/evidence/${slug(user) ?? "local"}/${environmentKey(environment)}/${file}.jsonl`;
}

/** What stays on this machine, never committed: raw CPU profiles, full per-run detail. */
export const LOCAL_DIR = `${SILO_DIR}/local`;

/** What `.silo/.gitignore` says: `local/` stays out of git; everything else in `.silo/` goes in. */
export const GITIGNORE = "local/\n";

/** What `.silo/.gitattributes` says: evidence and run files merge line by line, keeping both sides. */
export const GITATTRIBUTES = "*.jsonl merge=union\n";

/** The observations in an evidence file — junk skipped, and a span's duplicate lines (a branch merge brings both
 *  sides') folded to the one last reported. */
export function parseEvidence(text: string): Observation[] {
	const bySpan = new Map<string, Observation>();

	for (const line of text.split("\n")) {
		try {
			const value = JSON.parse(line) as Partial<Observation>;

			if (typeof value.span !== "string" || !KINDS.has(value.kind as string) || typeof value.lastAt !== "string") {
				continue;
			}

			const id = value.kind + " " + value.span;
			const known = bySpan.get(id);

			if (known === undefined || value.lastAt > known.lastAt) {
				bySpan.set(id, value as Observation);
			}
		} catch { /* not a line of ours */ }
	}

	return [...bySpan.values()];
}

/** An evidence file's text: one observation per line, sorted by kind and span so concurrent edits touch distinct lines. */
export function evidenceText(observations: Observation[]): string {
	return [...observations].sort((a, b) => (a.kind + " " + a.span).localeCompare(b.kind + " " + b.span)).map((observation) => JSON.stringify(observation) + "\n").join("");
}

/**
 * Fold one run's reports of one kind into what earlier runs observed of a file: every span the run reports fades and
 * adds this run (`add`); a span of that kind it no longer reports (its code changed, or went, or didn't run) only
 * fades, and is dropped once it's faded away. Observations of other kinds pass through as they were.
 */
function fold<Kind extends Observation, Report extends { "span": string }>(kind: Kind["kind"], known: Observation[], reports: Report[], run: { "id": string; "at": string }, halfLife: number, merge: (a: Report, b: Report) => Report, add: (before: Kind | undefined, report: Report, fade: number) => Omit<Kind, "span" | "key" | "kind" | "runs" | "lastRun" | "lastAt">): Observation[] {
	const fade = 2 ** (-1 / halfLife);
	const bySpan = new Map(known.filter((observation): observation is Kind => observation.kind === kind).map((observation) => [observation.span, observation]));
	const reported = new Map<string, Report>();

	// One span can stand for several reports (statements pickAnchor gave one span): they happened together, so they add up.
	for (const report of reports) {
		const before = reported.get(report.span);

		reported.set(report.span, before === undefined ? report : merge(before, report));
	}

	const folded: Observation[] = known.filter((observation) => observation.kind !== kind);

	for (const [span, observation] of bySpan) {
		if (!reported.has(span)) {
			const runs = observation.runs * fade;

			if (runs >= FORGOTTEN) {
				folded.push({ ...observation, "w": observation.w * fade, "runs": runs });
			}
		}
	}

	for (const [span, report] of reported) {
		const before = bySpan.get(span);

		folded.push({ "span": span, "key": "bablr1", "kind": kind, ...add(before, report, fade), "runs": (before?.runs ?? 0) * fade + 1, "lastRun": run.id, "lastAt": run.at } as Kind);
	}

	return folded;
}

/** `a`'s and `b`'s tag counts summed. Past MAX_TAGS kinds, the most counted MAX_TAGS − 1 are kept and the rest count
 *  as `other`. */
function mergeTags(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
	const sum: Record<string, number> = { ...a };

	for (const [tag, count] of Object.entries(b)) {
		sum[tag] = (sum[tag] ?? 0) + count;
	}

	if (Object.keys(sum).length <= MAX_TAGS) {
		return sum;
	}

	const ranked = Object.entries(sum).filter(([tag]) => tag !== "other").sort(([x, a], [y, b]) => b - a || x.localeCompare(y));
	const kept = ranked.slice(0, MAX_TAGS - 1);
	const other = (sum["other"] ?? 0) + ranked.slice(MAX_TAGS - 1).reduce((total, [, count]) => total + count, 0);

	return { ...Object.fromEntries(kept), "other": other };
}

/**
 * One run's coverage of a file, folded in: every statement it reports (with how often it ran — 0 for one that didn't)
 * fades and adds this run; a statement it no longer reports only fades, and is dropped once it's faded away.
 */
export function foldReached(known: Observation[], reached: { "span": string; "count": number }[], run: { "id": string; "at": string }, halfLife = HALF_LIFE_RUNS): Observation[] {
	return fold<ReachedObservation, { "span": string; "count": number }>("reached", known, reached, run, halfLife, (a, b) => ({ "span": a.span, "count": a.count + b.count }), (before, { count }, fade) => ({
		"w": (before?.w ?? 0) * fade + count,
		"ever": (before?.ever ?? 0) + (count > 0 ? 1 : 0)
	}));
}

/** One run's value sites of a file, folded in: what went through each site that ran adds to its strict counts, and its
 *  faded weight (values seen). A site that didn't run this time only fades. */
export function foldValues(known: Observation[], values: { "span": string; "seen": number; "nullish": number; "tags": Record<string, number> }[], run: { "id": string; "at": string }, halfLife = HALF_LIFE_RUNS): Observation[] {
	return fold<ValueObservation, { "span": string; "seen": number; "nullish": number; "tags": Record<string, number> }>("value", known, values, run, halfLife, (a, b) => ({ "span": a.span, "seen": a.seen + b.seen, "nullish": a.nullish + b.nullish, "tags": mergeTags(a.tags, b.tags) }), (before, report, fade) => ({
		"w": (before?.w ?? 0) * fade + report.seen,
		"ever": (before?.ever ?? 0) + 1,
		"seen": (before?.seen ?? 0) + report.seen,
		"nullish": (before?.nullish ?? 0) + report.nullish,
		"tags": mergeTags(before?.tags ?? {}, report.tags)
	}));
}

/** One run's branches of a file, folded in: each arm taken adds to its strict count; the faded weight is the branch's
 *  times taken. A branch that didn't run this time only fades. */
export function foldBranches(known: Observation[], branches: { "span": string; "arms": number[] }[], run: { "id": string; "at": string }, halfLife = HALF_LIFE_RUNS): Observation[] {
	const addArms = (a: number[], b: number[]): number[] => Array.from({ "length": Math.max(a.length, b.length) }, (_, arm) => (a[arm] ?? 0) + (b[arm] ?? 0));

	return fold<BranchObservation, { "span": string; "arms": number[] }>("branch", known, branches, run, halfLife, (a, b) => ({ "span": a.span, "arms": addArms(a.arms, b.arms) }), (before, report, fade) => ({
		"w": (before?.w ?? 0) * fade + report.arms.reduce((total, count) => total + count, 0),
		"ever": (before?.ever ?? 0) + 1,
		"arms": addArms(before?.arms ?? [], report.arms)
	}));
}
