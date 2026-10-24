/**
 * silo — the feature ledger (pure, zero-dep): what's been decided about a program's features, kept beside its code in
 * `.silo/features.json`, and the drift between those decisions and the code (silo README, *The feature ledger*). Code is
 * easy to add and hard to remove, and a decision that lives in a chat can't be checked; one written here can.
 *
 * Decisions only, not an inventory: a feature nobody decided about isn't in it. An entry is named by people (`"capability
 * engine"`); it says what it is by a way in's key (features.ts': `command|tsval.explore`), by `paths` (files or folders,
 * from the repository's root — most code worth deciding about is reached from a way in rather than being one), or both.
 * Its status: `active` (kept on purpose, `why`), `experiment` (`until` a date), `parked`, `stopped`, or `removed` (a
 * tombstone: `in` the commit that removed it, and the command that would `restore` it).
 *
 * Drift, each a finding with both ways out — change the code, or the decision — and the checks that need no reach:
 *   stopped but present      a stopped entry's way in or paths are still there
 *   removed but documented   a removed entry's id or paths are still named in a `.md`
 *   experiment expired       past its `until` (or without one)
 *   dead end                 a way in that leads nowhere: a command or view declared and never registered, a setting
 *                            its code never reads (its name nowhere in the code)
 *   stale entry              an entry that names nothing that's there
 * Warnings for now: the design makes each an error once it's quiet on its repository.
 */

import { isEntry } from "@brianjenkins94/util/env";

export type LedgerStatus = "active" | "experiment" | "parked" | "stopped" | "removed";

export const STATUSES: LedgerStatus[] = ["active", "experiment", "parked", "stopped", "removed"];

/** One decision. `since` is stamped when its status is set. */
export interface LedgerEntry {
	"status": LedgerStatus;
	"why": string;
	"since": string;
	"key"?: string;
	"paths"?: string[];
	"until"?: string;
	"in"?: string;
	"restore"?: string;
}

/** The ledger: each entry by its name. */
export type Ledger = Record<string, LedgerEntry>;

/** A way in as `features` finds it: its key, kind, id and which sides of it the code states. */
export interface FoundWay { "key": string; "facet": string; "id": string; "sides": string[] }

/** What the checks read of the repository. */
export interface DriftFacts {
	/** Today, `YYYY-MM-DD`. */
	"today": string;
	/** Its ways in, as they are now. */
	"ways": FoundWay[];
	/** Whether a path (a file or a folder, from the root) is there. */
	"exists": (path: string) => boolean;
	/** Its docs (`.md`) and its code, with their text. */
	"docs": { "file": string; "text": string }[];
	"code": { "file": string; "text": string }[];
}

export type DriftCheck = "stopped but present" | "removed but documented" | "experiment expired" | "dead end" | "stale entry";

export interface Drift {
	"check": DriftCheck;
	/** The entry it's about (none for a dead end the ledger doesn't name). */
	"entry"?: string;
	"message": string;
	/** The two ways out: change the code, or change the decision. */
	"code": string;
	"decision": string;
}

/** The ledger in `text` (`.silo/features.json`); empty when there's none or it isn't JSON. */
export function parseLedger(text: string | undefined): Ledger {
	try {
		const parsed: unknown = JSON.parse(text ?? "{}");

		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Ledger : {};
	} catch {
		return {};
	}
}

/** The ledger as it's written: entries sorted by name, each field in one order, so unrelated changes touch other lines. */
export function ledgerText(ledger: Ledger): string {
	const order: (keyof LedgerEntry)[] = ["status", "why", "since", "until", "key", "paths", "in", "restore"];
	const sorted = Object.fromEntries(Object.keys(ledger).toSorted().map((name) => [name, Object.fromEntries(order.flatMap((field) => (ledger[name][field] === undefined ? [] : [[field, ledger[name][field]]])))]));

	return JSON.stringify(sorted, undefined, 2) + "\n";
}

/** `ledger` with `name` set to `status` for `why` — `since` today when its status changes, kept when it doesn't — and any
 *  of `more` (its key, paths, until, in, restore) over what it had. */
export function withStatus(ledger: Ledger, name: string, status: LedgerStatus, why: string, today: string, more: Partial<Omit<LedgerEntry, "status" | "why" | "since">> = {}): Ledger {
	if (!STATUSES.includes(status)) {
		throw new Error(`"${status}" isn't a status: ${STATUSES.join(", ")}`);
	}

	if (status === "experiment" && (more.until ?? ledger[name]?.until) === undefined) {
		throw new Error("an experiment needs an `until`: the date it's decided by");
	}

	const before = ledger[name];
	const since = before?.status === status ? before.since : today;

	return { ...ledger, [name]: { ...before, ...more, "status": status, "why": why, "since": since } };
}

/** What a removed entry is still known by in prose: its way in's id, its paths, and their file names (when they're
 *  distinctive enough not to match words). */
function namesOf(entry: LedgerEntry): string[] {
	const names = new Set<string>();

	if (entry.key !== undefined) {
		names.add(entry.key.slice(entry.key.indexOf("|") + 1));
	}

	for (const path of entry.paths ?? []) {
		names.add(path);

		const base = path.split("/").at(-1) ?? "";

		if (base.includes(".") && base.length > 6) {
			names.add(base);
		}
	}

	return [...names];
}

/** Whether `code` reads the setting `id`: its name whole, or its section and the rest (`getConfiguration("run").get(
 *  "liveRuns.interval")`). */
function reads(code: DriftFacts["code"], id: string): boolean {
	const quoted = (text: string): RegExp => new RegExp(`["'\`]${text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["'\`]`, "u");
	const splits = id.split(".").map((_, index, parts) => [parts.slice(0, index).join("."), parts.slice(index).join(".")]).filter(([section]) => section !== "");

	return code.some(({ text }) => quoted(id).test(text) || splits.some(([section, rest]) => quoted(section).test(text) && quoted(rest).test(text)));
}

/** The drift between `ledger` and the repository, in the checks' order, then by entry. */
export function drift(ledger: Ledger, facts: DriftFacts): Drift[] {
	const keys = new Set(facts.ways.map((way) => way.key));
	const found: Drift[] = [];
	const present = (entry: LedgerEntry): string[] => [...entry.key !== undefined && keys.has(entry.key) ? [entry.key] : [], ...(entry.paths ?? []).filter((path) => facts.exists(path))];

	for (const [name, entry] of Object.entries(ledger).toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
		const there = present(entry);

		if (entry.status === "stopped" && there.length > 0) {
			found.push({ "check": "stopped but present", "entry": name, "message": `"${name}" was stopped (${entry.since}: ${entry.why}), and ${there.join(", ")} ${there.length === 1 ? "is" : "are"} still there`, "code": "remove it (`silo status` it removed, with where it went)", "decision": "set it active, parked or experiment, with why" });
		}

		if (entry.status === "removed") {
			const named = facts.docs.flatMap(({ file, text }) => (namesOf(entry).some((each) => text.includes(each)) ? [file] : []));

			if (named.length > 0) {
				found.push({ "check": "removed but documented", "entry": name, "message": `"${name}" was removed${entry.in === undefined ? "" : ` (${entry.in})`}, and ${named.join(", ")} still ${named.length === 1 ? "names" : "name"} it`, "code": "take it out of those docs", "decision": "restore it, if the docs are right" });
			}
		}

		if (entry.status === "experiment" && (entry.until === undefined || entry.until < facts.today)) {
			found.push({ "check": "experiment expired", "entry": name, "message": entry.until === undefined ? `"${name}" is an experiment with no end` : `"${name}" was an experiment until ${entry.until}`, "code": "remove it", "decision": "make it active (why it stays), or give it a later `until`" });
		}

		if (entry.status !== "removed" && there.length === 0 && (entry.key !== undefined || (entry.paths ?? []).length > 0)) {
			found.push({ "check": "stale entry", "entry": name, "message": `"${name}" names ${[entry.key, ...entry.paths ?? []].filter((each) => each !== undefined).join(", ")}, and none of it is there`, "code": "nothing: the code went or moved", "decision": "set it removed (it went), or name where it is now" });
		}
	}

	const decided = new Set(Object.values(ledger).flatMap((entry) => (entry.key === undefined ? [] : [entry.key])));

	for (const way of facts.ways.toSorted((left, right) => left.key.localeCompare(right.key))) {
		if (decided.has(way.key)) {
			continue;
		}

		const declaredOnly = (way.facet === "command" || way.facet === "view") && way.sides.includes("declared") && !way.sides.includes("registered");

		if (declaredOnly || (way.facet === "setting" && !reads(facts.code, way.id))) {
			found.push({ "check": "dead end", "message": declaredOnly ? `${way.facet} ${way.id} is declared and never registered` : `setting ${way.id} is declared and its code never reads it`, "code": declaredOnly ? "register it, or take its declaration out" : "read it, or take its declaration out", "decision": `\`silo status\` it (key ${way.key}) with why it stays` });
		}
	}

	return found;
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const today = "2026-10-23";
		const files = new Set(["src/engine/index.ts", "src/old.ts"]);
		const facts: DriftFacts = {
			"today": today,
			"ways": [
				{ "key": "command|tsval.explore", "facet": "command", "id": "tsval.explore", "sides": ["declared", "registered"] },
				{ "key": "command|ghost", "facet": "command", "id": "ghost", "sides": ["declared"] },
				{ "key": "setting|run.liveRuns.interval", "facet": "setting", "id": "run.liveRuns.interval", "sides": [] },
				{ "key": "setting|run.unread", "facet": "setting", "id": "run.unread", "sides": [] }
			],
			"exists": (path) => files.has(path) || [...files].some((file) => file.startsWith(path + "/")),
			"docs": [{ "file": "RUNNING.md", "text": "Run with Inputs (editor.runWithInputs) went." }, { "file": "README.md", "text": "nothing here" }],
			"code": [{ "file": "src/live.ts", "text": "vscode.workspace.getConfiguration(\"run\").get(\"liveRuns.interval\", 5)" }]
		};
		let ledger: Ledger = {};

		ledger = withStatus(ledger, "capability engine", "stopped", "records move into the run ledger first", today, { "paths": ["src/engine"] });
		ledger = withStatus(ledger, "Run with Inputs", "removed", "the margin's Mock replaced it", today, { "key": "command|editor.runWithInputs", "in": "9482074" });
		ledger = withStatus(ledger, "explore", "experiment", "agents exploring orderings", today, { "key": "command|tsval.explore", "until": "2026-10-01" });
		ledger = withStatus(ledger, "gone", "parked", "later", today, { "paths": ["src/nowhere.ts"] });

		assert.deepEqual(drift(ledger, facts).map((each) => [each.check, each.entry ?? each.message]), [
			["removed but documented", "Run with Inputs"],
			["stopped but present", "capability engine"],
			["experiment expired", "explore"],
			["stale entry", "gone"],
			["dead end", "command ghost is declared and never registered"],
			["dead end", "setting run.unread is declared and its code never reads it"]
		]);
		// (the order: entries by name, each's checks; then dead ends by key)
		assert.deepEqual(drift(ledger, facts).map((each) => each.entry ?? each.check), ["Run with Inputs", "capability engine", "explore", "gone", "dead end", "dead end"]);
		// A decision names a dead end: it's no longer one.
		assert.equal(drift(withStatus(ledger, "ghost", "active", "a command for agents only", today, { "key": "command|ghost" }), facts).filter((each) => each.message.includes("ghost")).length, 0);
		// `since` stays while the status does; the written ledger is sorted and stable.
		assert.equal(withStatus(ledger, "gone", "parked", "later still", "2026-11-01")["gone"].since, today);
		assert.equal(withStatus(ledger, "gone", "stopped", "no", "2026-11-01")["gone"].since, "2026-11-01");
		assert.deepEqual(Object.keys(parseLedger(ledgerText(ledger))), ["Run with Inputs", "capability engine", "explore", "gone"]);
		assert.throws(() => withStatus({}, "x", "experiment", "try", today), /until/u);
		assert.throws(() => withStatus({}, "x", "maybe" as LedgerStatus, "?", today), /isn't a status/u);
		assert.deepEqual(parseLedger("not json"), {});
	})();
}
