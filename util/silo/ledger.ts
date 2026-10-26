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
 *   lease expired            an active entry kept `until` a date that's passed (a dormant feature kept for a while:
 *                            decide again)
 *
 * And the leases (`dormant`): a way in nobody decided about keeps its place while the runs reach its code; one whose
 * files the runs loaded and whose own code none of them ran is dormant — a suggestion, with its price, to remove it or
 * to keep it a while (active, `until` 90 days on).
 * Each is an error once it's quiet on its repository (the editor's since 2026-10-25: its `silo check` fails on any), and
 * what deleting an entry's feature would free is its price (`./cost`).
 */

import type { Price } from "./cost";
import type { Feature } from "./features";
import type { DeclarationGraph } from "./graph";
import { isEntry } from "@brianjenkins94/util/env";
import { priceOf, priceText } from "./cost";
import { INTERNAL_FACETS, withoutWayIn } from "./features";
import { TOP } from "./graph";
import { includeByDefault } from "./history";

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

export type DriftCheck = "stopped but present" | "removed but documented" | "experiment expired" | "dead end" | "stale entry" | "lease expired";

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

		if (entry.status === "active" && entry.until !== undefined && entry.until < facts.today) {
			found.push({ "check": "lease expired", "entry": name, "message": `"${name}" was kept until ${entry.until} (${entry.why})`, "code": "remove it (`silo remove`)", "decision": "keep it a while longer (a later `until`), or for good (no `until`), with why" });
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

/** What the runs reached: the files they loaded, and the declarations they ran (node ids, `file#name`). */
export interface Reached { "files": ReadonlySet<string>; "declarations": ReadonlySet<string> }

/** A way in, and its own code: the declarations its way in names (node ids, `file#name`). */
export interface WayCode { "key": string; "facet": string; "id": string; "declarations": string[] }

/** The leases run out: the ways in nobody decided about (no entry names their key, nor paths holding their code) whose
 *  files the runs loaded — so they could have run them — and whose own code none of them ran. */
export function dormant(ways: WayCode[], ledger: Ledger, reached: Reached): WayCode[] {
	const keys = new Set(Object.values(ledger).flatMap((entry) => (entry.key === undefined ? [] : [entry.key])));
	const paths = Object.values(ledger).flatMap((entry) => entry.paths ?? []).map((path) => path.replace(/\/+$/u, ""));
	const fileOf = (id: string): string => id.slice(0, id.indexOf("#"));
	const decided = (file: string): boolean => paths.some((path) => file === path || file.startsWith(path + "/"));

	return ways.filter((way) => way.declarations.length > 0 && !keys.has(way.key) && !way.declarations.some((id) => decided(fileOf(id))) && way.declarations.some((id) => reached.files.has(fileOf(id))) && !way.declarations.some((id) => reached.declarations.has(id))).toSorted((left, right) => left.key.localeCompare(right.key));
}

/** Where CI keeps what the editor's architecture suites reached (its test/selection.mjs): the record `dormant` reads. */
export const CI_RECORDS = ".silo/evidence/ci/architecture.json";

/** What CI's records (`CI_RECORDS`'s text) say the runs reached — the files they loaded, the declarations they ran, as
 *  the graph names them (`(top level)` a file's body, `Class.member` its class) — or undefined, with none. */
export function reachedFromRecords(text: string | undefined): Reached | undefined {
	if (text === undefined) {
		return undefined;
	}

	try {
		const { reach } = JSON.parse(text) as { "reach"?: Record<string, Record<string, number[]>> };

		if (reach === undefined) {
			return undefined;
		}

		const declarations = new Set(Object.entries(reach).flatMap(([at, names]) => Object.keys(names).flatMap((name) => name.split(", ").map((each) => `${at}#${each === "(top level)" ? TOP : each.split(".")[0]}`))));

		return { "files": new Set(Object.keys(reach)), "declarations": declarations };
	} catch {
		return undefined;
	}
}

/** Whether a declaration's code runs only when it's called — a function or a class (or a const holding one) — so a run
 *  that never ran it says something: a module's other names run as it loads, which the records can't tell. */
function callable(graph: DeclarationGraph, id: string, textOf: (file: string) => string | undefined): boolean {
	const range = graph.range?.(id);
	const text = range === undefined ? undefined : textOf(range.file)?.slice(range.start, range.end);

	return text !== undefined && /^(?:export\s+)?(?:default\s+)?(?:(?:async\s+)?function\b|(?:abstract\s+)?class\b|(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>))/u.test(text);
}

/** A way in's own code: the declarations it names, an import followed to what it imports — those that run only when
 *  called (none: it can't be judged at this grain, as a handler written inline, inside what registers it). */
export function wayCodeOf(graph: DeclarationGraph, feature: Pick<Feature, "key" | "facet" | "id" | "roots">, textOf: (file: string) => string | undefined): WayCode {
	const resolved = (id: string, seen = new Set<string>()): string[] => {
		if (graph.fingerprints.has(id)) {
			return [id];
		}

		seen.add(id);

		return graph.edges(id).filter((next) => !seen.has(next)).flatMap((next) => resolved(next, seen));
	};

	return { "key": feature.key, "facet": feature.facet, "id": feature.id, "declarations": [...new Set(feature.roots.flatMap((root) => resolved(root)))].filter((id) => callable(graph, id, textOf)) };
}

/** The program's dormant ways in (`dormant`), each with its feature (where it's registered: `ranges`) and its price —
 *  what `silo check` lists, and the editor marks where each is registered. */
export function dormantWays(features: ReadonlyMap<string, Feature>, graph: DeclarationGraph, ledger: Ledger, reached: Reached, textOf: (file: string) => string | undefined): { "way": WayCode; "feature": Feature; "price": Price }[] {
	const roots = [...features.values()].flatMap((feature) => feature.roots);
	const ways = [...features.values()].filter((feature) => !INTERNAL_FACETS.has(feature.facet)).map((feature) => wayCodeOf(graph, feature, textOf));

	return dormant(ways, ledger, reached).map((way) => ({ "way": way, "feature": features.get(way.key)!, "price": priceOf(graph, roots, { "roots": features.get(way.key)?.roots ?? [] }, textOf) }));
}

/** What taking a feature out is (`silo remove`, the editor's Remove): the files only it reaches, to delete; its
 *  manifests without it; the ledger with its tombstone; and what's left by hand — its code in files it shares, where its
 *  way in is stated in code, the docs naming it. `nothing` when there's nothing to take out on its own (its code shares
 *  files, no manifest declares it): then no tombstone either, for what's still there. */
export interface Removal {
	"nothing": boolean;
	"price": Price;
	"files": string[];
	"manifests": { "file": string; "text": string }[];
	"byHand": string[];
	"registrations": string[];
	"docs": string[];
	"ledger": string;
	"restore"?: string;
}

/** Plan taking out `name` — a ledger entry, or a way in's `key` — and/or `paths`, against the program as it is: its
 *  `tracked` files (git's), read by `textOf`, at commit `head` (what restores it). */
export function removalOf(input: { "name": string; "why": string; "key"?: string; "paths": string[]; "ledger": Ledger; "features": ReadonlyMap<string, Feature>; "graph": DeclarationGraph; "tracked": string[]; "textOf": (file: string) => string | undefined; "head": string; "today": string }): Removal {
	const { name, key, paths, features, graph, tracked, textOf } = input;
	const roots = [...features.values()].flatMap((feature) => feature.roots);
	const price = priceOf(graph, roots, { "roots": key === undefined ? [] : features.get(key)?.roots ?? [], "paths": paths }, textOf);
	const whole = new Set(price.files);
	// (its code in a file it shares: what deleting can't do alone)
	const byHand = price.declarations.filter((id) => !whole.has(id.slice(0, id.indexOf("#"))));
	// (and where its way in is stated in code — a registration in a file something else needs too)
	const registrations = [...new Set((key === undefined ? [] : features.get(key)?.ranges ?? []).map((range) => range.file))].filter((file) => !whole.has(file) && !/(^|\/)package\.json$/u.test(file));
	const manifests = key === undefined ? [] : tracked.filter((each) => /(^|\/)package\.json$/u.test(each) && includeByDefault(each)).flatMap((file) => {
		const text = textOf(file);
		const without = text === undefined ? undefined : withoutWayIn(text, key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1));

		return without === undefined ? [] : [{ "file": file, "text": without }];
	});
	const nothing = price.files.length === 0 && manifests.length === 0;
	const restore = price.files.length === 0 ? undefined : `git checkout ${input.head} -- ${price.files.join(" ")}`;
	const named = [key?.slice(key.indexOf("|") + 1), ...paths, ...price.files].filter((each): each is string => each !== undefined && each !== "");
	const docs = tracked.filter((file) => file.endsWith(".md") && named.some((each) => textOf(file)?.includes(each) === true));
	const entry = input.ledger[name];
	const ledger = nothing ? ledgerText(input.ledger) : ledgerText(withStatus(input.ledger, name, "removed", input.why || entry?.why || "removed", input.today, { ...key === undefined ? {} : { "key": key }, "paths": [...new Set([...paths, ...price.files])], ...restore === undefined ? {} : { "restore": restore } }));

	return { "nothing": nothing, "price": price, "files": price.files, "manifests": manifests, "byHand": byHand, "registrations": registrations, "docs": docs, "ledger": ledger, ...restore === undefined ? {} : { "restore": restore } };
}

/** A removal, said: what was taken out and what's left by hand (`silo remove`'s report, the editor's). */
export function removalText(name: string, removal: Removal): string {
	const states = (files: string[]): string => `where ${files.join(", ")} ${files.length === 1 ? "states" : "state"} it`;

	if (removal.nothing) {
		return [`Nothing of "${name}" silo can take out on its own: ${priceText(removal.price)}.`, ...removal.byHand.length === 0 ? [] : [`  by hand (it shares their files): ${removal.byHand.join(", ")}`], ...removal.registrations.length === 0 ? [] : [`  its way in: ${states(removal.registrations)}`], "  then `silo status` it removed, with where it went."].join("\n");
	}

	return [
		`Removed "${name}": ${priceText(removal.price)}.`,
		...removal.files.length === 0 ? [] : [`  deleted: ${removal.files.join(", ")}`],
		...removal.manifests.length === 0 ? [] : [`  taken out of: ${removal.manifests.map((each) => each.file).join(", ")}`],
		...removal.byHand.length === 0 ? [] : [`  to take out by hand (it shares their files): ${removal.byHand.join(", ")}`],
		...removal.registrations.length === 0 ? [] : [`  its way in, to take out by hand: ${states(removal.registrations)}`],
		...removal.docs.length === 0 ? [] : [`  still named in: ${removal.docs.join(", ")}`],
		`  the ledger has its tombstone${removal.restore === undefined ? "" : ` (silo restore "${name}")`}. Nothing's committed: review the change, then commit it.`
	].join("\n");
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
		// A lease: kept until a date — once it's passed, decide again.
		assert.deepEqual(drift(withStatus({}, "export", "active", "kept a while", today, { "paths": ["src/old.ts"], "until": "2026-10-01" }), facts).map((each) => each.check), ["lease expired", "dead end", "dead end"]);
		assert.deepEqual(drift(withStatus({}, "export", "active", "kept a while", today, { "paths": ["src/old.ts"], "until": "2027-01-01" }), facts).map((each) => each.check), ["dead end", "dead end"]);
		// Dormant: its file loaded, its code never ran — not one decided about, nor one whose files never loaded.
		const ways: WayCode[] = [
			{ "key": "command|a.export", "facet": "command", "id": "a.export", "declarations": ["src/a.ts#exportAll"] },
			{ "key": "command|a.open", "facet": "command", "id": "a.open", "declarations": ["src/a.ts#open"] },
			{ "key": "command|b.never", "facet": "command", "id": "b.never", "declarations": ["src/b.ts#never"] },
			{ "key": "command|a.kept", "facet": "command", "id": "a.kept", "declarations": ["src/kept/c.ts#run"] }
		];
		const reached: Reached = { "files": new Set(["src/a.ts", "src/kept/c.ts"]), "declarations": new Set(["src/a.ts#open"]) };

		assert.deepEqual(dormant(ways, withStatus({}, "kept", "active", "for agents", today, { "paths": ["src/kept"] }), reached).map((each) => each.key), ["command|a.export"]);

		// CI's records: the files a test loaded, the declarations it ran — a file's body, a class by its own name.
		const records = reachedFromRecords(JSON.stringify({ "reach": { "src/a.ts": { "(top level), helper": [1], "Box.open": [2] } } }));

		assert.deepEqual([...records!.files], ["src/a.ts"]);
		assert.deepEqual([...records!.declarations].toSorted(), ["src/a.ts#(top)", "src/a.ts#Box", "src/a.ts#helper"]);
		assert.equal(reachedFromRecords("not json"), undefined);
		assert.equal(reachedFromRecords(undefined), undefined);
	})();
}
