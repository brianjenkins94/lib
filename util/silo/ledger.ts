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
 *   unowned file             a code file no entry owns: none's `paths` hold it, and it isn't a test one names (decision
 *                            22: owned by declaration, not inferred). Tests, scripts and vendored code are code too.
 *   owned twice              a code file two entries' `paths` hold: one owner a file is where attribution starts, until
 *                            coverage from runs and traces says how to handle sharing (a test may be named by more)
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
	/** A declared feature's (decision 21): what it's for, where it's told, its ways in, and
	 *  the tests it owns, beside the paths it owns. */
	"what"?: string;
	"docs"?: string;
	"ways"?: string[];
	"tests"?: string[];
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
	/** The repository's code files, from the root (`isOwnedCode`), each held to an owner. None: no file is held to one. */
	"owned"?: { "files": string[] };
}

export type DriftCheck = "stopped but present" | "removed but documented" | "experiment expired" | "dead end" | "stale entry" | "lease expired"
	// (declared features': declaredDrift)
	| "unplaced way in" | "gone way in" | "placed twice" | "missing path" | "empty feature"
	// (decision 22)
	| "unowned file" | "owned twice";

export interface Drift {
	"check": DriftCheck;
	/** The entry it's about (none for a dead end the ledger doesn't name). */
	"entry"?: string;
	"message": string;
	/** The two ways out: change the code, or change the decision. */
	"code": string;
	"decision": string;
}

/** Whether a file of the repository is code a feature must own: anything that runs or type-checks, tests, scripts and
 *  vendored code among it (decision 22); not what's installed or built, nor a tool's dot-folder. */
export function isOwnedCode(file: string): boolean {
	return /\.[cm]?[jt]sx?$/u.test(file) && !/(?:^|\/)(?:node_modules|dist)\/|(?:^|\/)\.[^/]+\//u.test(file);
}

/** Whether `file` is `path` or under it (a folder: `path` with or without its `/`). */
function holds(path: string, file: string): boolean {
	const bare = path.replace(/\/+$/u, "");

	return file === bare || file.startsWith(bare + "/");
}

/** The code files in `facts.owned` no live entry owns (by `paths`, or naming it a test), and those two
 *  entries' `paths` both hold: by file. */
function ownership(ledger: Ledger, owned: NonNullable<DriftFacts["owned"]>): Drift[] {
	const live = Object.entries(ledger).filter(([, entry]) => entry.status !== "removed");
	const found: Drift[] = [];

	for (const file of owned.files.toSorted()) {
		const owners = live.filter(([, entry]) => (entry.paths ?? []).some((path) => holds(path, file))).map(([name]) => name).toSorted();
		const tested = live.some(([, entry]) => (entry.tests ?? []).some((path) => holds(path, file)));

		if (owners.length === 0 && !tested) {
			found.push({ "check": "unowned file", "message": `${file} is owned by no feature`, "code": "delete it, if nothing needs it", "decision": "name it in the `paths` of the feature it's part of (or the `tests` of the one it tests), or declare a feature for it" });
		} else if (owners.length > 1) {
			found.push({ "check": "owned twice", "entry": owners[0], "message": `${file} is owned by ${owners.map((name) => `"${name}"`).join(" and ")}`, "code": "split it, so each part is one feature's", "decision": "take it out of all but one of their `paths`" });
		}
	}

	return found;
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
	// (a declared feature's fields too — what, docs, ways, tests: a field not listed here is dropped when it's written)
	const order: (keyof LedgerEntry)[] = ["status", "why", "since", "until", "what", "docs", "key", "ways", "paths", "tests", "in", "restore"];
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

	return facts.owned === undefined ? found : [...found, ...ownership(ledger, facts.owned)];
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

/** Whose a file is, by declaration: the live entries whose `paths` hold it, or that name it a test. One attribution of code
 *  to features, whatever runs show (decision 22): what's observed is compared with this, it doesn't stand in for it. */
export function ownersOf(ledger: Ledger, file: string): string[] {
	const live = Object.entries(ledger).filter(([, entry]) => entry.status !== "removed" && entry.status !== "stopped");
	const owners = live.filter(([, entry]) => (entry.paths ?? []).some((path) => holds(path, file))).map(([name]) => name);

	return owners.length > 0 ? owners : live.filter(([, entry]) => (entry.tests ?? []).some((path) => holds(path, file))).map(([name]) => name);
}

/** A feature as the ledger declares it, with its name. */
export type Declared = [string, Pick<LedgerEntry, "what" | "docs" | "ways" | "paths" | "tests">];

/** The features the ledger declares that own code now: an entry with any of `what`, `ways` and `tests`, not removed or
 *  stopped. Any other entry is a decision about code, not a feature's declaration. */
export function declaredFeatures(ledger: Ledger): Declared[] {
	return Object.entries(ledger).filter(([, entry]) => (entry.what !== undefined || entry.ways !== undefined || entry.tests !== undefined) && entry.status !== "removed" && entry.status !== "stopped");
}

/** The declared features' drift from the code, their own first, then the ways in none owns (decision 21: the ledger's are
 *  the source of truth). A repository that declares none isn't held to them.
 *   unplaced way in    a way in no feature owns: new code, or one missed
 *   gone way in        a feature owns a key that isn't found: the code went, moved or was renamed
 *   placed twice       a key two features own
 *   missing path       a feature's path or test that isn't there
 *   empty feature      one that owns no way in and no path: nothing says what it is */
export function declaredDrift(ledger: Ledger, facts: Pick<DriftFacts, "ways" | "exists">): Drift[] {
	const declared = declaredFeatures(ledger);
	const found: Drift[] = [];
	const keys = new Set(facts.ways.map((way) => way.key));
	const owners = new Map<string, string[]>();

	if (declared.length === 0) {
		return [];
	}

	for (const [name, feature] of declared) {
		const where = `"${name}"`;

		for (const key of feature.ways ?? []) {
			owners.set(key, [...owners.get(key) ?? [], where]);

			if (!keys.has(key)) {
				found.push({ "check": "gone way in", "entry": name, "message": `${where} owns ${key}, and no way in has that key`, "code": "nothing: it went, moved or was renamed", "decision": "take it out of the feature, or put the key it has now" });
			}
		}

		for (const path of [...feature.paths ?? [], ...feature.tests ?? []]) {
			if (!facts.exists(path)) {
				found.push({ "check": "missing path", "entry": name, "message": `${where} names ${path}, and it isn't there`, "code": "nothing: it went or moved", "decision": "take it out of the feature, or name where it is now" });
			}
		}

		if ((feature.ways ?? []).length === 0 && (feature.paths ?? []).length === 0) {
			found.push({ "check": "empty feature", "entry": name, "message": `${where} owns no way in and no path`, "code": "nothing", "decision": "give it its ways in or its own files, or take it out" });
		}
	}

	for (const [key, those] of owners) {
		if (those.length > 1) {
			found.push({ "check": "placed twice", "message": `${key} is owned by ${those.join(" and ")}`, "code": "nothing", "decision": "keep it in the one it serves" });
		}
	}

	for (const way of facts.ways.toSorted((left, right) => left.key.localeCompare(right.key))) {
		if (!owners.has(way.key)) {
			found.push({ "check": "unplaced way in", "message": `${way.facet} ${way.id || way.key} is in no feature of the ledger (key ${way.key})`, "code": "take it out, if nothing needs it", "decision": "put its key in the `ways` of the feature it serves (.silo/features.json), or in a new one" });
		}
	}

	return found;
}

/** The ledger with a removal taken out of the other live features declaring what it took (the change passes its own
 *  `silo check`): the `keys`, and the `paths` and what's in them, out of their `ways`, `paths` and `tests`. One left owning
 *  nothing went with it: removed too, saying so. */
export function withoutRemoved(ledger: Ledger, name: string, keys: string[], paths: string[], today: string): Ledger {
	const gone = (path: string): boolean => paths.some((each) => path === each || path.startsWith(each.replace(/\/+$/u, "") + "/"));
	let kept = ledger;

	for (const [other, entry] of declaredFeatures(ledger) as [string, LedgerEntry][]) {
		const ways = (entry.ways ?? []).filter((key) => !keys.includes(key));
		const owned = (entry.paths ?? []).filter((path) => !gone(path));
		const tests = (entry.tests ?? []).filter((path) => !gone(path));

		if (other !== name && (ways.length !== (entry.ways ?? []).length || owned.length !== (entry.paths ?? []).length || tests.length !== (entry.tests ?? []).length)) {
			const narrowed: LedgerEntry = { ...entry, ...entry.ways === undefined ? {} : { "ways": ways }, ...entry.paths === undefined ? {} : { "paths": owned }, ...entry.tests === undefined ? {} : { "tests": tests } };

			kept = ways.length === 0 && owned.length === 0 ? withStatus({ ...kept, [other]: entry }, other, "removed", `went with "${name}": it owned nothing else`, today) : { ...kept, [other]: narrowed };
		}
	}

	return kept;
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
	const ledger = nothing ? ledgerText(input.ledger) : ledgerText(withStatus(withoutRemoved(input.ledger, name, key === undefined ? [] : [key], [...paths, ...price.files], input.today), name, "removed", input.why || entry?.why || "removed", input.today, { ...key === undefined ? {} : { "key": key }, "paths": [...new Set([...paths, ...price.files])], ...restore === undefined ? {} : { "restore": restore } }));

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
		// Ownership (decision 22): every code file is one feature's, or a test one names.
		const owning = withStatus(withStatus(withStatus({}, "engine", "active", "core", today, { "paths": ["src/engine"] }), "both", "active", "core", today, { "paths": ["src/engine/index.ts"] }), "gone", "removed", "out", today, { "paths": ["src/old.ts"] });
		const tested: Ledger = { ...owning, "engine": { ...owning["engine"], "tests": ["test/engine.test.ts"] } };
		const owned = { "files": ["src/engine/index.ts", "src/engine/run.ts", "src/old.ts", "test/engine.test.ts"] };

		assert.deepEqual(drift(tested, { ...facts, "ways": [], "owned": owned }).filter((each) => each.check === "unowned file" || each.check === "owned twice").map((each) => [each.check, each.message]), [
			["owned twice", "src/engine/index.ts is owned by \"both\" and \"engine\""],
			["unowned file", "src/old.ts is owned by no feature"]
		]);
		// What's installed, built or a tool's isn't code to own.
		assert.deepEqual(["src/a.ts", "test/a.test.mjs", "pkg/vendor/x.js", "a.d.ts", "src/a.css", "node_modules/x/i.js", "pkg/dist/i.js", ".refs/main/a.ts", ".github/x.mjs"].filter(isOwnedCode), ["src/a.ts", "test/a.test.mjs", "pkg/vendor/x.js", "a.d.ts"]);
		// (a removed entry owns nothing; a test named is owned)
		assert.deepEqual(drift(owning, { ...facts, "ways": [], "owned": { ...owned, "files": ["test/engine.test.ts"] } }).map((each) => each.message), ["test/engine.test.ts is owned by no feature"]);
		// Whose a file is: by its paths, a test by who names it, nobody's when removed or undeclared.
		assert.deepEqual(ownersOf(tested, "src/engine/run.ts"), ["engine"]);
		assert.deepEqual(ownersOf(tested, "src/engine/index.ts").toSorted(), ["both", "engine"]);
		assert.deepEqual(ownersOf(tested, "test/engine.test.ts"), ["engine"]);
		assert.deepEqual(ownersOf(tested, "src/old.ts"), []);
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
		// Declared features: their ways placed, their paths and tests checked, a key two own placed twice; a removed one owns
		// nothing, an entry that's only a decision isn't a feature, and a repository declaring none isn't held to them.
		const declaring: Ledger = {
			"Notes on code": { "status": "active", "why": "w", "since": today, "what": "Notes.", "ways": ["command|notes.add", "hub request|git.commit"], "paths": ["src/git"], "tests": ["test/notes.test.ts"] },
			"Commit": { "status": "active", "why": "w", "since": today, "what": "Commit.", "ways": ["hub request|git.commit", "command|commit.gone"] },
			"Pull": { "status": "active", "why": "w", "since": today, "what": "Pull." },
			"Old notes": { "status": "removed", "why": "w", "since": today, "ways": ["command|fresh"] },
			"a decision": { "status": "parked", "why": "w", "since": today, "paths": ["src/elsewhere"] }
		};
		const declaredWays: FoundWay[] = [
			{ "key": "command|notes.add", "facet": "command", "id": "notes.add", "sides": ["declared", "registered"] },
			{ "key": "hub request|git.commit", "facet": "hub request", "id": "git.commit", "sides": [] },
			{ "key": "command|fresh", "facet": "command", "id": "fresh", "sides": ["registered"] }
		];

		assert.deepEqual(declaredFeatures(declaring).map(([name]) => name), ["Notes on code", "Commit", "Pull"]);
		assert.deepEqual(declaredDrift(declaring, { "ways": declaredWays, "exists": (path) => path === "src/git" }).map((each) => [each.check, each.entry ?? each.message]), [
			["missing path", "Notes on code"],
			["gone way in", "Commit"],
			["empty feature", "Pull"],
			["placed twice", "hub request|git.commit is owned by \"Notes on code\" and \"Commit\""],
			["unplaced way in", "command fresh is in no feature of the ledger (key command|fresh)"]
		]);
		assert.deepEqual(declaredDrift({ "a decision": declaring["a decision"]! }, { "ways": declaredWays, "exists": () => false }), []);
		// A removal out of what else declares it: narrowed, or removed too when it owned nothing else; tests by what they're in.
		const narrowed = withoutRemoved({
			"Gone": { "status": "active", "why": "w", "since": today, "what": "G.", "ways": ["view|a"], "paths": ["src/a.ts"] },
			"Kept": { "status": "active", "why": "w", "since": today, "what": "K.", "ways": ["view|a", "command|b"], "paths": ["src/z/index.ts", "src/k.ts"], "tests": ["src/z/z.test.ts"] },
			"Only": { "status": "active", "why": "w", "since": today, "what": "O.", "paths": ["src/z"] },
			"Else": { "status": "active", "why": "w", "since": today, "what": "E.", "ways": ["command|e"] },
			"Tombstone": { "status": "removed", "why": "w", "since": today, "ways": ["view|a"] }
		}, "Gone", ["view|a"], ["src/a.ts", "src/z"], "2026-12-01");

		assert.deepEqual(narrowed["Gone"]?.ways, ["view|a"]);
		assert.deepEqual([narrowed["Kept"]?.ways, narrowed["Kept"]?.paths, narrowed["Kept"]?.tests], [["command|b"], ["src/k.ts"], []]);
		assert.deepEqual([narrowed["Only"]?.status, narrowed["Only"]?.why, narrowed["Only"]?.since], ["removed", "went with \"Gone\": it owned nothing else", "2026-12-01"]);
		assert.deepEqual(narrowed["Else"]?.ways, ["command|e"]);
		assert.deepEqual(narrowed["Tombstone"]?.ways, ["view|a"]);
	})();
}
