/**
 * silo — TypeScript 7's analyzer (Node, or a browser's runtime): a program's ways in and declaration graph read by the compiler itself
 * (`./ts-analysis`, with TypeScript 7's API as its host). What a declaration uses is what the checker
 * says each of its names is — an import followed through re-exports and the tsconfig's `paths`, a scope's own local left
 * out, a method call resolved to the declaration that holds the method — so reach follows the program as TypeScript sees
 * it.
 *
 * One compiler for a whole replay (its native process; or, where none can start, its WebAssembly build in this one —
 * `apiOf`): the first snapshot is a synthetic program over the snapshot's sources (a
 * filesystem layer of their contents over the disk, which still serves `node_modules`), and each later one is an update
 * with a layer of what changed — nothing is checked out. A file is analyzed again only when it, or a file it resolves
 * names into, changed. The program's own packages (a workspace's, by their package.json) resolve to their sources — not
 * to an installed copy under node_modules.
 *
 * Needs TypeScript ≥ 7.1 (its API: `typescript/sync`) — the caller's (silo bundles one), else the analyzed repository's
 * own: `typescriptAnalyzer` answers undefined without one. Node ids are a file's own names, `file#name`, so a feature's roots (`./features`) name nodes in the graph.
 * Types are left out: a type changes no behavior.
 *
 * And the same TypeScript as a reader of single files (`readSources`): each file's SourceFile, for `./reach`'s readings
 * (`astOf` adapts 7.1's AST module to them) — silo audit's import surface, read by the compiler the analysis uses.
 */

import type { WayIn } from "./features";
import type { Analyzer } from "./graph";
import type { FileAnalysis, TsHost, TsNode } from "./ts-analysis";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as url from "node:url";
import { isEntry } from "@brianjenkins94/util/env";
import * as fs from "@brianjenkins94/util/fs";
import { isManifest, isSource, waysInManifest } from "./features";
import { candidates, packageOf } from "./graph";
import { analysisOf, analyzeFile, stale } from "./ts-analysis";

/** TypeScript's `sync` and `ast` modules (≥ 7.1), and its node predicates (`ast/is`), loosely typed: the few calls below. */
export interface TypeScriptModules {
	"sync": { "API": new (options: { "cwd": string } | { "transport": unknown }) => any };
	"ast": { "SyntaxKind": Record<string | number, string | number> };
	"is"?: Record<string, (node: any) => boolean>;
	/** Its WebAssembly build, where that's installed beside it at the same version: the API in this process, for where
	 *  no native compiler can start (a browser's runtime: the editor's debugger). `tsc` is the module's path; the
	 *  compiler's own lib files are in its folder. */
	"wasm"?: { "WasmTransport": new (options: Record<string, unknown>) => unknown; "instantiateWasm": (module: unknown) => Promise<unknown>; "tsc": string };
}

/** TypeScript's WebAssembly build: the compiler as one module, its lib files beside it. */
const WASM_PACKAGE = "@typescript/typescript-wasip1-wasm";

/**
 * TypeScript ≥ 7.1's modules as installed beside `from` (a folder; default package name `typescript`), or undefined when
 * there's none that new. With them its WebAssembly build, when that's installed too, at the same version.
 */
export async function typescriptModules(from: string, name = "typescript"): Promise<TypeScriptModules | undefined> {
	const resolve = createRequire(from.replace(/\/$/u, "") + "/package.json").resolve;
	const load = async (subpath: string): Promise<any> => import(/*! @external */ url.pathToFileURL(resolve(`${name}/${subpath}`)).href);
	let modules: TypeScriptModules;

	try {
		modules = { "sync": await load("sync"), "ast": await load("ast"), "is": await load("ast/is") } as TypeScriptModules;
	} catch {
		return undefined;
	}

	try {
		const version = (manifest: string): string => JSON.parse(fs.readFileSync(resolve(manifest))).version;

		// (the reactor and the API speak one version's protocol: another version's module is no use to it)
		if (version(`${name}/package.json`) === version(`${WASM_PACKAGE}/package.json`)) {
			const { WasmTransport, instantiateWasm } = await load("wasm");

			modules.wasm = { "WasmTransport": WasmTransport, "instantiateWasm": instantiateWasm, "tsc": resolve(`${WASM_PACKAGE}/lib/tsc.wasm`) };
		}
	} catch {
		// (none, or a TypeScript older than its WebAssembly build: the native compiler only)
	}

	return modules;
}

/**
 * TypeScript's API over `root`: the native compiler's process, or — where none can start, or `SILO_TYPESCRIPT=wasm` says
 * so — the same compiler built for WebAssembly, run in this process and reading through `node:fs` (in the editor's
 * debugger, the workspace). It's slower (a program over 95 files: 2.7 s against 0.17 s), so only where there's no other.
 */
export async function apiOf(modules: TypeScriptModules, root: string): Promise<any> {
	const asked = process.env["SILO_TYPESCRIPT"];

	if (asked !== "wasm") {
		try {
			return new modules.sync.API({ "cwd": root });
		} catch (error) {
			if (modules.wasm === undefined || asked === "native") {
				throw error;
			}
		}
	}

	if (modules.wasm === undefined) {
		throw new Error(`TypeScript's WebAssembly build isn't installed beside it: ${WASM_PACKAGE}, at TypeScript's own version`);
	}

	const instance = await modules.wasm.instantiateWasm(await WebAssembly.compile(fs.readFileSync(modules.wasm.tsc, { "encoding": null })));

	return new modules.sync.API({ "transport": new modules.wasm.WasmTransport({ "instance": instance, "cwd": root, "fs": wasmFileSystem(path.dirname(modules.wasm.tsc)), "useCaseSensitiveFileNames": caseSensitive() }) });
}

/** Whether this file system tells `a` from `A` (as the native API asks it: this file's name with its case swapped). */
function caseSensitive(): boolean {
	const own = url.fileURLToPath(import.meta.url);

	return process.platform !== "win32" && !fs.existsSync(own.replace(/\w/gu, (char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase())));
}

/** The reactor's file system: `node:fs`, but for the compiler's own lib files (`bundled:///libs/…`), which are the
 *  WebAssembly package's, in `libs`. */
function wasmFileSystem(libs: string): Record<string, (path: string, ...rest: any[]) => unknown> {
	const BUNDLED = "bundled:///libs";
	const real = (each: string): string => (each.startsWith(BUNDLED) ? libs + each.slice(BUNDLED.length) : each);
	const stat = (each: string): ReturnType<typeof fs.statSync> | undefined => {
		try {
			return fs.statSync(real(each));
		} catch {
			return undefined;
		}
	};

	return {
		"readFile": (each) => {
			try {
				return fs.readFileSync(real(each));
			} catch {
				return undefined;
			}
		},
		"fileExists": (each) => stat(each)?.isFile() ?? false,
		"directoryExists": (each) => stat(each)?.isDirectory() ?? false,
		"getAccessibleEntries": (each) => {
			const entries = { "files": [] as string[], "directories": [] as string[], "symlinks": [] as string[] };

			try {
				for (const entry of fs.readdirSync(real(each), { "withFileTypes": true })) {
					// (a link is listed as what it points to, and named a link)
					const target = entry.isSymbolicLink() ? stat(path.join(each, entry.name)) : entry;

					if (target !== undefined) {
						(target.isDirectory() ? entries.directories : entries.files).push(entry.name);

						if (entry.isSymbolicLink()) {
							entries.symlinks.push(entry.name);
						}
					}
				}
			} catch {
				// (no folder: nothing in it)
			}

			return entries;
		},
		"realpath": (each) => {
			try {
				return each.startsWith(BUNDLED) ? each : fs.realpathSync(each);
			} catch {
				return each;
			}
		},
		"stat": (each) => {
			const found = stat(each);

			return found === undefined ? undefined : { "mode": found.mode, "size": found.size, "mtime": found.mtime };
		},
		// (the analysis writes nothing: emit is never asked for)
		"writeFile": () => undefined,
		"removeFile": () => undefined
	};
}

/** TypeScript 7.1's AST module as `./reach`'s readings take a `ts`: its node predicates and SyntaxKind — and
 *  isStringLiteralLike, which 7.1 doesn't have (a string literal, or a template with no substitutions). */
export function astOf(modules: TypeScriptModules): any {
	const is = modules.is ?? {};

	return { ...is, "SyntaxKind": modules.ast.SyntaxKind, "isStringLiteralLike": (node: any) => is["isStringLiteral"]!(node) || is["isNoSubstitutionTemplateLiteral"]!(node) };
}

/**
 * Each of `files` (absolute paths under `root`) as TypeScript 7.1 parses it — one compiler, every file opened in
 * one snapshot (`apiOf`'s compiler). `read` gives a file's SourceFile (undefined for one it couldn't); `close` ends it.
 */
export async function readSources(modules: TypeScriptModules, root: string, files: readonly string[]): Promise<{ "read": (file: string) => any; "close": () => void }> {
	const api = await apiOf(modules, root);
	const snapshot = api.createSnapshot({ "openFiles": [...files] });

	return {
		"read": (file) => {
			try {
				return snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
			} catch {
				return undefined;
			}
		},
		"close": () => api.close?.()
	};
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

/** What a tsconfig's compilerOptions come to, as the compiler parses them — for a project with none, TypeScript's for a
 *  module a bundler resolves (parsed from a temporary tsconfig, so the compiler gives its own values). */
async function parsedOptions(api: any, tsconfig: string): Promise<Record<string, unknown>> {
	if (fs.existsSync(tsconfig)) {
		return api.parseConfigFile(tsconfig).options;
	}

	const folder = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-tsconfig-"));

	try {
		fs.writeFileSync(path.join(folder, "tsconfig.json"), JSON.stringify({ "compilerOptions": { "module": "esnext", "moduleResolution": "bundler", "target": "esnext", "jsx": "preserve" } }));

		return api.parseConfigFile(path.join(folder, "tsconfig.json")).options;
	} finally {
		await fs.rm(folder, { "force": true, "recursive": true });
	}
}

/** TypeScript's analyzer, or undefined when no TypeScript ≥ 7.1 is to be had. */
export async function typescriptAnalyzer(options: TypeScriptAnalyzerOptions): Promise<Analyzer | undefined> {
	let ts = options.typescript;

	// (else the repository's TypeScript, not whichever one lib was installed beside)
	ts ??= await typescriptModules(options.root);

	if (ts === undefined) {
		return undefined;
	}

	if (typeof ts.sync?.API !== "function" || ts.ast?.SyntaxKind === undefined) {
		return undefined;
	}

	const kinds = ts.ast.SyntaxKind;
	const root = options.root.replace(/\/$/u, "");
	const api = await apiOf(ts, root);
	// The program reads the JavaScript sources too. A project with no tsconfig (plain JavaScript, say) is read with
	// TypeScript's defaults for a module that a bundler resolves.
	const baseOptions = { ...await parsedOptions(api, options.tsconfig ?? root + "/tsconfig.json"), "allowJs": true };
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

			// A manifest's ways in are its JSON's (./features' waysInManifest).
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
		const { replay } = await import("./history");

		// The TypeScript ≥ 7.1 lib tests with (its dev dependency `typescript-7`; lib's own `typescript` is older).
		const modules = await typescriptModules(import.meta.dirname, "typescript-7");

		assert.ok(modules !== undefined, "typescript-7 (lib's dev dependency) is installed");
		assert.ok(modules.wasm !== undefined, "and its WebAssembly build, at its version");

		// The same analysis from the native compiler and from its WebAssembly build (where no native one can start).
		for (const compiler of ["native", "wasm"]) {
			process.env["SILO_TYPESCRIPT"] = compiler;

			// A repository with only a tsconfig on disk: every version of its sources comes from the snapshots.
			const root = await fs.realpath(await fs.mkdtemp(path.join(fs.tmpdir(), "silo-typescript-")));

			fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ "compilerOptions": { "module": "esnext", "moduleResolution": "bundler", "target": "esnext", "strict": false } }));

			const analyzer = await typescriptAnalyzer({ "root": root, "typescript": modules });

			assert.ok(analyzer !== undefined);

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
			// A method call: name matching alone can't tell which `go` this is; the checker can.
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
				await fs.rm(root, { "force": true, "recursive": true });
			}

			const changes = (step: (typeof steps)[number]): string[] => step.events.map((event) => event.type + " " + event.id + (event.type === "changed" && event.via === "reach" ? " via " + event.file + "#" + event.declaration : "")).sort();

			assert.deepEqual(changes(steps[1]!), ["changed run.go via x/shout.ts#shout"], compiler + ": through the method the call resolves to, and the import it uses");
			assert.deepEqual(changes(steps[2]!), ["changed run.other via x/other.ts#other"], compiler + ": a later snapshot reads its own version of the file");

			// A project with no tsconfig (plain JavaScript): read with TypeScript's defaults, its ways in found all the same.
			const plain = await fs.realpath(await fs.mkdtemp(path.join(fs.tmpdir(), "silo-typescript-plain-")));
			const untyped = (await typescriptAnalyzer({ "root": plain, "typescript": modules }))!;

			try {
				const { ways } = await untyped.analyze(new Map([["cli.js", "cli"]]), async () => "defineCommand(\"notes\", () => 1);\n");

				assert.deepEqual(ways.get("cli.js")?.map((way) => way.facet + " " + way.id), ["terminal command notes"]);
			} finally {
				untyped.close?.();
				await fs.rm(plain, { "force": true, "recursive": true });
			}
		}

		delete process.env["SILO_TYPESCRIPT"];
	})();
}

