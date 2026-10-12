import type { Snapshot, Step } from "./history";
import { strict as assert } from "node:assert";
import { featuresOf, fileFingerprint, waysIn } from "./features";
import { featuresMarkdown, foldIds, historyMarkdown, narrate, replay, tried } from "./history";

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

	for await (const step of replay(snapshots, read)) {
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

// The features as a document: by area, plumbing folded.
const document = featuresMarkdown(features.values(), { "title": "Notes" });

assert.match(document, /^# Notes\n\n4 ways in, in 1 area/u);
assert.ok(document.includes("- command `notes.add`: Notes: Add Note") && document.includes("- Plumbing: `files.{read,write}`."), document);
