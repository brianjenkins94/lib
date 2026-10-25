/**
 * silo — runtime evidence (pure, zero-dep): what running a program teaches about its code, in the shape silo keeps it.
 *
 * A run is evidence about one version of the code in one environment. Its ENVELOPE says whose run it was, where it ran
 * and on what code; what it observed (coverage, time, values, capabilities) attaches to spans of that code and joins the
 * envelope by its run id. Everything lives in git under `.silo/`, so it travels with the repo (the whole layout, and
 * who writes what: ./layout):
 *
 *   .silo/runs/<user>.jsonl                      one envelope per run, appended (a run kept local goes in
 *                                                local/runs/<user>.jsonl instead: RunScope)
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

import type { WsConsumer } from "./detect.js";
import { evidencePathFor, slug } from "./layout.js";
import { isEntry } from "@brianjenkins94/util/env";

/** Where a run ran — a coarse class detected automatically, plus a name its user chose (never a fingerprint). */
export interface Environment {
	/** What ran the code: tsval's interpreter, the almostnode runtime, the browser (a preview), or a Node process (a
	 *  command line, an MCP server's tool). */
	"runtime": "tsval" | "almostnode" | "preview" | "node";
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
	/** What was run, as typed (`node app.ts`, `npm run dev`), and the file or folder it ran (repo-relative) — or, for
	 *  something run that isn't a file, its kind and name (`tool:<name>`, an MCP server's tool). */
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
	 *  oid) — exact for uncommitted code, and the version its observations describe. A named entry (`tool:<name>`) is
	 *  listed by its own version: a hash of its content. */
	"commit"?: string;
	"files": Record<string, string>;
	/** Every version of a file the run ran, when it ran more than one (a preview's hot updates): oids, oldest first. */
	"versions"?: Record<string, string[]>;
	/** What it did to the world — and what it didn't: each gated call (a capability, the resource it reached) once per
	 *  way it went, with how many calls went that way. Absent when it made no gated call. */
	"effects"?: Effect[];
	/** The packages whose code it ran, by `name@version` (a package with no version: its name), each with its integrity
	 *  when the lockfile names the install — so whether anyone ran a version later found compromised is a question these
	 *  records answer. Absent when it ran no package's code. */
	"packages"?: Record<string, RanPackage>;
	/** Files it ran whose code couldn't be parsed where it ran, so what ran there isn't kept (no evidence): repo-relative
	 *  path → why. Absent when everything it ran was kept. */
	"unparsed"?: Record<string, string>;
}

/** A package a run ran: its lockfile integrity (`sha512-…`), when the lockfile has the install. */
export interface RanPackage { "integrity"?: string }

/** A package whose code a run ran, as a runtime tells it: its name, its version, and its folder relative to the
 *  repository (`node_modules/a/node_modules/b`: how package-lock.json names an install). */
export interface LoadedPackage { "name": string; "version"?: string; "dir": string }

/** The packages a run ran, as its envelope keeps them: each by `name@version`, with the integrity a package-lock.json
 *  (lockfileVersion 2 or 3, its text) gives its install. Pure. */
export function ranPackages(loaded: LoadedPackage[], packageLock?: string): Record<string, RanPackage> {
	let installs: Record<string, { "version"?: string; "integrity"?: string }> = {};

	try {
		installs = (JSON.parse(packageLock ?? "{}") as { "packages"?: typeof installs }).packages ?? {};
	} catch {
		// an unreadable lockfile: the versions alone
	}

	const ran: Record<string, RanPackage> = {};

	for (const { name, version, dir } of loaded.toSorted((left, right) => left.dir.localeCompare(right.dir))) {
		const install = installs[dir];
		const integrity = install?.version === version ? install?.integrity : undefined;

		ran[version === undefined ? name : `${name}@${version}`] = integrity === undefined ? {} : { "integrity": integrity };
	}

	return ran;
}

/** One kind of gated call a run made, and how it went: `made` for real; `denied` (it failed, as a refused call does);
 *  `skipped` (not made — the program went on as if it had done nothing); `given` (a rule's result in its place, or a
 *  recorded one). */
export interface Effect {
	"capability": string;
	"resource": string;
	"how": "made" | "denied" | "skipped" | "given";
	"calls": number;
	/** The package whose code made the call, by `name@version` (one of the run's `packages`); absent for the program's own. */
	"package"?: string;
	/** How it was decided: within what the package's baseline accepts of it (`baseline`); by the policy — a rule, or its
	 *  default — (`policy`); or, asked at the call, the person's answer: allowed this once (`once`), allowed always
	 *  (`always`: a rule in their policy now, too), or refused (`refused`). The answers are the policy's exceptions —
	 *  here, so they're on record whether or not the policy that grew from them is committed. Or, in a run nobody was
	 *  watching, what the call returned when it last ran for real, given back (`recorded`), or a file it wrote into its
	 *  own layer, thrown away when it ends (`layer`). Absent when nothing decided it (a call that wasn't gated). */
	"decided"?: "baseline" | "policy" | "once" | "always" | "refused" | "recorded" | "layer";
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

/** What to ask the run ledger: runs that ran `file` (their entry, or any file they ran), by `user`, ended `since` (ISO);
 *  and of their effects, those whose capability is `capability` (`fs` matches `fs:read` and `fs:write`), whose resource
 *  contains `resource`, that went `how` — given any of these three, only the runs with such an effect. */
export interface RunQuery {
	"file"?: string;
	"user"?: string;
	"since"?: string;
	"capability"?: string;
	"resource"?: string;
	"how"?: Effect["how"];
	/** Runs that ran a package: `name` (any version) or `name@version`. */
	"package"?: string;
	/** Runs answered, newest first, at most (default 20); the effects rollup is over every run that matched. */
	"limit"?: number;
}

/** The ledger's answer: how many runs matched, the newest of them, and their effects added up — each kind of call with
 *  its calls across those runs, how many runs made it, and the first and last time (the runs' ends). */
export interface RunAnswer {
	"total": number;
	"runs": RunEnvelope[];
	"effects": (Effect & { "runs": number; "first": string; "last": string })[];
}

/** Ask runs (parseRuns') a RunQuery. */
export function queryRuns(runs: RunEnvelope[], query: RunQuery = {}): RunAnswer {
	const byEffect = query.capability !== undefined || query.resource !== undefined || query.how !== undefined;
	const wanted = (effect: Effect): boolean => (query.capability === undefined || effect.capability === query.capability || effect.capability.startsWith(query.capability + ":"))
		&& (query.resource === undefined || effect.resource.includes(query.resource))
		&& (query.how === undefined || effect.how === query.how);
	const matched = runs.filter((run) => (query.file === undefined || run.entry === query.file || query.file in run.files)
		&& (query.user === undefined || run.user === query.user)
		&& (query.since === undefined || run.endedAt >= query.since)
		&& (query.package === undefined || Object.keys(run.packages ?? {}).some((ran) => ran === query.package || ran.slice(0, ran.lastIndexOf("@") > 0 ? ran.lastIndexOf("@") : undefined) === query.package))
		&& (!byEffect || (run.effects ?? []).some(wanted))).toSorted((a, b) => b.endedAt.localeCompare(a.endedAt));
	const effects = new Map<string, RunAnswer["effects"][number]>();

	// (newest first, so the first a kind is seen in is its last)
	for (const run of matched) {
		for (const effect of (run.effects ?? []).filter(wanted)) {
			const key = `${effect.how}\0${effect.capability}\0${effect.resource}\0${effect.package ?? ""}\0${effect.decided ?? ""}`;
			const known = effects.get(key);

			if (known === undefined) {
				effects.set(key, { ...effect, "runs": 1, "first": run.endedAt, "last": run.endedAt });
			} else {
				known.calls += effect.calls;
				known.runs += 1;
				known.first = run.endedAt;
			}
		}
	}

	return { "total": matched.length, "runs": matched.slice(0, query.limit ?? 20), "effects": [...effects.values()].toSorted((a, b) => b.runs - a.runs || a.capability.localeCompare(b.capability) || a.resource.localeCompare(b.resource)) };
}

/** What a baseline says of each package (audit's `Baseline.packages`): its version, and what its own code can do — with,
 *  for each capability a later version gained, the version that gained it (`grew`). A fact, as the rest is: what a grown
 *  capability does at the call is the policy's to say (it asks, by default), never the baseline's. */
export type BaselinePackages = Record<string, { "version"?: string; "caps": string[]; "grew"?: Record<string, string> }>;

/** A package as it's installed: its version, and what its own code can do (`./detect`, by static analysis). */
export type InstalledPackages = Record<string, { "version"?: string; "caps": string[] }>;

/** A capability as a baseline names it: the network's kinds are `net`'s. */
const capabilityClass = (capability: string): string => (capability.startsWith("net") ? "net" : capability);

/** Whether `caps` (a baseline's, for one package) account for `capability`: by its class (`net.ws` is `net`'s), a coarse
 *  `fs` covering `fs:read` and `fs:write`. */
export function covers(caps: readonly string[], capability: string): boolean {
	const named = capabilityClass(capability);

	return caps.includes(named) || (named.startsWith("fs:") && caps.includes("fs"));
}

/** What a package's baseline accounts for at the call: what its code could do when it was added — not what a later
 *  version grew, which is outside the baseline until the policy allows it. */
export function settledCaps(entry: BaselinePackages[string]): string[] {
	return entry.caps.filter((capability) => entry.grew?.[capability] === undefined);
}

/**
 * What the gate decides a package's call against: the settled join — what the part of `name` the project's code uses
 * could reach when it began to (each workspace's entries for it, its subpaths too, less what grew since) — or, for a
 * package no workspace imports itself (one a dependency uses), the whole package's settled capabilities. Undefined when
 * the baseline has neither.
 */
export function settledReach(baseline: { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages }, name: string): string[] | undefined {
	const entries = Object.values(baseline.consumer ?? {}).flatMap((workspace) => Object.entries(workspace).filter(([spec, entry]) => entry.kind === "package" && (spec === name || spec.startsWith(name + "/"))).map(([, entry]) => entry));

	if (entries.length > 0) {
		return [...new Set(entries.flatMap((entry) => entry.caps.filter((capability) => entry.grew?.[capability] === undefined)))].sort();
	}

	const entry = baseline.packages?.[name];

	return entry === undefined ? undefined : settledCaps(entry);
}

/**
 * The baseline's `consumer` brought up to the code's use of its dependencies now (`next`): each entry as it is now, and
 * what its reach gained since `previous` — a capability the entry couldn't reach before — recorded in its `grew` with
 * what brought it in: the members the code started using, else the version the package moved to. A use that's new
 * altogether grows too (the code started using a package it had), unless the package itself is new (`added`: taken as
 * it is, as syncPackages takes a library added). With no `previous` (the baseline being made) nothing grows. Pure;
 * `grew` names the entries that grew, `workspace spec`.
 */
export function syncConsumer(previous: Record<string, WsConsumer> | undefined, next: Record<string, WsConsumer>, added: ReadonlySet<string> = new Set()): { "consumer": Record<string, WsConsumer>; "grew": string[] } {
	const consumer: Record<string, WsConsumer> = structuredClone(next);
	const grew: string[] = [];

	if (previous === undefined) {
		return { "consumer": consumer, "grew": grew };
	}

	for (const [workspace, entries] of Object.entries(consumer)) {
		for (const [spec, entry] of Object.entries(entries)) {
			const before = previous[workspace]?.[spec];
			const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
			const kept = { ...before?.grew };

			if (before !== undefined || (entry.kind === "package" && !added.has(name))) {
				const reach = before?.caps ?? [];
				const members = entry.members.filter((member) => before?.members.includes(member) !== true);
				const origin = members.length > 0 ? members.join(", ") : entry.dynamic && before?.dynamic !== true ? "*" : entry.version ?? "";

				for (const capability of entry.caps.filter((each) => !covers(reach, each))) {
					kept[capability] ??= origin;
				}
			}

			// (what grew stays grown while it's still reached; a capability no longer reached drops out)
			const still = Object.fromEntries(Object.entries(kept).filter(([capability]) => entry.caps.includes(capability)));

			if (Object.keys(still).length > 0) {
				entry.grew = still;
			}

			if (Object.keys(still).length > Object.keys(before?.grew ?? {}).filter((capability) => entry.caps.includes(capability)).length) {
				grew.push(workspace + " " + spec);
			}
		}
	}

	return { "consumer": consumer, "grew": grew };
}

/** baseline.json's `join` mark: 1 when the consumer's package entries hold their joins (what the code's use of each can
 *  reach). A baseline without it — from before, or written by a front end that doesn't slice — has none to keep or to
 *  grow from. */
export const JOIN = 1;

/** One slice of a package to read for the join: the workspace and specifier of the code's use, and the members it uses
 *  (`*`: all of them — a dynamic use, or one that names none). */
export interface JoinSlice { "workspace": string; "spec": string; "members": string[] }

/** The package a specifier names (`@scope/name/sub` → `@scope/name`). */
function packageOfSpec(spec: string): string {
	return spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
}

/**
 * The slices to read for the code's use now (`next`, consumerOf's), by package: every package entry's, but one that's
 * the same use of the same version as in `existing` (a baseline with the join mark), whose join is kept — set on `next`,
 * which this changes. Both front ends read what this names (the editor off tarballs, the command line off node_modules)
 * and set each entry's `caps` to its slice's, or the whole package's where no slice could be built.
 */
export function joinsWanted(next: Record<string, WsConsumer>, existing: { "consumer"?: Record<string, WsConsumer>; "join"?: number } | undefined): Map<string, JoinSlice[]> {
	const slices = new Map<string, JoinSlice[]>();

	for (const [workspace, entries] of Object.entries(next)) {
		for (const [spec, entry] of Object.entries(entries).filter(([, each]) => each.kind === "package")) {
			const before = existing?.join === JOIN ? existing.consumer?.[workspace]?.[spec] : undefined;

			if (before !== undefined && before.version === entry.version && before.dynamic === entry.dynamic && before.members.join() === entry.members.join()) {
				entry.caps = before.caps;
			} else {
				const name = packageOfSpec(spec);

				slices.set(name, [...slices.get(name) ?? [], { "workspace": workspace, "spec": spec, "members": entry.dynamic || entry.members.length === 0 ? ["*"] : entry.members }]);
			}
		}
	}

	return slices;
}

/** What the code's use grows from (syncConsumer's `previous`): `existing`'s consumer when it holds joins and was read —
 *  an empty one wasn't (the code couldn't be read when the baseline was made) — else undefined: nothing grows. */
export function joinedBefore(existing: { "consumer"?: Record<string, WsConsumer>; "join"?: number } | undefined): Record<string, WsConsumer> | undefined {
	return existing?.join === JOIN && Object.keys(existing.consumer ?? {}).length > 0 ? existing.consumer : undefined;
}

/**
 * `baseline` brought up to what's `installed` — what changes when libraries are added, never what runs see. A package
 * not in it is taken as its code is now (trust on first use: what a library can do is settled when it's added). A new
 * version takes the old one's place; what it can do that the old couldn't is recorded with the version that grew it,
 * and asks at the call as anything outside the baseline does. A package no longer installed stays: what it could do
 * still was. Pure; `changed` names the packages, by what happened to each (`grew`: a new version that can do more).
 */
export function syncPackages(baseline: BaselinePackages, installed: InstalledPackages): { "packages": BaselinePackages; "changed": { "added": string[]; "updated": string[]; "grew": string[] } } {
	const packages: BaselinePackages = structuredClone(baseline);
	const changed = { "added": [] as string[], "updated": [] as string[], "grew": [] as string[] };

	for (const [name, now] of Object.entries(installed).toSorted(([one], [other]) => one.localeCompare(other))) {
		const entry = packages[name];
		const caps = now.caps.toSorted();

		if (entry === undefined) {
			packages[name] = { ...now.version === undefined ? {} : { "version": now.version }, "caps": caps };
			changed.added.push(name);
		} else if (entry.version !== now.version) {
			const grown = caps.filter((capability) => !covers(entry.caps, capability));
			const grew = { ...entry.grew, ...Object.fromEntries(grown.map((capability) => [capability, now.version ?? ""])) };

			packages[name] = { ...now.version === undefined ? {} : { "version": now.version }, "caps": [...entry.caps, ...grown].toSorted(), ...Object.keys(grew).length === 0 ? {} : { "grew": grew } };
			(grown.length === 0 ? changed.updated : changed.grew).push(name);
		}
	}

	return { "packages": packages, "changed": changed };
}

/** A package's call a run made that its baseline doesn't account for: the package isn't in it (`new`), or the
 *  capability isn't among what it could do when added (`beyond`; `grew`: the version that gained it, when one did) —
 *  with the run it was in, and the baseline's version, when the one that ran isn't it. A refused or skipped call counts
 *  too: it's what the package tried. */
export interface BeyondBaseline {
	"kind": "new" | "beyond";
	"package": string;
	"capability": string;
	"resource": string;
	"how": Effect["how"];
	"calls": number;
	"run": { "id": string; "user": string; "entry": string; "endedAt": string };
	"grew"?: string;
	"baseline"?: BaselinePackages[string];
}

/** Every package call in `runs` that `baseline` (the baseline's packages) doesn't account for, newest run first. Pure:
 *  the runs and the baseline are both committed, so this is as true of the history as of now. */
export function beyondBaseline(runs: RunEnvelope[], baseline: BaselinePackages): BeyondBaseline[] {
	const found: BeyondBaseline[] = [];

	for (const run of runs.toSorted((one, other) => other.endedAt.localeCompare(one.endedAt))) {
		for (const effect of run.effects ?? []) {
			if (effect.package !== undefined) {
				const at = effect.package.lastIndexOf("@");
				const name = at > 0 ? effect.package.slice(0, at) : effect.package;
				const version = at > 0 ? effect.package.slice(at + 1) : undefined;
				const entry = baseline[name];
				const covered = entry !== undefined && covers(settledCaps(entry), effect.capability);
				const grew = Object.entries(entry?.grew ?? {}).find(([capability]) => covers([capability], effect.capability))?.[1];

				if (!covered) {
					found.push({
						"kind": entry === undefined ? "new" : "beyond",
						"package": effect.package,
						"capability": effect.capability,
						"resource": effect.resource,
						"how": effect.how,
						"calls": effect.calls,
						"run": { "id": run.id, "user": run.user, "entry": run.entry, "endedAt": run.endedAt },
						...grew === undefined ? {} : { "grew": grew },
						...entry === undefined || entry.version === version ? {} : { "baseline": entry }
					});
				}
			}
		}
	}

	return found;
}

/** How far to trust what an entry does, from its runs (`confidence`). */
export interface Confidence {
	/** `unproven` (score under 20), `provisional` (under 60), or `trusted`. */
	"band": "unproven" | "provisional" | "trusted";
	/** The lower bound, as a percentage. */
	"score": number;
	/** How many runs it has. */
	"n": number;
}

/** A run of an earlier version of an entry counts this much of a run. */
const EARLIER_VERSION = 0.4;

/**
 * How far to trust what `entry` does — a file, or a named unit (`tool:<name>`) — from its runs: a 95% Wilson lower bound
 * on the share of them that ended cleanly (exit 0). A run of the version it is now (`files[entry]` is `version`) counts
 * as a whole run, one of an earlier version as 0.4 of one, so trust rises with clean runs and fades when the code
 * changes. A run its user stopped says nothing either way and doesn't count. Whose runs count is the caller's: everyone's
 * shared runs make it the team's confidence, one user's runs make it theirs.
 */
export function confidence(runs: RunEnvelope[], entry: string, version: string): Confidence {
	const own = runs.filter((run) => run.entry === entry && run.stopped !== true);
	let n = 0;
	let clean = 0;

	for (const run of own) {
		const weight = run.files[entry] === version ? 1 : EARLIER_VERSION;

		n += weight;

		if (run.exit === 0) {
			clean += weight;
		}
	}

	if (n === 0) {
		return { "band": "unproven", "score": 0, "n": 0 };
	}

	const p = clean / n;
	const z = 1.96;
	const bound = (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);

	return { "band": bound < 0.2 ? "unproven" : bound < 0.6 ? "provisional" : "trusted", "score": Math.round(bound * 100), "n": own.length };
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

/** What made a function's calls impure, as a run counts them (tsval's `escapes`): wrote outside it, made an effect, read
 *  the clock or random numbers — and calls into code the run can't see into (`unwatched`: a package's), which could have
 *  been any of them. */
export interface PurityCounts { "write": number; "effect": number; "nondeterministic": number; "unwatched": number }

/** How a function's calls went (silo README, *Purity*): strict counts of its calls, and of those impure each way, since
 *  its span last changed; the first impurity seen (what, and of which kind); and the first code it called that runs
 *  can't see into. The faded weight is its calls. A function judged unknown and run often, never impure and never
 *  unwatched, is "seen 4,000 times, never impure"; one judged pure and seen impure, an assumption broken. */
export interface PurityObservation extends Observed, PurityCounts {
	"kind": "purity";
	"calls": number;
	"first"?: { "kind": "write" | "effect" | "nondeterministic"; "what": string };
	"unseen"?: string;
}

export type Observation = ReachedObservation | ValueObservation | BranchObservation | PurityObservation;

/** The kinds an evidence file holds. */
const KINDS = new Set<string>(["reached", "value", "branch", "purity"]);

/** At most this many type tags a value observation keeps; the rest count as `other`. */
export const MAX_TAGS = 8;

/** How many runs of a file halve the weight of what earlier runs observed in it (RUNTIME-EVIDENCE.md, D2). */
export const HALF_LIFE_RUNS = 20;

/** Below this many faded runs, a span no run reports any more (its code changed or went) is dropped. */
const FORGOTTEN = 0.05;

/** Where `user`'s runs in `environment` keep what they observed of `file` (repo-relative), from the repo root. */
export function evidencePath(user: string, environment: Environment, file: string): string {
	return evidencePathFor(user, environmentKey(environment), file);
}

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

/** One function's run, as a run reports it: its calls, how many were impure each way, and the first impurity. */
export interface PurityReport extends PurityCounts { "span": string; "calls": number; "first"?: PurityObservation["first"]; "unseen"?: string }

/** One run's functions of a file, folded in: each that ran adds its calls and impure calls to its strict counts, and
 *  keeps the first impurity and the first unwatched call ever seen; its faded weight is its calls. A function that
 *  didn't run this time only fades. */
export function foldPurity(known: Observation[], reports: PurityReport[], run: { "id": string; "at": string }, halfLife = HALF_LIFE_RUNS): Observation[] {
	const add = (a: PurityCounts, b: PurityCounts): PurityCounts => ({ "write": a.write + b.write, "effect": a.effect + b.effect, "nondeterministic": a.nondeterministic + b.nondeterministic, "unwatched": a.unwatched + b.unwatched });

	return fold<PurityObservation, PurityReport>("purity", known, reports, run, halfLife, (a, b) => ({ ...a, ...add(a, b), "calls": a.calls + b.calls, ...a.first ?? b.first ? { "first": a.first ?? b.first } : {}, ...a.unseen ?? b.unseen ? { "unseen": a.unseen ?? b.unseen } : {} }), (before, report, fade) => {
		const first = before?.first ?? report.first;
		const unseen = before?.unseen ?? report.unseen;

		return {
			"w": (before?.w ?? 0) * fade + report.calls,
			"ever": (before?.ever ?? 0) + 1,
			"calls": (before?.calls ?? 0) + report.calls,
			...add(before ?? { "write": 0, "effect": 0, "nondeterministic": 0, "unwatched": 0 }, report),
			...first === undefined ? {} : { "first": first },
			...unseen === undefined ? {} : { "unseen": unseen }
		};
	});
}

// ── samples: the values themselves, on this machine only ──

/** A few distinct primitives seen at a value site — "only ever `"left"` or `"right"`" — kept in `.silo/local/` on the
 *  machine that saw them: values can be tokens, emails or anything else, so they're never committed. */
export interface Samples { "span": string; "values": (string | number | boolean)[] }

/** At most this many distinct values a site keeps, the newest first. */
export const MAX_SAMPLES = 5;

/** The samples in a samples file, junk skipped. */
export function parseSamples(text: string): Samples[] {
	const bySpan = new Map<string, Samples>();

	for (const line of text.split("\n")) {
		try {
			const value = JSON.parse(line) as Partial<Samples>;

			if (typeof value.span === "string" && Array.isArray(value.values)) {
				bySpan.set(value.span, value as Samples);
			}
		} catch { /* not a line of ours */ }
	}

	return [...bySpan.values()];
}

/** One run's samples folded in: each site's newest distinct values first, MAX_SAMPLES of them. Only spans in `keep`
 *  stay (the file's value evidence: a site whose evidence has faded away takes its samples with it). */
export function foldSamples(known: Samples[], reports: Samples[], keep: Set<string>): Samples[] {
	const bySpan = new Map(known.map((samples) => [samples.span, samples.values]));

	for (const { span, values } of reports) {
		bySpan.set(span, [...new Set([...values, ...bySpan.get(span) ?? []])].slice(0, MAX_SAMPLES));
	}

	return [...bySpan].filter(([span]) => keep.has(span)).map(([span, values]) => ({ "span": span, "values": values }));
}

/** A samples file's text: one site a line, sorted by span. */
export function samplesText(samples: Samples[]): string {
	return [...samples].sort((a, b) => a.span.localeCompare(b.span)).map((each) => JSON.stringify(each) + "\n").join("");
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

		const run = (id: string, endedAt: string, entry: string, effects?: RunEnvelope["effects"]): RunEnvelope => ({ "type": "run", "id": id, "title": `node ${entry}`, "entry": entry, "cwd": "", "startedAt": endedAt, "endedAt": endedAt, "exit": 0, "user": "ada", "environment": { "runtime": "tsval", "name": "default" }, "files": { [entry]: "0".repeat(40), "lib.js": "1".repeat(40) }, ...effects === undefined ? {} : { "effects": effects } });
		const runs = parseRuns([
			run("a", "2026-10-01T00:00:00.000Z", "app.js", [{ "capability": "fs:read", "resource": "/workspace/rates.json", "how": "made", "calls": 2 }, { "capability": "net", "resource": "api.example.com", "how": "denied", "calls": 1 }]),
			run("b", "2026-10-03T00:00:00.000Z", "app.js", [{ "capability": "fs:read", "resource": "/workspace/rates.json", "how": "made", "calls": 1 }, { "capability": "fs:write", "resource": "/workspace/out.txt", "how": "skipped", "calls": 4 }]),
			run("c", "2026-10-02T00:00:00.000Z", "tool.js")
		].map((each) => JSON.stringify(each)).join("\n"));

		// Everything, newest first; the effects added up across runs.
		const all = queryRuns(runs);

		assert.deepEqual(all.runs.map((each) => each.id), ["b", "c", "a"]);
		assert.equal(all.total, 3);
		assert.deepEqual(all.effects[0], { "capability": "fs:read", "resource": "/workspace/rates.json", "how": "made", "calls": 3, "runs": 2, "first": "2026-10-01T00:00:00.000Z", "last": "2026-10-03T00:00:00.000Z" });

		// A function's runs, folded: calls and impure calls add up, the first impurity stays the first, and it fades.
		const purity = (calls: number, extra: Partial<PurityReport> = {}): PurityReport => ({ "span": "f", "calls": calls, "write": 0, "effect": 0, "nondeterministic": 0, "unwatched": 0, ...extra });
		const once = foldPurity([], [purity(3)], { "id": "r1", "at": "2026-10-01T00:00:00.000Z" });
		const twice = foldPurity(once, [purity(2, { "write": 1, "first": { "kind": "write", "what": "total" } }), purity(1, { "write": 1, "first": { "kind": "write", "what": "other" } })], { "id": "r2", "at": "2026-10-02T00:00:00.000Z" }) as PurityObservation[];

		assert.deepEqual([twice[0]!.calls, twice[0]!.write, twice[0]!.first?.what, twice[0]!.ever], [6, 2, "total", 2]);
		assert.ok(Math.abs(twice[0]!.w - (3 * 2 ** (-1 / HALF_LIFE_RUNS) + 3)) < 1e-9);
		assert.deepEqual(parseEvidence(evidenceText(twice)), twice, "a purity line reads back");
		assert.equal((foldPurity(twice, [], { "id": "r3", "at": "2026-10-03T00:00:00.000Z" })[0] as PurityObservation).calls, 6, "a function that didn't run keeps its counts, fading");

		// The packages a run ran: by name@version, the lockfile's integrity where it names the same install.
		const lock = JSON.stringify({ "packages": { "node_modules/greet": { "version": "1.2.3", "integrity": "sha512-a" }, "node_modules/greet/node_modules/@scope/inner": { "version": "0.0.9", "integrity": "sha512-b" } } });

		assert.deepEqual(ranPackages([{ "name": "@scope/inner", "version": "0.1.0", "dir": "node_modules/greet/node_modules/@scope/inner" }, { "name": "greet", "version": "1.2.3", "dir": "node_modules/greet" }, { "name": "bare", "dir": "node_modules/bare" }], lock), { "bare": {}, "greet@1.2.3": { "integrity": "sha512-a" }, "@scope/inner@0.1.0": {} }, "a lockfile naming another version gives no integrity");
		assert.deepEqual(ranPackages([{ "name": "greet", "version": "1.2.3", "dir": "node_modules/greet" }], "not json"), { "greet@1.2.3": {} });

		// A package's calls are its own, apart from the program's same calls.
		const byWhom = queryRuns(parseRuns([run("e", "2026-10-05T00:00:00.000Z", "app.js", [{ "capability": "fs:read", "resource": "/workspace/a.txt", "how": "made", "calls": 1 }, { "capability": "fs:read", "resource": "/workspace/a.txt", "how": "made", "calls": 2, "package": "greet@1.2.3" }])].map((each) => JSON.stringify(each)).join("\n")));

		assert.deepEqual(byWhom.effects.map((each) => [each.package, each.calls]), [[undefined, 1], ["greet@1.2.3", 2]]);

		// Beyond the baseline: a package's call it doesn't account for — a capability it couldn't do when added (a later
		// version's net, grown in 1.1.0), or a package it doesn't have — and not the program's own, nor what it does account for.
		const baseline = { "tool": { "version": "1.0.0", "caps": ["exec", "fs", "net"], "grew": { "net": "1.0.0" } } };
		const beyond = beyondBaseline(parseRuns([{ ...run("f", "2026-10-06T00:00:00.000Z", "app.js", [
			{ "capability": "exec", "resource": "ls", "how": "denied", "calls": 1, "package": "tool@1.1.0" },
			{ "capability": "fs:write", "resource": "/workspace/x", "how": "denied", "calls": 1, "package": "tool@1.1.0" },
			{ "capability": "net", "resource": "evil.example", "how": "made", "calls": 2, "package": "tool@1.1.0" },
			{ "capability": "fs:read", "resource": "/etc/passwd", "how": "made", "calls": 1, "package": "other@2.0.0" },
			{ "capability": "net", "resource": "api.example.com", "how": "made", "calls": 1 }
		]) }].map((each) => JSON.stringify(each)).join("\n")), baseline);

		assert.deepEqual(beyond.map((each) => [each.kind, each.package, each.capability, each.grew, each.baseline?.version]), [["beyond", "tool@1.1.0", "net", "1.0.0", "1.0.0"], ["new", "other@2.0.0", "fs:read", undefined, undefined]]);

		// Libraries added: a new one taken as its code is; a new version that can do nothing more takes the old one's
		// place; one that can do more takes it too, what it grew recorded with the version that grew it — outside what's
		// settled, so it asks at the call; one no longer installed stays.
		const synced = syncPackages({ "tool": { "version": "1.0.0", "caps": ["exec", "fs"] }, "same": { "version": "1.0.0", "caps": ["net"] }, "gone": { "version": "1.0.0", "caps": [] } }, {
			"tool": { "version": "1.1.0", "caps": ["exec", "fs:read", "net"] },
			"same": { "version": "1.2.0", "caps": ["net"] },
			"fresh": { "version": "0.1.0", "caps": ["env"] }
		});

		assert.deepEqual(synced.changed, { "added": ["fresh"], "updated": ["same"], "grew": ["tool"] });
		assert.deepEqual(synced.packages["tool"], { "version": "1.1.0", "caps": ["exec", "fs", "net"], "grew": { "net": "1.1.0" } });
		assert.deepEqual(synced.packages["same"], { "version": "1.2.0", "caps": ["net"] });
		assert.deepEqual(synced.packages["gone"], { "version": "1.0.0", "caps": [] });
		assert.ok(!covers(settledCaps(synced.packages["tool"]), "net") && covers(settledCaps(synced.packages["tool"]), "fs:read"), "what grew isn't settled");
		assert.deepEqual(syncPackages(synced.packages, { "tool": { "version": "1.1.0", "caps": ["exec", "fs:read", "net"] } }).changed, { "added": [], "updated": [], "grew": [] }, "the same version: nothing new");
		assert.deepEqual(syncPackages(synced.packages, { "tool": { "version": "1.2.0", "caps": ["env", "net"] } }).packages["tool"], { "version": "1.2.0", "caps": ["env", "exec", "fs", "net"], "grew": { "env": "1.2.0", "net": "1.1.0" } }, "what grew keeps the version that grew it");
		assert.ok(covers(["net"], "net.ws") && !covers(["fs:read"], "fs:write"));

		// By package: a name (any version, a scope's too) or a name@version.
		const withPackages = parseRuns([{ ...run("d", "2026-10-04T00:00:00.000Z", "app.js"), "packages": { "greet@1.2.3": {}, "@scope/inner@0.1.0": {} } }].map((each) => JSON.stringify(each)).join("\n"));

		assert.equal(queryRuns(withPackages, { "package": "greet" }).total, 1);
		assert.equal(queryRuns(withPackages, { "package": "@scope/inner" }).total, 1);
		assert.equal(queryRuns(withPackages, { "package": "greet@1.2.3" }).total, 1);
		assert.equal(queryRuns(withPackages, { "package": "greet@1.2.4" }).total, 0);

		// By file: an entry, or any file a run ran.
		assert.deepEqual(queryRuns(runs, { "file": "tool.js" }).runs.map((each) => each.id), ["c"]);
		assert.equal(queryRuns(runs, { "file": "lib.js" }).total, 3);

		// By effect: `fs` is fs:read and fs:write; a resource by what it contains; only runs with such an effect, only those effects.
		const writes = queryRuns(runs, { "capability": "fs", "how": "skipped" });

		assert.deepEqual(writes.runs.map((each) => each.id), ["b"]);
		assert.deepEqual(writes.effects.map((each) => each.resource), ["/workspace/out.txt"]);
		assert.deepEqual(queryRuns(runs, { "resource": "example.com" }).runs.map((each) => each.id), ["a"]);
		assert.equal(queryRuns(runs, { "capability": "fs:rea" }).total, 0, "a capability is matched whole, or as a family");

		// Since, and a limit (the rollup is over every run that matched).
		assert.deepEqual(queryRuns(runs, { "since": "2026-10-02T00:00:00.000Z" }).runs.map((each) => each.id), ["b", "c"]);

		const newest = queryRuns(runs, { "limit": 1 });

		assert.deepEqual([newest.total, newest.runs.length, newest.effects.find((each) => each.capability === "net")?.runs], [3, 1, 1]);

		// Confidence: clean runs of the version an entry is now raise it; runs of an earlier version count less; a stopped run
		// doesn't count; an entry nobody ran is unproven.
		const toolRun = (id: string, version: string, exit: number, stopped = false): RunEnvelope => ({ ...run(id, "2026-10-04T00:00:00.000Z", "tool:fetch_page"), "files": { "tool:fetch_page": version }, "exit": exit, ...stopped ? { "stopped": true } : {} });
		const clean = Array.from({ "length": 10 }, (_, index) => toolRun("now" + index, "v2", 0));

		assert.deepEqual(confidence(clean, "tool:fetch_page", "v2"), { "band": "trusted", "score": 72, "n": 10 });
		assert.ok(confidence(clean, "tool:fetch_page", "v3").score < confidence(clean, "tool:fetch_page", "v2").score, "an edit fades it");
		assert.equal(confidence(clean, "tool:fetch_page", "v3").band, "provisional");
		assert.deepEqual(confidence([...clean, toolRun("stop", "v2", 130, true)], "tool:fetch_page", "v2"), confidence(clean, "tool:fetch_page", "v2"));
		assert.ok(confidence([...clean, toolRun("bad", "v2", 1)], "tool:fetch_page", "v2").score < 72, "a failure lowers it");
		assert.deepEqual(confidence(clean, "tool:other", "v2"), { "band": "unproven", "score": 0, "n": 0 });

		// The join's reach at the call: the code's use of a package it imports (less what grew), else the whole package.
		const joined = { "consumer": { ".": { "tool": { "kind": "package", "version": "1.0.0", "members": ["load"], "dynamic": false, "caps": ["fs:read", "net"], "grew": { "net": "fetchAll" } }, "tool/extra": { "kind": "package", "version": "1.0.0", "members": ["x"], "dynamic": false, "caps": ["env"] } } }, "packages": { "tool": { "version": "1.0.0", "caps": ["exec", "fs", "net"] }, "deep": { "version": "2.0.0", "caps": ["exec"] } } };

		assert.deepEqual(settledReach(joined, "tool"), ["env", "fs:read"], "the join: its subpaths too, less what grew");
		assert.deepEqual(settledReach(joined, "deep"), ["exec"], "a package only a dependency uses: the whole package");
		assert.equal(settledReach(joined, "absent"), undefined);

		// The code's use growing: a member it started using that reaches more grows (with that member); a new use of a
		// package it had grows; a package just added is taken as it is; a capability no longer reached drops out.
		const entry = (members: string[], caps: string[], extra: Partial<WsConsumer[string]> = {}): WsConsumer[string] => ({ "kind": "package", "version": "1.0.0", "members": members, "dynamic": false, "caps": caps, ...extra });
		const before = { ".": { "tool": entry(["load"], ["fs:read"]), "other": entry(["a"], ["exec"], { "grew": { "exec": "a" } }) } };
		const grown = syncConsumer(before, { ".": { "tool": entry(["load", "fetchAll"], ["fs:read", "net"]), "other": entry(["b"], ["env"]), "fresh": entry(["go"], ["net"]), "known": entry(["run"], ["exec"]) } }, new Set(["fresh"]));

		assert.deepEqual(grown.consumer["."]["tool"].grew, { "net": "fetchAll" });
		assert.equal(grown.consumer["."]["other"].grew?.["exec"], undefined, "no longer reached: no longer grown");
		assert.deepEqual(grown.consumer["."]["other"].grew, { "env": "b" });
		assert.equal(grown.consumer["."]["fresh"].grew, undefined, "a package just added: taken as it is");
		assert.deepEqual(grown.consumer["."]["known"].grew, { "exec": "run" }, "a new use of a package it had");
		assert.deepEqual(grown.grew.sort(), [". known", ". other", ". tool"]);
		assert.deepEqual(syncConsumer(undefined, { ".": { "tool": entry(["load"], ["net"]) } }).consumer["."]["tool"].grew, undefined, "the baseline being made: nothing grows");
		assert.deepEqual(syncConsumer(grown.consumer, grown.consumer).grew, [], "nothing new: nothing grows again");

		// What to slice: a use unchanged since a baseline with joins keeps its join; any other is read, `*` when dynamic.
		const kept = { "consumer": { ".": { "tool": entry(["load"], ["fs:read"]), "@s/p/sub": entry(["x"], ["env"]) } }, "join": JOIN };
		const now = { ".": { "tool": entry(["load"], []), "@s/p/sub": entry(["x"], [], { "version": "2.0.0" }), "dyn": entry([], [], { "dynamic": true }), "node:fs": { "kind": "builtin" as const, "members": ["readFileSync"], "dynamic": false, "caps": ["fs:read"] } } };
		const wanted = joinsWanted(now, kept);

		assert.deepEqual(now["."]["tool"].caps, ["fs:read"], "the same use of the same version: its join kept");
		assert.deepEqual([...wanted], [["@s/p", [{ "workspace": ".", "spec": "@s/p/sub", "members": ["x"] }]], ["dyn", [{ "workspace": ".", "spec": "dyn", "members": ["*"] }]]]);
		assert.equal(joinsWanted(structuredClone(now), { ...kept, "join": undefined }).size, 3, "no join mark: nothing kept");
		assert.equal(joinedBefore({ "consumer": {}, "join": JOIN }), undefined, "an empty consumer wasn't read: nothing grows from it");
		assert.equal(joinedBefore({ "consumer": kept.consumer }), undefined, "no join mark: nothing grows from it");
		assert.equal(joinedBefore(kept), kept.consumer);
	})();
}
