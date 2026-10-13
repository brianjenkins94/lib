/**
 * silo — run coverage over time, told from git history (pure, browser-portable). A repository's `.silo/` is committed:
 * its runs (`.silo/runs/<user>.jsonl`) and what they observed (`.silo/evidence/<user>/<env>/<file>.jsonl`, each span's
 * `reached` counts folded run by run — `./evidence`). So each commit is a snapshot of what has run, and the difference
 * from the one before is what the runs between them did: a span whose `ever` went up ran; one whose `lastRun` moved but
 * `ever` didn't was in a file those runs reached, and didn't run. A run between two commits is told with the later one;
 * runs between the same two commits are told together.
 *
 * Each declaration's status (ran, or reached and not run) is followed commit to commit, so the story is the changes:
 * a declaration that started running, one that stopped, one reached that never ran. Declarations, not spans: a span's
 * id changes when its code is edited, a declaration keeps its name. Each change is the features' it's in — the ways in
 * whose code reaches it (`./features`, `./graph`): its own when it's a feature's root, shared, or everyone's
 * (infrastructure) — or its folder's, when no feature reaches it; and, when a declaration that leads to it changed in the
 * same interval, that's said too.
 *
 * Where a span is in a text is BABLR's to say (its ids are BABLR span ids) — the caller's `place`, so this module loads
 * no parser: the CLI's is BABLR in Node, the editor's its BABLR worker.
 */

import type { RunEnvelope } from "./evidence";
import type { Feature } from "./features";
import type { Analyzer, DeclarationGraph } from "./graph";
import type { Snapshot } from "./history";
import { isEntry } from "@brianjenkins94/util/env";
import { parseEvidence, parseRuns } from "./evidence.js";
import { reach, TOP } from "./graph.js";
import { areaOf, Replayer, SHARED } from "./history.js";

/** A span of a text, as BABLR names it. */
export interface PlacedSpan { "id": string; "start": number; "end": number }

/** Where each span of `source` (the file `file`) is, or undefined when it can't be told (BABLR's grammar doesn't take it). */
export type PlaceSpans = (source: string, file: string) => Promise<PlacedSpan[] | undefined>;

/** A declaration's status changing between two commits. */
export interface CoverageChange {
	/** `started`: it ran, and before it hadn't (or wasn't known); `stopped`: its file ran, it didn't, and before it had;
	 *  `unreached`: its file ran, it didn't, and that's the first word of it. */
	"kind": "started" | "stopped" | "unreached";
	"file": string;
	/** Its node id (`file#name`, `file#(top)` for a module's own body). */
	"declaration": string;
	/** The features whose code reaches it, by key — none when no feature does (then `area` is all it's told by). */
	"features": string[];
	/** Its own to one feature (a root of it), one feature's, a few's, or everyone's. */
	"share": "own" | "one" | "shared" | "infrastructure" | "none";
	"area": string;
	/** A declaration that changed in the same interval and leads to this one (itself included), when one did. */
	"after"?: string;
}

/** What the runs between one commit and the one before it did. */
export interface CoverageStep {
	"snapshot": string;
	"date": string;
	"runs": Pick<RunEnvelope, "id" | "user" | "title" | "entry" | "endedAt">[];
	"changes": CoverageChange[];
	/** Spans of what ran that couldn't be placed in the commit's code (its text unparsable, or the span's code gone). */
	"unplaced": number;
	/** The features of the commit, by key, for the story's labels. */
	"features": ReadonlyMap<string, Pick<Feature, "facet" | "id" | "label">>;
}

const EVIDENCE = /^\.silo\/evidence\/[^/]+\/[^/]+\/(.+)\.jsonl$/u;
const RUNS = /^\.silo\/runs\/[^/]+\.jsonl$/u;

/**
 * Replays snapshots, oldest first — what `./history`'s Replayer reads of each, and what the runs between each and the
 * one before did. Each file version is read once; each text's spans placed once.
 */
export class CoverageReplayer {
	readonly #read: (oid: string) => Promise<string>;
	readonly #place: PlaceSpans;
	readonly #history: Replayer;
	readonly #status = new Map<string, boolean>();
	readonly #placed = new Map<string, Promise<PlacedSpan[] | undefined>>();
	#evidence = new Map<string, string>();
	#runs = new Set<string>();

	constructor(read: (oid: string) => Promise<string>, options: { "analyzer": Analyzer; "place": PlaceSpans; "include"?: (path: string) => boolean }) {
		this.#read = read;
		this.#place = options.place;
		this.#history = new Replayer(read, { "analyzer": options.analyzer, ...options.include === undefined ? {} : { "include": options.include } });
	}

	async step(snapshot: Snapshot): Promise<CoverageStep> {
		await this.#history.step(snapshot);

		const { graph, features, changed } = this.#history.last ?? { "graph": undefined as never, "features": new Map(), "changed": [] };
		const files = new Map(snapshot.files.map((file) => [file.path, file.oid]));
		const evidence = new Map(snapshot.files.filter((file) => EVIDENCE.test(file.path)).map((file) => [file.path, file.oid]));
		const previous = this.#evidence;

		// The runs this interval brought.
		const runs: CoverageStep["runs"] = [];
		const seen = new Set<string>();

		for (const file of snapshot.files.filter((each) => RUNS.test(each.path))) {
			for (const run of parseRuns(await this.#read(file.oid))) {
				seen.add(run.id);

				if (!this.#runs.has(run.id)) {
					runs.push({ "id": run.id, "user": run.user, "title": run.title, "entry": run.entry, "endedAt": run.endedAt });
				}
			}
		}

		// Each declaration's status this interval, from each evidence file that changed: ran if any of its spans did.
		const now = new Map<string, boolean>();
		let unplaced = 0;

		for (const [path, oid] of evidence) {
			const was = previous.get(path);

			if (was !== oid) {
				const file = EVIDENCE.exec(path)?.[1] ?? path;
				const before = new Map((was === undefined ? [] : parseEvidence(await this.#read(was))).filter((each) => each.kind === "reached").map((each) => [each.span, each]));
				const code = files.get(file);
				const spans = code === undefined ? undefined : await this.#spans(code, file);
				const where = new Map((spans ?? []).map((span) => [span.id, span]));

				for (const observation of parseEvidence(await this.#read(oid)).filter((each) => each.kind === "reached")) {
					const earlier = before.get(observation.span);
					const reported = earlier === undefined || earlier.lastRun !== observation.lastRun;

					if (reported) {
						const span = where.get(observation.span);

						if (span === undefined) {
							unplaced += 1;
						} else {
							const declaration = declarationAt(graph, file, span.start);
							const ran = observation.ever > (earlier?.ever ?? 0);

							now.set(declaration, (now.get(declaration) ?? false) || ran);
						}
					}
				}
			}
		}

		// Each feature's reach, once — only when something changed status.
		const transitions: [string, CoverageChange["kind"]][] = [];

		for (const [declaration, ran] of now) {
			const before = this.#status.get(declaration);

			if (ran && before !== true) {
				transitions.push([declaration, "started"]);
			} else if (!ran && before === true) {
				transitions.push([declaration, "stopped"]);
			} else if (!ran && before === undefined) {
				transitions.push([declaration, "unreached"]);
			}

			this.#status.set(declaration, ran);
		}

		const reaches = transitions.length === 0 ? new Map<string, Set<string>>() : new Map([...features].map(([key, feature]) => [key, reach(graph, feature.roots)]));
		const leadsTo = new Map<string, string>();

		for (const one of changed) {
			for (const reached of reach(graph, [one])) {
				if (!leadsTo.has(reached)) {
					leadsTo.set(reached, one);
				}
			}
		}

		const changes = transitions.map(([declaration, kind]): CoverageChange => {
			const file = declaration.slice(0, declaration.lastIndexOf("#"));
			const reachedBy = [...reaches].filter(([, reached]) => reached.has(declaration)).map(([key]) => key).sort((one, other) => one.localeCompare(other));
			const own = reachedBy.some((key) => features.get(key)?.roots.includes(declaration) === true);
			const after = leadsTo.get(declaration) ?? (changed.includes(declaration) ? declaration : undefined);
			let share: CoverageChange["share"] = "none";

			if (reachedBy.length >= SHARED) {
				share = "infrastructure";
			} else if (reachedBy.length > 1) {
				share = "shared";
			} else if (reachedBy.length === 1) {
				share = own ? "own" : "one";
			}

			return { "kind": kind, "file": file, "declaration": declaration, "features": reachedBy, "share": share, "area": areaOf(file), ...after === undefined ? {} : { "after": after } };
		});

		this.#evidence = evidence;
		this.#runs = seen;

		return { "snapshot": snapshot.id, "date": snapshot.date, "runs": runs, "changes": changes, "unplaced": unplaced, "features": new Map([...features].map(([key, feature]) => [key, { "facet": feature.facet, "id": feature.id, "label": feature.label }])) };
	}

	/** A text's spans, placed once per version. */
	async #spans(oid: string, file: string): Promise<PlacedSpan[] | undefined> {
		if (!this.#placed.has(oid)) {
			this.#placed.set(oid, this.#read(oid).then((source) => this.#place(source, file)));
		}

		return this.#placed.get(oid);
	}
}

/** The declaration of `file` around `offset`: the narrowest whose range holds it, else the module's own body. */
function declarationAt(graph: DeclarationGraph, file: string, offset: number): string {
	let best: { "id": string; "size": number } | undefined;

	for (const id of graph.fingerprints.keys()) {
		const range = id.startsWith(file + "#") ? graph.range?.(id) : undefined;

		if (range !== undefined && range.file === file && range.start <= offset && offset < range.end && (best === undefined || range.end - range.start < best.size)) {
			best = { "id": id, "size": range.end - range.start };
		}
	}

	return best?.id ?? `${file}#${TOP}`;
}

/** Replay snapshots, oldest first, yielding what each interval's runs did. */
export async function *coverageReplay(snapshots: AsyncIterable<Snapshot> | Iterable<Snapshot>, read: (oid: string) => Promise<string>, options: { "analyzer": Analyzer; "place": PlaceSpans; "include"?: (path: string) => boolean }): AsyncGenerator<CoverageStep> {
	const replayer = new CoverageReplayer(read, options);

	for await (const snapshot of snapshots) {
		yield await replayer.step(snapshot);
	}
}

/** The story, as markdown: each commit that brought runs, what they ran, and what started and stopped running — by
 *  feature, a shared declaration once, and what no feature reaches by its folder. */
export function coverageMarkdown(steps: CoverageStep[], options: { "title"?: string } = {}): string {
	const lines = [`# ${options.title ?? "Coverage over time"}`, ""];
	const name = (decl: string): string => "`" + decl.slice(decl.lastIndexOf("/") + 1) + "`";
	const verb: Record<CoverageChange["kind"], string> = { "started": "started running", "stopped": "stopped running", "unreached": "reached, never ran" };

	for (const step of steps.filter((each) => each.runs.length > 0 || each.changes.length > 0)) {
		const who = [...new Set(step.runs.map((run) => `${run.user}: ${run.title}`))];

		lines.push(`## ${step.date.slice(0, 10)} · ${step.snapshot.slice(0, 7)}`, "", `${step.runs.length} run${step.runs.length === 1 ? "" : "s"}${who.length === 0 ? "" : " — " + who.join("; ")}.`, "");

		const groups = new Map<string, CoverageChange[]>();

		for (const change of step.changes) {
			const label = (key: string): string => {
				const feature = step.features.get(key);

				return feature === undefined ? key : `${feature.facet} ${feature.label || feature.id}`;
			};
			let group = change.area;

			if (change.share === "infrastructure") {
				group = "shared by many features";
			} else if (change.features.length > 0) {
				group = change.features.map(label).join(", ");
			}

			groups.set(group, [...groups.get(group) ?? [], change]);
		}

		for (const [group, changes] of [...groups].sort(([one], [other]) => one.localeCompare(other))) {
			const said = (["started", "stopped", "unreached"] as const).flatMap((kind) => {
				const these = changes.filter((change) => change.kind === kind);
				const after = [...new Set(these.flatMap((change) => (change.after === undefined ? [] : [name(change.after)])))];

				return these.length === 0 ? [] : [`${verb[kind]}: ${these.map((change) => name(change.declaration)).join(", ")}${after.length === 0 ? "" : ` (after ${after.join(", ")} changed)`}`];
			});

			lines.push(`- **${group}** — ${said.join("; ")}.`);
		}

		if (step.unplaced > 0) {
			lines.push(`- ${step.unplaced} span${step.unplaced === 1 ? "" : "s"} couldn't be placed in this commit's code.`);
		}

		lines.push("");
	}

	return lines.join("\n");
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const { oxcAnalyzer } = await import(["./oxc"].join(""));
		const blobs = new Map<string, string>();
		const put = (text: string): string => {
			const oid = "oid" + blobs.size;

			blobs.set(oid, text);

			return oid;
		};
		const read = async (oid: string): Promise<string> => blobs.get(oid) ?? "";
		// Spans: each `/*s:<id>*/` marks a span starting there (standing in for BABLR's ids).
		const place: PlaceSpans = async (source) => [...source.matchAll(/\/\*s:(\w+)\*\//gu)].map((match) => ({ "id": match[1]!, "start": match.index!, "end": match.index! + match[0].length }));
		const app = "import { registerCommand } from \"vscode\";\nregisterCommand(\"app.go\", () => go());\nfunction go() { /*s:g*/ helper(); }\nfunction helper() { /*s:h*/ return 1; }\nfunction unused() { /*s:u*/ }\n";
		const observed = (spans: Record<string, { "ever": number; "lastRun": string }>): string => Object.entries(spans).map(([span, { ever, lastRun }]) => JSON.stringify({ "span": span, "key": "bablr1", "kind": "reached", "w": ever, "runs": 1, "ever": ever, "lastRun": lastRun, "lastAt": "2026-10-01T00:00:00.000Z" })).join("\n") + "\n";
		const envelope = (id: string): string => JSON.stringify({ "type": "run", "id": id, "title": "node app.js", "entry": "app.js", "cwd": ".", "startedAt": "2026-10-01T00:00:00.000Z", "endedAt": "2026-10-01T00:00:00.000Z", "exit": 0, "user": "ada", "environment": { "runtime": "tsval", "engine": "node-24", "os": "macos", "cores": 8, "name": "default" }, "files": {} });
		const snapshot = (id: string, evidence?: string, runs: string[] = []): Snapshot => ({ "id": id, "date": "2026-10-0" + id + "T00:00:00Z", "files": [{ "path": "app.js", "oid": put(app) }, ...evidence === undefined ? [] : [{ "path": ".silo/evidence/ada/env/app.js.jsonl", "oid": put(evidence) }], ...runs.length === 0 ? [] : [{ "path": ".silo/runs/ada.jsonl", "oid": put(runs.join("\n") + "\n") }]] });

		const steps: CoverageStep[] = [];

		for await (const step of coverageReplay([
			snapshot("1"),
			// A run: go and helper ran, unused didn't.
			snapshot("2", observed({ "g": { "ever": 1, "lastRun": "r1" }, "h": { "ever": 1, "lastRun": "r1" }, "u": { "ever": 0, "lastRun": "r1" } }), [envelope("r1")]),
			// Another: go ran, helper didn't.
			snapshot("3", observed({ "g": { "ever": 2, "lastRun": "r2" }, "h": { "ever": 1, "lastRun": "r2" }, "u": { "ever": 0, "lastRun": "r2" } }), [envelope("r1"), envelope("r2")]),
			// Nothing ran: nothing to tell.
			snapshot("4", observed({ "g": { "ever": 2, "lastRun": "r2" }, "h": { "ever": 1, "lastRun": "r2" }, "u": { "ever": 0, "lastRun": "r2" } }), [envelope("r1"), envelope("r2")])
		], read, { "analyzer": oxcAnalyzer(), "place": place })) {
			steps.push(step);
		}

		const told = steps.map((step) => step.changes.map((change) => `${change.kind} ${change.declaration} ${change.share}`).sort());

		assert.deepEqual(told[1], ["started app.js#go own", "started app.js#helper one", "unreached app.js#unused none"]);
		assert.deepEqual(told[2], ["stopped app.js#helper one"]);
		assert.deepEqual(told[3], []);
		assert.deepEqual(steps.map((step) => step.runs.map((run) => run.id)), [[], ["r1"], ["r2"], []]);
		assert.match(coverageMarkdown(steps), /stopped running: `app\.js#helper`/u);
	})();
}
