/**
 * silo — TypeScript 7's analyzer (Node): a program's ways in and declaration graph read by the compiler itself
 * (`./ts-analysis`, with TypeScript 7's API as its host), in place of oxc's. What a declaration uses is what the checker
 * says each of its names is — an import followed through re-exports and the tsconfig's `paths`, a scope's own local left
 * out, a method call resolved to the declaration that holds the method — so reach follows the program as TypeScript sees
 * it.
 *
 * One compiler process for a whole replay: the first snapshot is a synthetic program over the snapshot's sources (a
 * filesystem layer of their contents over the disk, which still serves `node_modules`), and each later one is an update
 * with a layer of what changed — nothing is checked out. A file is analyzed again only when it, or a file it resolves
 * names into, changed. The program's own packages (a workspace's, by their package.json) resolve to their sources, as in
 * oxc's — not to an installed copy under node_modules.
 *
 * Needs TypeScript ≥ 7.1 (`typescript/sync`) — the analyzed repository's own, so its program is read by its TypeScript:
 * `typescriptAnalyzer` answers undefined without it, so a caller falls back to oxc's (`oxcAnalyzer`). Node ids are the same as oxc's — a file's own names, `file#name` — so a feature's roots
 * (`./features`) name nodes in either graph. Types are left out, as in oxc's: a type changes no behavior.
 */

import type { WayIn } from "./features";
import type { Analyzer } from "./graph";
import type { FileAnalysis, TsHost, TsNode } from "./ts-analysis";
import { createRequire } from "node:module";
import * as url from "node:url";
import { isEntry } from "@brianjenkins94/util/env";
import { isManifest, isSource, waysInManifest } from "./features";
import { candidates, packageOf } from "./graph";
import { analysisOf, analyzeFile, stale } from "./ts-analysis";

/** TypeScript's `sync` and `ast` modules (≥ 7.1), loosely typed: the few calls below. */
export interface TypeScriptModules {
	"sync": { "API": new (options: { "cwd": string }) => any };
	"ast": { "SyntaxKind": Record<string | number, string | number> };
}

export interface TypeScriptAnalyzerOptions {
	/** The repository: snapshot paths are relative to it, and its disk serves what a snapshot doesn't (`node_modules`). */
	"root": string;
	/** The tsconfig whose compiler options build each snapshot's program (default `<root>/tsconfig.json`). */
	"tsconfig"?: string;
	/** TypeScript's modules, when the caller has them (default: the repository's own TypeScript, if it's ≥ 7.1). */
	"typescript"?: TypeScriptModules;
}

const ALIAS = 2_097_152; // SymbolFlags.Alias

/** TypeScript's analyzer, or undefined when no TypeScript ≥ 7.1 is to be had. */
export async function typescriptAnalyzer(options: TypeScriptAnalyzerOptions): Promise<Analyzer | undefined> {
	let ts = options.typescript;

	if (ts === undefined) {
		try {
			// The repository's TypeScript, not whichever one lib was installed beside.
			const resolve = createRequire(options.root.replace(/\/$/u, "") + "/package.json").resolve;

			ts = { "sync": await import(/*! @external */ url.pathToFileURL(resolve("typescript/sync")).href), "ast": await import(/*! @external */ url.pathToFileURL(resolve("typescript/ast")).href) } as TypeScriptModules;
		} catch {
			return undefined;
		}
	}

	if (typeof ts.sync?.API !== "function" || ts.ast?.SyntaxKind === undefined) {
		return undefined;
	}

	const kinds = ts.ast.SyntaxKind;
	const root = options.root.replace(/\/$/u, "");
	const api = new ts.sync.API({ "cwd": root });
	// The program reads the JavaScript sources too, as oxc's does.
	const baseOptions = { ...api.parseConfigFile(options.tsconfig ?? root + "/tsconfig.json").options, "allowJs": true };
	let compilerOptions: Record<string, unknown> = baseOptions;
	let packagesKey = "";

	/** The snapshot's own packages as `paths` (each entry point to its source), beside the tsconfig's own. */
	async function withPackages(files: ReadonlyMap<string, string>, read: (oid: string) => Promise<string>): Promise<void> {
		const manifests = [...files].filter(([path]) => isManifest(path));
		const key = manifests.map(([path, oid]) => path + ":" + oid).join("|");

		if (key === packagesKey) {
			return;
		}

		const paths: Record<string, string[]> = { ...(baseOptions as { "paths"?: Record<string, string[]> }).paths };

		for (const [path, oid] of manifests) {
			const found = packageOf(path, await read(oid));

			for (const [subpath, entry] of Object.entries(found?.exports ?? {})) {
				const name = found!.name + subpath.slice(1);
				const target = candidates((found!.dir === "" ? "" : found!.dir + "/") + "package.json", entry.startsWith(".") ? entry : "./" + entry).find((candidate) => files.has(candidate));

				if (target !== undefined && paths[name] === undefined) {
					paths[name] = [root + "/" + target];
				}
			}
		}

		packagesKey = key;
		compilerOptions = { ...baseOptions, "paths": paths };
	}

	const cache = new Map<string, FileAnalysis>();
	const manifestWays = new Map<string, { "oid": string; "ways": WayIn[] }>();
	let snapshot: any;
	let programId: string | undefined;
	let previous = new Map<string, string>();
	// The compiler canonicalizes paths (lower-cased on a case-insensitive disk): back to the snapshot's own.
	let pathsByKey = new Map<string, string>();
	const relative = (path: string): string | undefined => pathsByKey.get(path.toLowerCase());

	/** TypeScript 7's API as the reading's host: names resolved in batches across the process. */
	function host(project: any): TsHost {
		const checker = project.checker;
		const raw = new Map<number | string, any>();
		const wrap = (symbol: any): { "id": number | string; "alias": boolean } | undefined => {
			if (symbol === undefined) {
				return undefined;
			}

			raw.set(symbol.id, symbol);

			return { "id": symbol.id, "alias": (symbol.flags & ALIAS) !== 0 };
		};

		return {
			"kind": (name) => kinds[name] as number,
			"children": (node, visit) => {
				node["forEachChild"]((child: TsNode) => {
					visit(child);
				});
			},
			"symbols": (nodes) => (checker.getSymbolAtLocation(nodes) as any[]).map(wrap),
			"aliased": (symbol) => {
				try {
					return wrap(checker.getAliasedSymbol(raw.get(symbol.id)));
				} catch {
					return undefined;
				}
			},
			"declaration": (symbol) => {
				const found = raw.get(symbol.id);
				const handle = found?.valueDeclaration ?? found?.declarations?.[0];
				const file = handle === undefined ? undefined : relative(String(handle.path));

				return file === undefined ? undefined : { "file": file, "node": handle.resolve(project) };
			},
			"has": (file) => pathsByKey.has((root + "/" + file).toLowerCase())
		};
	}

	return {
		"analyze": async (files, read) => {
			const sources = new Map([...files].filter(([path]) => isSource(path)));

			pathsByKey = new Map([...sources.keys()].map((path) => [(root + "/" + path).toLowerCase(), path]));

			const changed = [...sources].filter(([path, oid]) => previous.get(path) !== oid).map(([path]) => path);
			const removed = [...previous.keys()].filter((path) => !sources.has(path));
			const layer: Record<string, string> = {};

			for (const path of changed) {
				layer[root + "/" + path] = await read(sources.get(path)!);
			}

			const rootFiles = [...sources.keys()].map((path) => root + "/" + path);

			await withPackages(files, read);

			if (snapshot === undefined) {
				snapshot = api.createSnapshot({ "fileSystem": { "kind": "layer", "files": layer }, "createPrograms": [{ "rootFiles": rootFiles, "compilerOptions": compilerOptions }] });
				programId = snapshot.operation.createdPrograms[0].id;
			} else {
				// A synthetic program reads a changed file again only when it's reconfigured: the layer alone doesn't reach it.
				const next = snapshot.update({
					"fileSystem": { "kind": "layer", "files": layer, ...removed.length === 0 ? {} : { "removedPaths": removed.map((path) => root + "/" + path) } },
					"fileNotifications": { "changed": changed.filter((path) => previous.has(path)).map((path) => root + "/" + path), "created": changed.filter((path) => !previous.has(path)).map((path) => root + "/" + path), "deleted": removed.map((path) => root + "/" + path) },
					"reconfigurePrograms": [{ "id": programId, "rootFiles": rootFiles, "compilerOptions": compilerOptions }]
				});

				snapshot.dispose?.();
				snapshot = next;
			}

			const project = snapshot.getProject(programId);
			const reading = host(project);
			const touched = new Set([...changed, ...removed]);

			for (const path of removed) {
				cache.delete(path);
			}

			for (const [path, oid] of sources) {
				if (stale(cache.get(path), oid, touched)) {
					const file = project.program.getSourceFile(root + "/" + path);

					cache.set(path, file === undefined ? { "version": oid, "ways": [], "declarations": {}, "imports": {}, "namespaces": {}, "modules": [], "dependsOn": [] } : analyzeFile(reading, path, file, await read(oid), oid));
				}
			}

			// A manifest's ways in are its JSON's: read as oxc's are.
			const manifests = new Map<string, WayIn[]>();

			for (const [path, oid] of files) {
				if (isManifest(path)) {
					const known = manifestWays.get(path);
					const ways = known?.oid === oid ? known.ways : waysInManifest(await read(oid));

					manifestWays.set(path, { "oid": oid, "ways": ways });
					manifests.set(path, ways);
				}
			}

			previous = sources;

			return analysisOf(new Map(cache), manifests);
		},
		"close": () => {
			snapshot?.dispose?.();
			api.close();
		}
	};
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const { replay } = await import("./history");

		// A repository with only a tsconfig on disk: every version of its sources comes from the snapshots.
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "silo-typescript-")));

		fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ "compilerOptions": { "module": "esnext", "moduleResolution": "bundler", "target": "esnext", "strict": false } }));

		// A TypeScript ≥ 7.1 to test with: SILO_TYPESCRIPT names its package folder (lib's own is older).
		const from = process.env["SILO_TYPESCRIPT"];
		const analyzer = await typescriptAnalyzer({ "root": root, ...from === undefined ? {} : { "typescript": { "sync": await import(url.pathToFileURL(path.join(from, "dist/api/sync/api.js")).href), "ast": await import(url.pathToFileURL(path.join(from, "dist/ast/index.js")).href) } } });

		if (analyzer === undefined) {
			console.log("silo/typescript: skipped — no TypeScript ≥ 7.1 (set SILO_TYPESCRIPT to one's package folder)");
			fs.rmSync(root, { "force": true, "recursive": true });

			return;
		}

		const blobs = new Map<string, string>();
		let next = 0;
		const snapshot = (date: string, files: Record<string, string>): { "id": string; "date": string; "files": { "path": string; "oid": string }[] } => ({
			"id": "s" + (next += 1),
			"date": date + "T00:00:00Z",
			"files": Object.entries(files).map(([file, text]) => {
				const oid = "oid" + blobs.size;

				blobs.set(oid, text);

				return { "path": file, "oid": oid };
			})
		});
		// A method call: oxc's name matching can't tell which `go` this is; the checker can.
		const extension = "import { Runner } from \"./runner\";\nimport { other } from \"./other\";\nconst runner = new Runner();\nexport function activate() {\n\tvscode.commands.registerCommand(\"run.go\", () => runner.go());\n\tvscode.commands.registerCommand(\"run.other\", () => other());\n}\n";
		const runner = (go: string): string => `import { shout } from "./shout";\nexport class Runner { go() { return shout(${go}); } }\n`;
		const steps = [];

		try {
			for await (const step of replay([
				snapshot("2026-10-01", { "x/extension.ts": extension, "x/runner.ts": runner("\"a\""), "x/shout.ts": "export const shout = (s: string) => s + \"!\";\n", "x/other.ts": "export const other = () => 1;\n" }),
				snapshot("2026-10-02", { "x/extension.ts": extension, "x/runner.ts": runner("\"a\""), "x/shout.ts": "export const shout = (s: string) => s + \"?\";\n", "x/other.ts": "export const other = () => 1;\n" }),
				snapshot("2026-10-03", { "x/extension.ts": extension, "x/runner.ts": runner("\"a\""), "x/shout.ts": "export const shout = (s: string) => s + \"?\";\n", "x/other.ts": "export const other = () => 2;\n" })
			], async (oid) => blobs.get(oid)!, { "analyzer": analyzer })) {
				steps.push(step);
			}
		} finally {
			analyzer.close?.();
			fs.rmSync(root, { "force": true, "recursive": true });
		}

		const changes = (step: (typeof steps)[number]): string[] => step.events.map((event) => event.type + " " + event.id + (event.type === "changed" && event.via === "reach" ? " via " + event.file + "#" + event.declaration : "")).sort();

		assert.deepEqual(changes(steps[1]!), ["changed run.go via x/shout.ts#shout"], "through the method the call resolves to, and the import it uses");
		assert.deepEqual(changes(steps[2]!), ["changed run.other via x/other.ts#other"], "a later snapshot reads its own version of the file");
	})();
}

