/**
 * silo — derived history (pure, browser-portable): what changed in a program, told from its code's snapshots alone.
 * No commit message is read and nothing is kept by hand; every fact is computed and every sentence is a fixed template
 * over one (editor's packages/editor/CHANGE-HISTORY.md).
 *
 * `replay` walks a series of snapshots — a git history, or the editor's edit bursts — and yields, for each one, the
 * events since the one before it, over the program's features (`./features`):
 *
 *   added · removed · moved (its files changed, it didn't) · relabeled · sides (declared / implemented) ·
 *   changed (its own code changed — the registration and its inline handler — or a declaration it reaches did: what
 *   its code uses, and theirs in turn, in the program's declaration graph (`./graph`); in the AST, so comments and
 *   whitespace never count, and a declaration that only moved isn't a change)
 *
 * `narrate` turns a span of those into sentences grouped by area: what a person or an agent can reach first, a
 * program's internal plumbing folded into one line per area, a removal and an addition of the same kind with the same
 * label in one snapshot told as a rename, a feature added and removed within the span told as tried, and a change to a
 * declaration many features reach told once, as that declaration's, not as a change to each of them.
 *
 * Reading the snapshots (git, isomorphic-git, a working tree) is the caller's: `./git-snapshots` is the Node one.
 *
 * Live, too: `LiveHistory` takes the same steps as code is edited — each edit burst a one-file change to the program —
 * and what a burst changed is kept as a FACT, a line in the person's `.silo/history/<user>.jsonl` (`../layout`). The
 * bursts themselves aren't needed once their facts are; the facts are what git can't give: the work between commits,
 * the tries that were undone before any commit. `withFacts` tells a git history and the facts as one.
 */

import type { Exercise } from "./exercise";
import type { Feature, WayIn } from "./features";
import type { Analyzer, DeclarationGraph } from "./graph";
import { isEntry } from "@brianjenkins94/util/env";
import { shortHash } from "@brianjenkins94/util/hash";
import { featuresOf, INTERNAL_FACETS, isManifest } from "./features";
import { changedDeclarations, reachers } from "./graph";

/** One version of the program: its files, each by the id of its content (a git blob id, a hash). */
export interface Snapshot {
	"id": string;
	/** ISO 8601. */
	"date": string;
	"files": { "path": string; "oid": string }[];
}

export type HistoryEvent = { "key": string; "facet": string; "id": string } & (
	| { "type": "added"; "label": string; "files": string[] }
	| { "type": "removed"; "label": string; "files": string[] }
	| { "type": "moved"; "from": string[]; "to": string[] }
	| { "type": "relabeled"; "from": string; "to": string; "file": string }
	| { "type": "sides"; "from": string; "to": string; "file": string }
	// Its registration (and inline handler) changed, or a declaration it reaches did (`file`, `declaration`).
	| { "type": "changed"; "file": string; "via": "registration" }
	| { "type": "changed"; "file": string; "via": "reach"; "declaration": string }
	// What runs say of it (`./exercise`), when that changes: its code ran — how many runs, when last — or its file ran and
	// its code didn't. Only facts carry these: a git history has no runs.
	| { "type": "exercised"; "file": string; "runs": number; "lastAt": string }
	| { "type": "dormant"; "file": string }
);

/** What happened between one snapshot and the one before it. */
export interface Step {
	"snapshot": string;
	"date": string;
	"features": number;
	"events": HistoryEvent[];
}

export interface ReplayOptions {
	/** Which files to read (default: sources and manifests outside build output, vendored code, tests and fixtures). */
	"include"?: (path: string) => boolean;
	/** What reads each snapshot: its ways in and declaration graph — oxc's (`./oxc`) or TypeScript's (`./ts-analysis`).
	 *  The caller's choice, so this module loads neither. */
	"analyzer": Analyzer;
}

const SKIP = /(?:^|\/)(?:dist|vendor|demo|test|tests|fixtures|node_modules|docs|bench|scripts|patches)\/|^\.[^/]+\//u;

export const includeByDefault = (path: string): boolean => !SKIP.test(path) && !/\.test\.[cm]?[jt]sx?$/u.test(path) && (isManifest(path) || /\.[cm]?[jt]sx?$/u.test(path));

/** Whether its declaration and its implementation exist: `declared`, `registered`, both, or neither (""). */
const sidesOf = (feature: Feature): string => feature.sides.filter((side) => side === "declared" || side === "registered").sort().join("+");

/**
 * Replays snapshots one at a time, oldest first: each step's events since the one before it. Each file version is read
 * and analyzed once. What `replay` (a series of snapshots, a git history) and `LiveHistory` (edits as they're made) run on.
 */
export class Replayer {
	readonly #read: (oid: string) => Promise<string>;
	readonly #include: (path: string) => boolean;
	readonly #analyzer: Analyzer;
	#previous: Map<string, Feature> | undefined;
	#previousGraph: DeclarationGraph | undefined;

	constructor(read: (oid: string) => Promise<string>, options: ReplayOptions) {
		this.#read = read;
		this.#include = options.include ?? includeByDefault;
		this.#analyzer = options.analyzer;
	}

	/** The next snapshot's events since the last one (none for the first: it has nothing to compare with). */
	async step(snapshot: Snapshot): Promise<Step> {
		const read = this.#read;
		const include = this.#include;
		const analyzer = this.#analyzer;
		const previous = this.#previous;
		const previousGraph = this.#previousGraph;

		const files = new Map(snapshot.files.filter((file) => include(file.path)).map((file) => [file.path, file.oid]));
		const { "graph": program, ways } = await analyzer.analyze(files, read);
		const features = featuresOf([...files.keys()].map((path) => ({ "file": path, "ways": ways.get(path) ?? [] })));
		const events: HistoryEvent[] = [];

		if (previous !== undefined && previousGraph !== undefined) {
			const reached = reachers(program, changedDeclarations(previousGraph, program));

			for (const [key, feature] of features) {
				const was = previous.get(key);
				const base = { "key": key, "facet": feature.facet, "id": feature.id };

				if (was === undefined) {
					events.push({ ...base, "type": "added", "label": feature.label, "files": feature.files });
					continue;
				}

				if (feature.files.join() !== was.files.join()) {
					events.push({ ...base, "type": "moved", "from": was.files, "to": feature.files });
				}

				if (feature.label !== was.label && feature.label !== "" && was.label !== "") {
					events.push({ ...base, "type": "relabeled", "from": was.label, "to": feature.label, "file": feature.files[0] ?? "" });
				}

				if (sidesOf(feature) !== sidesOf(was)) {
					events.push({ ...base, "type": "sides", "from": sidesOf(was), "to": sidesOf(feature), "file": feature.files[0] ?? "" });
				}

				if (feature.code.length > 0 && feature.code.join("\u0001") !== was.code.join("\u0001")) {
					events.push({ ...base, "type": "changed", "file": feature.files[0] ?? "", "via": "registration" });
				} else {
					// The first root that reaches a changed declaration, and which one.
					const changed = feature.roots.map((root) => reached.get(root)).find((target) => target !== undefined);

					if (changed !== undefined) {
						const hash = changed.lastIndexOf("#");

						events.push({ ...base, "type": "changed", "file": changed.slice(0, hash), "via": "reach", "declaration": changed.slice(hash + 1) });
					}
				}
			}

			for (const [key, was] of previous) {
				if (!features.has(key)) {
					events.push({ "key": key, "facet": was.facet, "id": was.id, "type": "removed", "label": was.label, "files": was.files });
				}
			}
		}

		this.#previous = features;
		this.#previousGraph = program;

		return { "snapshot": snapshot.id, "date": snapshot.date, "features": features.size, "events": events };
	}
}

/** Replay snapshots, oldest first, yielding each one's events. Each file version is read and analyzed once. */
export async function *replay(snapshots: AsyncIterable<Snapshot> | Iterable<Snapshot>, read: (oid: string) => Promise<string>, options: ReplayOptions): AsyncGenerator<Step> {
	const replayer = new Replayer(read, options);

	for await (const snapshot of snapshots) {
		yield await replayer.step(snapshot);
	}
}

// ── live ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** What one edit burst changed: when, in which file, and the events it made (a line of `.silo/history/<user>.jsonl`). */
export interface HistoryFact {
	/** ISO 8601. */
	"time": string;
	"file": string;
	/** How many features the program had after it. */
	"features": number;
	"events": HistoryEvent[];
}

/**
 * History as the code is edited: starts from a snapshot (HEAD's files) and takes each edit — a file's new text, or its
 * removal — as the next snapshot, one file different. Each `edit` answers its step, and the fact to keep when it made
 * any events. Edits' texts are kept by content, so `read` is only asked for the starting snapshot's files.
 */
export class LiveHistory {
	readonly #replayer: Replayer;
	readonly #texts: Map<string, string>;
	readonly #files: Map<string, string>;
	#next = 0;

	private constructor(replayer: Replayer, texts: Map<string, string>, files: Map<string, string>) {
		this.#replayer = replayer;
		this.#texts = texts;
		this.#files = files;
	}

	/** Start from `base` (the program as committed): its step makes no events. */
	static async start(base: Snapshot, read: (oid: string) => Promise<string>, options: ReplayOptions): Promise<LiveHistory> {
		const texts = new Map<string, string>();
		const replayer = new Replayer(async (oid) => texts.get(oid) ?? read(oid), options);

		await replayer.step(base);

		return new LiveHistory(replayer, texts, new Map(base.files.map((file) => [file.path, file.oid])));
	}

	/** The program after `file` became `text` (undefined: removed), at `time`: its step, and the fact if it made events. */
	async edit(file: string, text: string | undefined, time: Date | string = new Date()): Promise<{ "step": Step; "fact"?: HistoryFact }> {
		if (text === undefined) {
			this.#files.delete(file);
		} else {
			const oid = "text:" + await shortHash(text);

			this.#texts.set(oid, text);
			this.#files.set(file, oid);
		}

		const date = typeof time === "string" ? time : time.toISOString();
		const step = await this.#replayer.step({ "id": "edit:" + String(this.#next += 1), "date": date, "files": [...this.#files].map(([path, oid]) => ({ "path": path, "oid": oid })) });

		return step.events.length === 0 ? { "step": step } : { "step": step, "fact": { "time": date, "file": file, "features": step.features, "events": step.events } };
	}
}

/** What changed in what runs say of the features (`./exercise`): an event for each that became exercised, or dormant. A
 *  feature no run has reached yet (unobserved) makes none. */
export function exerciseEvents(features: ReadonlyMap<string, Feature>, before: ReadonlyMap<string, Exercise>, now: ReadonlyMap<string, Exercise>): HistoryEvent[] {
	const events: HistoryEvent[] = [];

	for (const [key, exercise] of now) {
		const feature = features.get(key);

		if (feature === undefined || exercise.status === before.get(key)?.status) {
			continue;
		}

		const base = { "key": key, "facet": feature.facet, "id": feature.id, "file": feature.files[0] ?? "" };

		if (exercise.status === "exercised") {
			events.push({ ...base, "type": "exercised", "runs": exercise.runs, "lastAt": exercise.lastAt });
		} else if (exercise.status === "dormant") {
			events.push({ ...base, "type": "dormant" });
		}
	}

	return events;
}

/** A fact as its line of a `.jsonl` file. */
export const factLine = (fact: HistoryFact): string => JSON.stringify(fact) + "\n";

/** The facts in a `.jsonl` file's text (a line that isn't one is skipped: a merge may have left half of one). */
export function parseFacts(text: string): HistoryFact[] {
	return text.split("\n").flatMap((line) => {
		try {
			const fact = JSON.parse(line) as HistoryFact;

			return typeof fact?.time === "string" && Array.isArray(fact.events) ? [fact] : [];
		} catch {
			return [];
		}
	});
}

/**
 * A git history's steps and the facts edits left, as one history, by time. A commit whose span (since the commit before
 * it) has facts is told by them — the work as it was done, tries included — and adds only what none of them explains (an
 * edit made outside the editor). Facts after the last commit are the work not committed yet. Facts before the first step
 * belong to the history before the span.
 */
export function withFacts(steps: Step[], facts: HistoryFact[]): Step[] {
	const sorted = [...facts].sort((left, right) => left.time.localeCompare(right.time));
	const asStep = (fact: HistoryFact): Step => ({ "snapshot": "edit:" + fact.time, "date": fact.time, "features": fact.features, "events": fact.events });
	const told: Step[] = [];
	let index = 0;

	// Before the first step: the span's baseline, and facts that came before it.
	while (index < sorted.length && steps[0] !== undefined && sorted[index]!.time <= steps[0].date) {
		index += 1;
	}

	for (const [position, step] of steps.entries()) {
		if (position === 0) {
			told.push(step);
			continue;
		}

		const span: HistoryFact[] = [];

		while (index < sorted.length && sorted[index]!.time <= step.date) {
			span.push(sorted[index]!);
			index += 1;
		}

		if (span.length === 0) {
			told.push(step);
			continue;
		}

		const explained = new Set(span.flatMap((fact) => fact.events.map((event) => event.key)));

		told.push(...span.map(asStep), { ...step, "events": step.events.filter((event) => !explained.has(event.key)) });
	}

	told.push(...sorted.slice(index).map(asStep));

	return told;
}

// ── telling it ───────────────────────────────────────────────────────────────────────────────────────────────

/** Which part of the program a file belongs to: an extension by its name, otherwise its package or top folder. */
export function areaOf(file: string): string {
	const extension = /(?:^|\/)extensions\/([^/]+)\//u.exec(file);

	if (extension !== null) {
		return "extension " + extension[1];
	}

	const parts = file.split("/");

	return parts[0] === "packages" || parts[0] === "components" ? parts[1] ?? parts[0] : parts.length > 1 ? parts[0] : "root";
}

export interface NarrateOptions {
	/** The area a file belongs to (default `areaOf`). */
	"area"?: (file: string) => string;
}

/** An area's sentences: what a person or an agent reaches, then one line for its plumbing. */
export interface Section {
	"area": string;
	"lines": string[];
}

/** A declaration whose change reaches this many features in one snapshot is told as its own change (see `narrate`). */
export const SHARED = 5;

const NOUNS: Record<string, string> = { "hub request": "hub request", "hub subscription": "hub subscription", "core module": "core module", "agent tool": "agent tool", "url parameter": "URL parameter", "cli command": "CLI command" };
const noun = (facet: string): string => NOUNS[facet] ?? facet;
const named = (event: { "facet": string; "id": string }): string => `${noun(event.facet)} \`${event.id === "" ? "(unnamed)" : event.id}\``;
const day = (step: Step): string => step.date.slice(0, 10);
const dirOf = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf("/"))) || ".";
const fileOf = (event: HistoryEvent): string => ("files" in event ? event.files[0] : "to" in event && Array.isArray(event.to) ? event.to[0] : "file" in event ? event.file : undefined) ?? "";

/** A label's first clause, cut at a word. */
export function shortLabel(label: string): string {
	const first = label.split(/\.\s| — /u)[0];

	return first.length <= 70 ? first : first.slice(0, 70).replace(/\s+\S*$/u, "") + "…";
}

/** `files.read`, `files.write` → `files.{read,write}`. */
export function foldIds(ids: string[]): string {
	const groups = new Map<string, string[]>();

	for (const id of ids) {
		const dot = id.lastIndexOf(".");
		const [head, tail] = dot > 0 ? [id.slice(0, dot), id.slice(dot + 1)] : ["", id];
		const tails = groups.get(head) ?? [];

		if (!tails.includes(tail)) {
			tails.push(tail);
		}

		groups.set(head, tails);
	}

	return [...groups].map(([head, tails]) => "`" + (head === "" ? "" : head + ".") + (tails.length > 1 ? "{" + tails.join(",") + "}" : tails[0]) + "`").join(", ");
}

/** In one step, a removal and an addition of the same kind with the same label (or the same last name) is a rename. */
export function renamesIn(step: Step): { "from": HistoryEvent & { "type": "removed" }; "to": HistoryEvent & { "type": "added" } }[] {
	const added = step.events.filter((event): event is HistoryEvent & { "type": "added" } => event.type === "added");
	const pairs: { "from": HistoryEvent & { "type": "removed" }; "to": HistoryEvent & { "type": "added" } }[] = [];

	for (const removed of step.events) {
		if (removed.type !== "removed") {
			continue;
		}

		const lastName = removed.id.split(".").at(-1) ?? "";
		const match = added.find((candidate) => candidate.facet === removed.facet && !pairs.some((pair) => pair.to === candidate) && ((removed.label !== "" && candidate.label === removed.label) || (lastName.length > 3 && candidate.id.split(".").at(-1) === lastName)));

		if (match !== undefined) {
			pairs.push({ "from": removed, "to": match });
		}
	}

	return pairs;
}

/** What a change in a feature's sides means: implemented, declared, or one of them gone. */
function sidesSentence(event: HistoryEvent & { "type": "sides" }): string {
	if (event.to.includes("registered") && !event.from.includes("registered")) {
		return `${named(event)} is now implemented.`;
	}

	if (event.to.includes("declared") && !event.from.includes("declared")) {
		return `${named(event)} is now declared.`;
	}

	return event.to.includes("registered") ? `${named(event)} is no longer declared.` : `${named(event)} is declared but no longer implemented.`;
}

/** Where each feature lives at the end of a span of steps (its last added or moved-to file). */
function latestFiles(steps: Step[]): Map<string, string> {
	const latest = new Map<string, string>();

	for (const step of steps) {
		for (const event of step.events) {
			const file = event.type === "added" || event.type === "removed" ? event.files[0] : event.type === "moved" ? event.to[0] : undefined;

			if (file !== undefined) {
				latest.set(event.key, file);
			}
		}
	}

	return latest;
}

/** A span of steps as sentences, by area, the busiest first. */
export function narrate(steps: Step[], options: NarrateOptions = {}): Section[] {
	// A feature is told under the area it lives in at the end of the span, so a moved folder doesn't split an area.
	const latest = latestFiles(steps);
	const areaOfFile = options.area ?? areaOf;
	const area = (file: string, key?: string): string => areaOfFile((key === undefined ? undefined : latest.get(key)) ?? file);
	const sections = new Map<string, { "lines": [number, string][]; "added": string[]; "removed": string[]; "changed": string[] }>();
	const section = (name: string): { "lines": [number, string][]; "added": string[]; "removed": string[]; "changed": string[] } => {
		let found = sections.get(name);

		if (found === undefined) {
			found = { "lines": [], "added": [], "removed": [], "changed": [] };
			sections.set(name, found);
		}

		return found;
	};

	const say = (file: string, order: number, text: string, key?: string): void => {
		section(area(file, key)).lines.push([order, text]);
	};

	const added = new Map<string, { "event": HistoryEvent & { "type": "added" }; "when": string; "gone"?: string }>();
	const removed = new Map<string, { "event": HistoryEvent & { "type": "removed" }; "when": string }>();
	const changed = new Map<string, { "event": HistoryEvent; "times": number; "days": Set<string> }>();
	const shared = new Map<string, { "file": string; "name": string; "features": number; "times": number; "days": Set<string> }>();
	const moves = new Map<string, HistoryEvent[]>();
	const ran = new Map<string, { "event": HistoryEvent & { "type": "exercised" | "dormant" }; "when": string }>();

	for (const step of steps) {
		const renamed = new Set<HistoryEvent>();
		// How many features each declaration's change reached in this snapshot.
		const reach = new Map<string, number>();

		for (const event of step.events) {
			if (event.type === "changed" && event.via === "reach") {
				reach.set(event.file + "#" + event.declaration, (reach.get(event.file + "#" + event.declaration) ?? 0) + 1);
			}
		}

		for (const [id, features] of reach) {
			if (features >= SHARED) {
				const entry = shared.get(id) ?? { "file": id.slice(0, id.lastIndexOf("#")), "name": id.slice(id.lastIndexOf("#") + 1), "features": 0, "times": 0, "days": new Set<string>() };

				entry.features = Math.max(entry.features, features);
				entry.times += 1;
				entry.days.add(day(step));
				shared.set(id, entry);
			}
		}

		for (const { from, to } of renamesIn(step)) {
			renamed.add(from).add(to);

			if (!INTERNAL_FACETS.has(to.facet)) {
				say(fileOf(to), 3, `Renamed ${noun(to.facet)} \`${from.id}\` → \`${to.id}\` (${day(step)}).`, to.key);
			}
		}

		for (const event of step.events) {
			if (renamed.has(event)) {
				continue;
			}

			switch (event.type) {
				case "added":
					added.set(event.key, { "event": event, "when": day(step) });
					break;
				case "removed": {
					const earlier = added.get(event.key);

					if (earlier !== undefined) {
						earlier.gone = day(step);
					} else {
						removed.set(event.key, { "event": event, "when": day(step) });
					}

					break;
				}

				case "changed": {
					if (event.via === "reach" && (reach.get(event.file + "#" + event.declaration) ?? 0) >= SHARED) {
						break; // told once, as the declaration's
					}

					const entry = changed.get(event.key) ?? { "event": event, "times": 0, "days": new Set<string>() };

					entry.times += 1;
					entry.days.add(day(step));
					changed.set(event.key, entry);
					break;
				}

				case "moved":
					if (dirOf(event.from[0] ?? "") !== dirOf(event.to[0] ?? "")) {
						const route = dirOf(event.from[0] ?? "") + " → " + dirOf(event.to[0] ?? "");

						moves.set(route, [...moves.get(route) ?? [], event]);
					}

					break;
				case "relabeled":
					if (!INTERNAL_FACETS.has(event.facet)) {
						say(event.file, 3, `Retitled ${named(event)}: “${shortLabel(event.from)}” → “${shortLabel(event.to)}”.`, event.key);
					}

					break;
				case "sides":
					say(event.file, 4, sidesSentence(event), event.key);
					break;
				case "exercised":
				case "dormant":
					// What runs last said of it, in the span.
					ran.set(event.key, { "event": event, "when": day(step) });
					break;
				default:
					break;
			}
		}
	}

	for (const { event, when, gone } of added.values()) {
		if (INTERNAL_FACETS.has(event.facet)) {
			if (gone === undefined) {
				section(area(fileOf(event), event.key)).added.push(event.id);
			}

			continue;
		}

		const label = event.label === "" ? "" : shortLabel(event.label);

		say(fileOf(event), 0, gone === undefined ? `Added ${named(event)}${label === "" ? "" : ": " + label} (${when}).` : `Tried ${named(event)}${label === "" ? "" : " (" + label + ")"}: added ${when}, removed ${gone}.`, event.key);
	}

	for (const { event, when } of removed.values()) {
		if (INTERNAL_FACETS.has(event.facet)) {
			section(area(fileOf(event), event.key)).removed.push(event.id);
		} else {
			say(fileOf(event), 1, `Removed ${named(event)}${event.label === "" ? "" : " (" + shortLabel(event.label) + ")"} (${when}).`, event.key);
		}
	}

	for (const { event, times, days } of changed.values()) {
		if (added.has(event.key)) {
			continue;
		}

		if (INTERNAL_FACETS.has(event.facet)) {
			section(area(fileOf(event), event.key)).changed.push(event.id);
		} else {
			say(fileOf(event), 2, `Changed ${named(event)}${times > 1 ? `: ${times} times over ${days.size} day${days.size > 1 ? "s" : ""}` : ""}.`, event.key);
		}
	}

	for (const { file, name, features, times, days } of shared.values()) {
		const what = name === "(top)" ? `\`${file.slice(file.lastIndexOf("/") + 1)}\`'s top level` : `\`${name}\``;

		say(file, 2, `Changed ${what}, which ${features} features use${times > 1 ? `: ${times} times over ${days.size} day${days.size > 1 ? "s" : ""}` : ""}.`);
	}

	for (const { event, when } of ran.values()) {
		if (INTERNAL_FACETS.has(event.facet) && event.type === "exercised") {
			continue; // plumbing running is no news
		}

		say(event.file, 6, event.type === "exercised" ? `Ran ${named(event)} (${when}${event.runs > 1 ? `, in ${String(event.runs)} runs` : ""}).` : `Dormant: ${named(event)} — its file ran, its code didn't (${when}).`, event.key);
	}

	for (const [route, events] of moves) {
		say(fileOf(events[0]), 5, events.length > 3 ? `Moved ${events.length} features: ${route}.` : events.map((event) => `Moved ${named(event)}: ${route}.`).join(" "), events[0].key);
	}

	const weight = (entry: { "lines": unknown[]; "added": unknown[]; "removed": unknown[]; "changed": unknown[] }): number => entry.lines.length + (entry.added.length + entry.removed.length + entry.changed.length) / 4;

	return [...sections].filter(([, entry]) => weight(entry) > 0).sort((left, right) => weight(right[1]) - weight(left[1]) || left[0].localeCompare(right[0])).map(([name, entry]) => {
		const counted = new Map<string, [number, number]>();

		for (const [order, text] of entry.lines.sort((left, right) => left[0] - right[0])) {
			counted.set(text, [order, (counted.get(text)?.[1] ?? 0) + 1]);
		}

		const lines = [...counted].map(([text, [, count]]) => text + (count > 1 ? ` (×${count})` : ""));
		const plumbing = [entry.added.length > 0 && "added " + foldIds(entry.added), entry.removed.length > 0 && "removed " + foldIds(entry.removed), entry.changed.length > 0 && "changed " + foldIds(entry.changed)].filter(Boolean);

		if (plumbing.length > 0) {
			lines.push("Plumbing: " + plumbing.join("; ") + ".");
		}

		return { "area": name, "lines": lines };
	});
}

/** Features that appeared and later went away, grouped by the step that removed them. */
export function tried(steps: Step[], options: NarrateOptions = {}): { "removed": string; "area": string; "features": { "facet": string; "id": string; "added": string }[] }[] {
	const area = options.area ?? areaOf;
	const addedAt = new Map<string, string>();
	const groups: { "removed": string; "area": string; "features": { "facet": string; "id": string; "added": string }[] }[] = [];

	for (const step of steps) {
		const renamed = new Set(renamesIn(step).map((pair) => pair.from));
		const removals = step.events.filter((event) => event.type === "removed" && addedAt.has(event.key) && !renamed.has(event));

		if (removals.length > 0) {
			groups.push({ "removed": day(step), "area": area(fileOf(removals[0])), "features": removals.map((event) => ({ "facet": event.facet, "id": event.id, "added": addedAt.get(event.key) })) });
		}

		for (const event of step.events) {
			if (event.type === "added") {
				addedAt.set(event.key, day(step));
			}
		}
	}

	return groups;
}

/** A program's features as a markdown document, by area: what a person or an agent reaches, then its plumbing. */
export function featuresMarkdown(features: Iterable<Feature>, options: NarrateOptions & { "title"?: string } = {}): string {
	const area = options.area ?? areaOf;
	const byArea = new Map<string, Feature[]>();
	let count = 0;

	for (const feature of features) {
		const name = area(feature.files[0] ?? "");

		byArea.set(name, [...byArea.get(name) ?? [], feature]);
		count += 1;
	}

	const outward = (list: Feature[]): Feature[] => list.filter((feature) => !INTERNAL_FACETS.has(feature.facet));
	const areas = [...byArea].sort((left, right) => outward(right[1]).length - outward(left[1]).length || left[0].localeCompare(right[0]));

	return [
		`# ${options.title ?? "Features"}`,
		"",
		`${count} way${count === 1 ? "" : "s"} in, in ${byArea.size} area${byArea.size === 1 ? "" : "s"}. Found in the code; nothing here is kept by hand.`,
		"",
		...areas.flatMap(([name, list]) => {
			const internal = list.filter((feature) => INTERNAL_FACETS.has(feature.facet)).map((feature) => feature.id);
			const lines = outward(list).sort((left, right) => left.facet.localeCompare(right.facet) || left.id.localeCompare(right.id)).map((feature) => `- ${named(feature)}${feature.label === "" ? "" : ": " + shortLabel(feature.label)}`);

			return [`## ${name}`, "", ...lines, ...internal.length > 0 ? [`- Plumbing: ${foldIds(internal.sort())}.`] : [], ""];
		})
	].join("\n");
}

/** A span's history as a markdown document. */
export function historyMarkdown(steps: Step[], options: NarrateOptions & { "title"?: string } = {}): string {
	const first = steps[0]; const
		last = steps.at(-1);
	const sections = narrate(steps, options);
	const experiments = tried(steps, options);

	return [
		`# ${options.title ?? "History"}`,
		"",
		first === undefined ? "Nothing in this span." : `${steps.length} snapshot${steps.length === 1 ? "" : "s"}, ${day(first)} to ${day(last)}; ${last.features} features at the end. Derived from the code alone.`,
		"",
		...sections.flatMap((section) => [`## ${section.area}`, "", ...section.lines.map((line) => "- " + line), ""]),
		...experiments.length === 0 ? [] : ["## Tried and removed", "", ...experiments.map((group) => `- **${group.removed}** (${group.area}): ${group.features.slice(0, 8).map((feature) => named(feature) + (feature.added === group.removed ? "" : " from " + feature.added)).join(", ")}${group.features.length > 8 ? `, and ${group.features.length - 8} more` : ""}.`), ""]
	].join("\n");
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// oxc's reading, for the tests: this module loads no analyzer itself. (A specifier made at run time, so a bundler
		// of this module doesn't follow it into oxc: the tests only run here.)
		const { fileFingerprint, oxcAnalyzer, waysIn }: typeof import("./oxc") = await import(/* @vite-ignore */ ["./oxc"].join(""));

		// Snapshots in memory: each file's content is its own id.
		const blobs = new Map<string, string>();
		let next = 0;

		function snapshot(date: string, files: Record<string, string>): Snapshot {
			return {
				"id": "s" + (next += 1),
				"date": date + "T00:00:00Z",
				"files": Object.entries(files).map(([path, text]) => {
					const oid = "oid" + blobs.size;

					blobs.set(oid, text);

					return { "path": path, "oid": oid };
				})
			};
		}

		const read = async (oid: string): Promise<string> => blobs.get(oid);

		async function run(snapshots: Snapshot[]): Promise<Step[]> {
			const steps: Step[] = [];

			for await (const step of replay(snapshots, read, { "analyzer": oxcAnalyzer() })) {
				steps.push(step);
			}

			return steps;
		}

		const manifest = JSON.stringify({ "contributes": { "commands": [{ "command": "notes.add", "title": "Add Note", "category": "Notes" }], "menus": { "editor/context": [{ "command": "notes.add" }] }, "configuration": { "properties": { "notes.enabled": { "description": "Whether notes show. More." } } } } });
		const extension = (handler: string): string => `import * as vscode from "vscode";\nexport function activate() {\n\tvscode.commands.registerCommand("notes.add", () => { ${handler} });\n\tserve(hub, "files.read", () => 1);\n\tserve(hub, "files.write", () => 2);\n}\n`;

		// A command declared in a manifest and registered in code is one feature, with both sides and its menu.
		const features = featuresOf([{ "file": "ext/package.json", "ways": waysIn("ext/package.json", manifest) }, { "file": "ext/extension.ts", "ways": waysIn("ext/extension.ts", extension("add();")) }]);
		const command = features.get("command|notes.add");

		assert.deepEqual(command.sides.sort(), ["declared", "menu:editor/context", "registered"]);
		assert.equal(command.label, "Notes: Add Note", "the declaration's label");
		assert.deepEqual(command.files, ["ext/extension.ts"], "implemented in code, not the manifest");
		assert.equal(features.get("setting|notes.enabled")?.label, "Whether notes show");
		assert.equal(features.get("hub request|files.read")?.facet, "hub request");

		// Buttons, URL parameters, terminal commands, agent tools, core modules.
		const shell = waysIn("shell.tsx", `import { installPreview } from "./preview";\ninstallPreview();\nconst p = new URLSearchParams(location.search).get("pane");\nconst a = <wa-button aria-label="Run" onClick={run} />;\nconst b = <wa-button title="History" />;\ndefineCommand("node", run);\nconst tool = { "name": "files_read", "description": "Read a file. Numbered.", "handler": read };\n`);

		assert.deepEqual(shell.map((way) => way.facet + " " + way.id + (way.label === "" ? "" : " · " + way.label)).sort(), ["agent tool files_read · Read a file", "button History · no handler", "button Run", "core module installPreview", "terminal command node", "url parameter ?pane"]);

		// A hub name made at run time is keyed by how it's written.
		const interpolated = ["`virtual.debug.$", "{port}`"].join("");

		assert.deepEqual(waysIn("w.ts", `serve(hub, ${interpolated}, () => 1);\nhub.subscribe(controlSubject(SESSION), () => 0);\nserve(app, port, () => 1);\n`).map((way) => way.facet + " " + way.id), ["hub request " + interpolated, "hub subscription controlSubject(SESSION)"]);

		// A worker's message listener, at its top level — not one inside a function.
		assert.deepEqual(waysIn("worker.ts", "import { run } from \"./run\";\naddEventListener(\"message\", (event) => run(event.data));\nfunction later() { addEventListener(\"message\", () => 0); }\n").map((way) => way.facet + " " + way.roots.join(",")), ["worker worker.ts#run"]);

		// Any literal fingerprints, a BigInt too; equal code, equal prints, whatever its spacing.
		assert.equal(fileFingerprint("a.ts", "const n = 10n;"), fileFingerprint("a.ts", "const  n=10n ; // ten"));
		assert.notEqual(fileFingerprint("a.ts", "const n = 10n;"), fileFingerprint("a.ts", "const n = 11n;"));

		// The history: added, a comment-only edit (no change), a handler edit (changed), a move, a rename, a removal.
		const steps = await run([
			snapshot("2026-10-01", { "README.md": "hi" }),
			snapshot("2026-10-02", { "ext/package.json": manifest, "ext/extension.ts": extension("add();") }),
			snapshot("2026-10-03", { "ext/package.json": manifest, "ext/extension.ts": extension("add(); /* a comment only */") }),
			snapshot("2026-10-04", { "ext/package.json": manifest, "ext/extension.ts": extension("add(1);") }),
			snapshot("2026-10-05", { "ext/package.json": manifest, "src/notes/extension.ts": extension("add(1);") }),
			snapshot("2026-10-06", { "ext/package.json": manifest.replace("notes.enabled", "notes.visible"), "src/notes/extension.ts": extension("add(1);") }),
			snapshot("2026-10-07", { "ext/package.json": manifest.replace("notes.enabled", "notes.visible"), "src/notes/extension.ts": extension("add(1);").replace(`serve(hub, "files.write", () => 2);`, "") })
		]);
		const types = (step: Step): string[] => step.events.map((event) => event.type + " " + event.id).sort();

		assert.deepEqual(steps[0].events, [], "the first snapshot has nothing to compare with");
		assert.deepEqual(types(steps[1]), ["added files.read", "added files.write", "added notes.add", "added notes.enabled"]);
		assert.deepEqual(types(steps[2]), [], "a comment is not a change");
		assert.deepEqual(types(steps[3]), ["changed notes.add"], "the handler changed; the other registrations didn't");
		assert.deepEqual(types(steps[4]), ["moved files.read", "moved files.write", "moved notes.add"], "a move, not a removal and an addition");
		assert.deepEqual(types(steps[5]), ["added notes.visible", "removed notes.enabled"]);
		assert.deepEqual(types(steps[6]), ["removed files.write"]);

		// Reach: a change anywhere a feature's code leads is a change to it — through a local of the function it's
		// registered in, an import, a re-export, a namespace — and a move, or a change to code it doesn't reach, isn't.
		const commands = (body: string): string => `import * as vscode from "vscode";\nimport { makeRunner } from "./runner.js";\nexport function activate() {\n\tconst runner = makeRunner();\n\tvscode.commands.registerCommand("run.go", () => runner.go());\n\tvscode.commands.registerCommand("run.other", () => ${body});\n}\n`;
		const runner = (go: string): string => `import * as text from "./text";\nexport function makeRunner() { return { "go": () => text.shout(${go}) }; }\nexport function unused() { return 1; }\n`;
		const reached = await run([
			snapshot("2026-10-08", { "x/extension.ts": commands("0"), "x/runner.ts": runner("\"a\""), "x/text.ts": "export { shout } from \"./shout\";\n", "x/shout.ts": "export const shout = (s: string) => s + \"!\";\n" }),
			snapshot("2026-10-09", { "x/extension.ts": commands("0"), "x/runner.ts": runner("\"b\""), "x/text.ts": "export { shout } from \"./shout\";\n", "x/shout.ts": "export const shout = (s: string) => s + \"!\";\n" }),
			snapshot("2026-10-10", { "x/extension.ts": commands("0"), "x/runner.ts": runner("\"b\""), "x/text.ts": "export { shout } from \"./shout\";\n", "x/shout.ts": "export const shout = (s: string) => s + \"?\";\n" }),
			snapshot("2026-10-11", { "x/extension.ts": commands("0"), "x/runner.ts": runner("\"b\"").replace("return 1", "return 2"), "x/text.ts": "export { shout } from \"./say\";\n", "x/say.ts": "export const shout = (s: string) => s + \"?\";\n" })
		]);
		const changes = (step: Step): string[] => step.events.map((event) => event.type + " " + event.id + (event.type === "changed" && event.via === "reach" ? " via " + event.file + "#" + event.declaration : "")).sort();

		assert.deepEqual(changes(reached[1]), ["changed run.go via x/runner.ts#makeRunner"], "through the local it's made from; run.other reaches none of it");
		assert.deepEqual(changes(reached[2]), ["changed run.go via x/shout.ts#shout"], "through a namespace import and a re-export");
		assert.deepEqual(changes(reached[3]), [], "a move isn't a change, nor is a change to code no feature reaches");

		// A change many features reach is told once, as that declaration's.
		const many = (body: string): string => `import { helper } from "./helper";\nexport function activate() {\n${[1, 2, 3, 4, 5].map((n) => `\tvscode.commands.registerCommand("c${n}", () => helper());`).join("\n")}\n}\n`;
		const wide = await run([
			snapshot("2026-10-12", { "y/extension.ts": many(""), "y/helper.ts": "export const helper = () => 1;\n" }),
			snapshot("2026-10-13", { "y/extension.ts": many(""), "y/helper.ts": "export const helper = () => 2;\n" })
		]);

		assert.deepEqual(narrate(wide.slice(1)).flatMap((section) => section.lines), ["Changed `helper`, which 5 features use."]);

		// Told: a rename by its label, plumbing folded, a feature added and removed within the span as tried.
		const told = narrate(steps.slice(1)).flatMap((section) => section.lines);

		assert.ok(told.includes("Renamed setting `notes.enabled` → `notes.visible` (2026-10-06)."), told.join("\n"));
		assert.ok(told.includes("Added command `notes.add`: Notes: Add Note (2026-10-02)."), told.join("\n"));
		assert.ok(narrate(steps.slice(3)).flatMap((section) => section.lines).includes("Changed command `notes.add`."), "a change to a feature that existed before the span");
		assert.ok(!told.some((line) => line.startsWith("Changed command")), "a feature added within the span is told as added, not also changed");
		assert.ok(told.includes("Plumbing: added `files.read`."), "plumbing in one line; files.write came and went within the span");
		assert.deepEqual(tried(steps).map((group) => group.features.map((feature) => feature.id)), [["files.write"]]);
		assert.equal(foldIds(["files.read", "files.write", "shell.run"]), "`files.{read,write}`, `shell.run`");
		assert.match(historyMarkdown(steps.slice(1), { "title": "Notes" }), /^# Notes\n\n6 snapshots, 2026-10-02 to 2026-10-07/u);

		// Live: edits as they're made. A command added and taken out again before any commit is a try git never saw; a
		// burst that changes nothing about the features leaves no fact.
		const base = snapshot("2026-10-20", { "z/extension.ts": "export function activate() {}\n" });
		const live = await LiveHistory.start(base, read, { "analyzer": oxcAnalyzer() });
		const added = await live.edit("z/extension.ts", "export function activate() {\n\tvscode.commands.registerCommand(\"z.try\", () => 1);\n}\n", "2026-10-20T10:00:00Z");
		const quiet = await live.edit("z/extension.ts", "export function activate() {\n\tvscode.commands.registerCommand(\"z.try\", () => 1); // a comment\n}\n", "2026-10-20T10:01:00Z");
		const undone = await live.edit("z/extension.ts", "export function activate() {}\n", "2026-10-20T10:02:00Z");

		assert.deepEqual(added.fact?.events.map((event) => event.type + " " + event.id), ["added z.try"]);
		assert.equal(quiet.fact, undefined, "a comment changes nothing: no fact");
		assert.deepEqual(parseFacts(factLine(undone.fact!) + "half a li"), [undone.fact], "a fact's line reads back; a broken line is skipped");

		// Told with the commits: a commit with facts in its span is told by them; facts after the last commit are the work
		// not committed yet.
		const commits: Step[] = [
			{ "snapshot": "c1", "date": "2026-10-19T00:00:00Z", "features": 0, "events": [] },
			{ "snapshot": "c2", "date": "2026-10-20T12:00:00Z", "features": 1, "events": [{ "key": "command|z.kept", "facet": "command", "id": "z.kept", "type": "added", "label": "", "files": ["z/extension.ts"] }, { "key": "command|z.outside", "facet": "command", "id": "z.outside", "type": "added", "label": "", "files": ["z/other.ts"] }] }
		];
		const keptFact: HistoryFact = { "time": "2026-10-20T11:00:00Z", "file": "z/extension.ts", "features": 1, "events": [{ "key": "command|z.kept", "facet": "command", "id": "z.kept", "type": "added", "label": "", "files": ["z/extension.ts"] }] };
		const later: HistoryFact = { ...keptFact, "time": "2026-10-21T09:00:00Z", "events": [{ "key": "command|z.kept", "facet": "command", "id": "z.kept", "type": "changed", "file": "z/extension.ts", "via": "registration" }] };
		const merged = withFacts(commits, [later, added.fact!, undone.fact!, keptFact]);

		assert.deepEqual(merged.map((step) => step.snapshot + ": " + step.events.map((event) => event.type + " " + event.id).join(", ")), [
			"c1: ",
			"edit:2026-10-20T10:00:00Z: added z.try",
			"edit:2026-10-20T10:02:00Z: removed z.try",
			"edit:2026-10-20T11:00:00Z: added z.kept",
			"c2: added z.outside",
			"edit:2026-10-21T09:00:00Z: changed z.kept"
		], "the facts tell the commit's span; the commit adds what they don't explain");
		assert.deepEqual(tried(merged).map((group) => group.features.map((feature) => feature.id)), [["z.try"]], "a try no commit saw");

		// What runs say, as events when it changes: a feature whose code ran, and one whose file ran without it.
		const ranFeatures = featuresOf([{ "file": "r/extension.ts", "ways": [{ "facet": "command", "id": "r.used", "label": "", "roots": [] }, { "facet": "command", "id": "r.idle", "label": "", "roots": [] }] }]);
		const nowRan = new Map([["command|r.used", { "status": "exercised" as const, "runs": 3, "lastAt": "2026-10-12T10:00:00Z" }], ["command|r.idle", { "status": "dormant" as const, "files": ["r/extension.ts"] }]]);
		const ranEvents = exerciseEvents(ranFeatures, new Map(), nowRan);

		assert.deepEqual(ranEvents.map((event) => event.type + " " + event.id), ["exercised r.used", "dormant r.idle"]);
		assert.deepEqual(exerciseEvents(ranFeatures, nowRan, nowRan), [], "no change, no event");
		assert.deepEqual(narrate([{ "snapshot": "edit:1", "date": "2026-10-12T10:00:00Z", "features": 2, "events": ranEvents }]).flatMap((section) => section.lines), ["Ran command `r.used` (2026-10-12, in 3 runs).", "Dormant: command `r.idle` — its file ran, its code didn't (2026-10-12)."]);

		// The features as a document: by area, plumbing folded.
		const document = featuresMarkdown(features.values(), { "title": "Notes" });

		assert.match(document, /^# Notes\n\n4 ways in, in 1 area/u);
		assert.ok(document.includes("- command `notes.add`: Notes: Add Note") && document.includes("- Plumbing: `files.{read,write}`."), document);
	})();
}
