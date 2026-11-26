/**
 * silo — derived history (pure, browser-portable): what changed in a program, told from its code's snapshots alone.
 * No commit message is read and nothing is kept by hand; every fact is computed.
 *
 * A `Replayer` takes snapshots one at a time, oldest first — a git history, or the editor's edit bursts — and gives, for
 * each one, the events since the one before it, over the program's features (`./features`):
 *
 *   added · removed · moved (its files changed, it didn't) · relabeled · sides (declared / implemented) ·
 *   changed (its own code changed — the registration and its inline handler — or a declaration it reaches did: what
 *   its code uses, and theirs in turn, in the program's declaration graph (`./graph`); in the AST, so comments and
 *   whitespace never count, and a declaration that only moved isn't a change)
 *
 * Reading the snapshots (git, isomorphic-git, a working tree) is the caller's. The editor replays the program as it's
 * edited (each pause a snapshot); what it finds is for the session: nothing derived from edits is kept.
 */

import type { Feature, WayIn } from "./features";
import type { Analyzer, DeclarationGraph } from "./graph";
import { isEntry } from "@brianjenkins94/util/env";
import { featuresOf, isManifest, waysInManifest } from "./features";
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
	/** What reads each snapshot: its ways in and declaration graph — TypeScript's (`./ts-analysis`, `./typescript`).
	 *  The caller's choice, so this module loads neither. */
	"analyzer": Analyzer;
}

const SKIP = /(?:^|\/)(?:dist|vendor|demo|test|tests|fixtures|node_modules|docs|bench|scripts|patches)\/|^\.[^/]+\//u;

export const includeByDefault = (path: string): boolean => !SKIP.test(path) && !/\.test\.[cm]?[jt]sx?$/u.test(path) && (isManifest(path) || /\.[cm]?[jt]sx?$/u.test(path));

/** Whether its declaration and its implementation exist: `declared`, `registered`, both, or neither (""). */
const sidesOf = (feature: Feature): string => feature.sides.filter((side) => side === "declared" || side === "registered").sort().join("+");

/**
 * Replays snapshots one at a time, oldest first: each step's events since the one before it. Each file version is read
 * and analyzed once: a series of snapshots, a git history, or an editor replaying edits as they're made.
 */
export class Replayer {
	readonly #read: (oid: string) => Promise<string>;
	readonly #include: (path: string) => boolean;
	readonly #analyzer: Analyzer;
	#previous: Map<string, Feature> | undefined;
	#previousGraph: DeclarationGraph | undefined;
	#changed: string[] = [];

	constructor(read: (oid: string) => Promise<string>, options: ReplayOptions) {
		this.#read = read;
		this.#include = options.include ?? includeByDefault;
		this.#analyzer = options.analyzer;
	}

	/** What the last step read: the program's declaration graph and features, and the declarations that changed since the
	 *  step before it — for what joins history with something else without reading it twice. */
	get last(): { "graph": DeclarationGraph; "features": ReadonlyMap<string, Feature>; "changed": readonly string[] } | undefined {
		return this.#previousGraph === undefined || this.#previous === undefined ? undefined : { "graph": this.#previousGraph, "features": this.#previous, "changed": this.#changed };
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

		this.#changed = previousGraph === undefined ? [] : changedDeclarations(previousGraph, program);

		if (previous !== undefined && previousGraph !== undefined) {
			const reached = reachers(program, this.#changed);

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

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// TypeScript's readings, for the tests: this module loads no analyzer itself. A file on its own, by lib's TypeScript;
		// a history, by TypeScript 7.1's analyzer (lib's dev dependency `typescript-7`) over a folder with only a tsconfig.
		// (Specifiers made at run time, so a bundler of this module doesn't follow them: the tests only run here.)
		const { readText }: typeof import("./ts-analysis") = await import(/* @vite-ignore */ ["./ts-analysis"].join(""));
		const { typescriptAnalyzer, typescriptModules }: typeof import("./typescript") = await import(/* @vite-ignore */ ["./typescript"].join(""));
		const ts: typeof import("typescript") = (await import(/* @vite-ignore */ ["typescript"].join(""))).default;
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const waysIn = (file: string, text: string): WayIn[] => (isManifest(file) ? waysInManifest(text) : readText(ts, file, text).ways);
		const top = (file: string, text: string): string => readText(ts, file, text).declarations["(top)"]?.fingerprint ?? "";
		const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "silo-history-")));

		fs.writeFileSync(path.join(folder, "tsconfig.json"), JSON.stringify({ "compilerOptions": { "module": "esnext", "moduleResolution": "bundler", "target": "esnext", "jsx": "preserve", "strict": false } }));

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

			const analyzer = (await typescriptAnalyzer({ "root": folder, "typescript": (await typescriptModules(import.meta.dirname, "typescript-7"))! }))!;

			try {
				const replayer = new Replayer(read, { "analyzer": analyzer });

				for (const each of snapshots) {
					steps.push(await replayer.step(each));
				}
			} finally {
				analyzer.close?.();
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
		assert.equal(top("a.ts", "console.log(10n);"), top("a.ts", "console.log( 10n ) ; // ten"));
		assert.notEqual(top("a.ts", "console.log(10n);"), top("a.ts", "console.log(11n);"));

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
	})();
}
