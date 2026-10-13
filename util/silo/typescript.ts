/**
 * silo — TypeScript 7's analyzer (Node): a program's declaration graph (`./graph`'s `DeclarationGraph`) from the compiler
 * itself, in place of oxc's name matching. What a declaration uses is what the checker says each of its names is — an
 * import followed through re-exports and the tsconfig's `paths`, a scope's own local left out, a method call resolved to
 * the declaration that holds the method — so reach follows the program as TypeScript sees it.
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

import type { Analyzer, DeclarationGraph } from "./graph";
import { createRequire } from "node:module";
import * as url from "node:url";
import { isEntry } from "@brianjenkins94/util/env";
import { isSource } from "./features";
import { candidates, nodeId, packageOf, TOP } from "./graph";

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

/** What one version of a file contributes: its declarations' fingerprints and edges, its imports' targets, and the files
 *  whose change could change what its names resolve to. */
interface FileAnalysis {
	"oid": string;
	"declarations": Map<string, { "fingerprint": string; "uses": string[] }>;
	"imports": Map<string, string[]>;
	/** A namespace import's local name → the file it names (for `ns.member` roots). */
	"namespaces": Map<string, string>;
	/** The files its body runs (what it imports and re-exports from). */
	"modules": string[];
	"dependsOn": Set<string>;
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

	// By number, never by name: SyntaxKind has aliases (a variable statement's number is also `FirstStatement`), so a
	// kind's name read back from its number can be the alias.
	const kinds = ts.ast.SyntaxKind;
	const kind = (name: string): number => kinds[name] as number;
	const kindSet = (names: string[]): Set<number> => new Set(names.map(kind));
	const root = options.root.replace(/\/$/u, "");
	const api = new ts.sync.API({ "cwd": root });
	// The program reads the JavaScript sources too, as oxc's does.
	const baseOptions = { ...api.parseConfigFile(options.tsconfig ?? root + "/tsconfig.json").options, "allowJs": true };
	let compilerOptions: Record<string, unknown> = baseOptions;
	let packagesKey = "";

	/** The snapshot's own packages as `paths` (each entry point to its source), beside the tsconfig's own. */
	async function withPackages(files: ReadonlyMap<string, string>, read: (oid: string) => Promise<string>): Promise<Record<string, unknown>> {
		const manifests = [...files].filter(([path]) => /(^|\/)package\.json$/u.test(path));
		const key = manifests.map(([path, oid]) => path + ":" + oid).join("|");

		if (key !== packagesKey) {
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

		return compilerOptions;
	}
	const cache = new Map<string, FileAnalysis>();
	let snapshot: any;
	let programId: string | undefined;
	let previous = new Map<string, string>();

	// The compiler canonicalizes paths (lower-cased on a case-insensitive disk): back to the snapshot's own.
	let pathsByKey = new Map<string, string>();
	const relative = (path: string): string | undefined => pathsByKey.get(path.toLowerCase());
	const isProgramFile = (path: string): boolean => pathsByKey.has((root + "/" + path).toLowerCase());

	const SOURCE_FILE = kind("SourceFile");
	const IDENTIFIER = kind("Identifier");
	const TEXT_KINDS = new Set(["Identifier", "PrivateIdentifier", "StringLiteral", "NumericLiteral", "BigIntLiteral", "NoSubstitutionTemplateLiteral", "TemplateHead", "TemplateMiddle", "TemplateTail", "RegularExpressionLiteral", "JsxText"].map(kind));
	// Type positions: what's under them names types, which change no behavior. (A class's `extends` names a value.)
	const TYPE_NODES = kindSet(["TypeReference", "TypeLiteral", "TypeQuery", "TypeParameter", "TypePredicate", "TypeOperator", "UnionType", "IntersectionType", "ArrayType", "TupleType", "FunctionType", "ConstructorType", "ConditionalType", "IndexedAccessType", "MappedType", "LiteralType", "ImportType", "InferType", "OptionalType", "RestType", "ParenthesizedType", "ThisType", "TemplateLiteralType", "InterfaceDeclaration", "TypeAliasDeclaration"]);
	const isTypeNode = (node: any): boolean => TYPE_NODES.has(node.kind) || (node.kind === kind("HeritageClause") && node.token !== kind("ExtendsKeyword"));
	const isTypeStatement = (node: any): boolean => node.kind === kind("InterfaceDeclaration") || node.kind === kind("TypeAliasDeclaration") || (node.kind === kind("ModuleDeclaration") && node.name?.kind === kind("StringLiteral")) || (node.modifiers ?? []).some((modifier: any) => modifier.kind === kind("DeclareKeyword"));

	/** A node's fingerprint: its kinds and its names' and literals' text, without positions, trivia or comments. */
	function fingerprint(node: any): string {
		let out = String(node.kind);

		if (TEXT_KINDS.has(node.kind) && typeof node.text === "string") {
			out += ":" + JSON.stringify(node.text);
		}

		const children: string[] = [];

		node.forEachChild((child: any) => {
			children.push(fingerprint(child));
		});

		return children.length === 0 ? out : out + "(" + children.join(",") + ")";
	}

	/** The names a binding declares: `a`, `{ a, b: c }`, `[a, ...rest]`. */
	function bindingNames(name: any): any[] {
		if (name === undefined) {
			return [];
		}

		if (name.kind === IDENTIFIER) {
			return [name];
		}

		const names: any[] = [];

		name.forEachChild((child: any) => {
			if (child.kind === kind("BindingElement")) {
				names.push(...bindingNames(child.name));
			}
		});

		return names;
	}

	/** A top-level statement's declarations, as [name, the node that is its code, its name nodes]. */
	function declarationsOf(statement: any): [string, any][] {
		if (statement.kind === kind("FunctionDeclaration") || statement.kind === kind("ClassDeclaration") || statement.kind === kind("EnumDeclaration")) {
			const isDefault = (statement.modifiers ?? []).some((modifier: any) => modifier.kind === kind("DefaultKeyword"));

			return [[statement.name?.text ?? (isDefault ? "default" : ""), statement]];
		}

		if (statement.kind === kind("VariableStatement")) {
			return [...statement.declarationList.declarations].flatMap((declarator: any) => bindingNames(declarator.name).map((name): [string, any] => [name.text, declarator]));
		}

		return statement.kind === kind("ExportAssignment") ? [["default", statement]] : [];
	}

	/** Which of a file's own names a node is part of: its declaration's, an import's local, its body (TOP), or none (a type). */
	function ownerName(statement: any, node: any): string | undefined {
		if (statement.kind === kind("ImportDeclaration")) {
			let local: string | undefined;
			const clause = statement.importClause;
			const visit = (each: any): void => {
				if (local === undefined && each.pos <= node.pos && node.end <= each.end && (each.kind === kind("ImportSpecifier") || each.kind === kind("NamespaceImport"))) {
					local = each.name.text;
				}

				each.forEachChild(visit);
			};

			if (clause !== undefined) {
				if (clause.name !== undefined && clause.name.pos <= node.pos && node.end <= clause.name.end) {
					return clause.name.text;
				}

				visit(clause);
			}

			return local;
		}

		if (isTypeStatement(statement) || statement.kind === kind("ExportDeclaration")) {
			return undefined;
		}

		const declared = declarationsOf(statement);

		if (declared.length === 0) {
			return TOP;
		}

		// The declarator (and the bound name) the node is in; else the statement's first.
		return (declared.find(([, code]) => code.pos <= node.pos && node.end <= code.end) ?? declared[0])![0] || undefined;
	}

	function analyze(project: any, path: string, oid: string): FileAnalysis {
		const analysis: FileAnalysis = { "oid": oid, "declarations": new Map(), "imports": new Map(), "namespaces": new Map(), "modules": [], "dependsOn": new Set() };
		const file = project.program.getSourceFile(root + "/" + path);

		if (file === undefined) {
			return analysis;
		}

		const checker = project.checker;
		const body: any[] = [];
		const code: [string, any][] = [];
		// Each import's local name, its name node, and which module specifier it's from.
		const importNames: [string, any, number][] = [];
		const moduleNodes: any[] = [];

		for (const statement of file.statements) {
			if (statement.kind === kind("ImportDeclaration")) {
				const clause = statement.importClause;

				if (clause?.isTypeOnly === true) {
					continue;
				}

				const module = moduleNodes.push(statement.moduleSpecifier) - 1;

				if (clause?.name !== undefined) {
					importNames.push([clause.name.text, clause.name, module]);
				}

				const bindings = clause?.namedBindings;

				if (bindings !== undefined && bindings.kind === kind("NamespaceImport")) {
					importNames.push([bindings.name.text, bindings.name, module]);
				} else if (bindings !== undefined) {
					for (const element of bindings.elements) {
						if (element.isTypeOnly !== true) {
							importNames.push([element.name.text, element.name, module]);
						}
					}
				}
			} else if (statement.kind === kind("ExportDeclaration")) {
				if (statement.moduleSpecifier !== undefined && statement.isTypeOnly !== true) {
					moduleNodes.push(statement.moduleSpecifier);
				}
			} else if (isTypeStatement(statement)) {
				continue;
			} else if (declarationsOf(statement).length > 0) {
				code.push(...declarationsOf(statement).filter(([name]) => name !== ""));
			} else {
				body.push(statement);
			}
		}

		// Every name each declaration's code uses (and the body's), resolved in one request.
		const uses = new Map<string, any[]>();
		const collect = (owner: string, node: any, own?: any): void => {
			const found = uses.get(owner) ?? [];
			const visit = (each: any): void => {
				if (isTypeNode(each)) {
					return;
				}

				if (each.kind === IDENTIFIER && each !== own) {
					found.push(each);
				}

				each.forEachChild(visit);
			};

			visit(node);
			uses.set(owner, found);
		};

		for (const [name, node] of code) {
			collect(name, node, node.name);
		}

		for (const statement of body) {
			collect(TOP, statement);
		}

		const owners = [...uses].flatMap(([owner, nodes]) => nodes.map((node) => [owner, node] as const));
		const symbols: any[] = owners.length === 0 ? [] : checker.getSymbolAtLocation(owners.map(([, node]) => node));
		const importSymbols: any[] = importNames.length === 0 ? [] : checker.getSymbolAtLocation(importNames.map(([, node]) => node));
		const moduleSymbols: any[] = moduleNodes.length === 0 ? [] : checker.getSymbolAtLocation(moduleNodes);
		const targets = new Map<number, string | null>();

		/**
		 * The node a symbol is, in the program's graph: the file's own name its declaration is part of. A name that's an
		 * import stays that import (it leads on to what it imports, and to the module bodies importing runs); `follow`
		 * resolves an import to what it names, for the import's own edge.
		 */
		const locate = (symbol: any, follow = false): string | null => {
			if (symbol === undefined) {
				return null;
			}

			let target = symbol;

			if (follow && (symbol.flags & ALIAS) !== 0) {
				try {
					target = checker.getAliasedSymbol(symbol);
				} catch {
					return null;
				}
			}

			const cacheKey = target.id * 2 + (follow ? 1 : 0);

			if (targets.has(cacheKey)) {
				return targets.get(cacheKey)!;
			}

			let located: string | null = null;
			const handle = target.valueDeclaration ?? target.declarations?.[0];
			const owner = handle === undefined ? undefined : relative(String(handle.path));

			if (owner !== undefined) {
				const node = handle.resolve(project);
				let statement = node;

				while (statement?.parent !== undefined && statement.parent.kind !== SOURCE_FILE) {
					statement = statement.parent;
				}

				const name = statement === undefined ? undefined : ownerName(statement, node);

				located = name === undefined ? null : nodeId(owner, name);
			}

			targets.set(cacheKey, located);

			return located;
		};

		owners.forEach(([owner], index) => {
			const located = locate(symbols[index]);
			const self = nodeId(path, owner);

			if (located !== null && located !== self) {
				const list = analysis.declarations.get(owner)?.uses ?? [];

				if (!list.includes(located)) {
					list.push(located);
				}

				analysis.declarations.set(owner, { "fingerprint": "", "uses": list });
			}
		});

		for (const [name, node] of code) {
			const entry = analysis.declarations.get(name) ?? { "fingerprint": "", "uses": [] };

			entry.fingerprint = (entry.fingerprint === "" ? "" : entry.fingerprint + "|") + fingerprint(node);
			analysis.declarations.set(name, entry);
		}

		const moduleFiles: (string | undefined)[] = [];

		for (const [index, symbol] of moduleSymbols.entries()) {
			const handle = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
			// A module that exports nothing has no symbol (`import "./handlers/calls"`): its path, then.
			const specifier = String(moduleNodes[index]?.text ?? "");
			const target = handle === undefined ? candidates(path, specifier).find(isProgramFile) : relative(String(handle.path));

			moduleFiles[index] = target;

			if (target !== undefined) {
				analysis.modules.push(target);

				// A namespace import's module, for `ns.member`.
				const clause = moduleNodes[index]?.parent?.importClause;

				if (clause?.namedBindings !== undefined && clause.namedBindings.kind === kind("NamespaceImport")) {
					analysis.namespaces.set(clause.namedBindings.name.text, target);
				}
			}
		}

		// An import leads to what it names, and to the body of the module it's from (a barrel's, which runs its re-exports).
		importNames.forEach(([local, , module], index) => {
			const located = locate(importSymbols[index], true);
			const from = moduleFiles[module];

			analysis.imports.set(local, [...located === null ? [] : [located], ...from === undefined ? [] : [nodeId(from, TOP)]]);
		});

		if (body.length > 0 || analysis.modules.length > 0) {
			const entry = analysis.declarations.get(TOP) ?? { "fingerprint": "", "uses": [] };

			entry.fingerprint = body.map(fingerprint).join("|");
			analysis.declarations.set(TOP, entry);
		}

		for (const entry of analysis.declarations.values()) {
			entry.uses.sort();

			for (const used of entry.uses) {
				analysis.dependsOn.add(used.slice(0, used.lastIndexOf("#")));
			}
		}

		for (const targetsOfImport of analysis.imports.values()) {
			for (const used of targetsOfImport) {
				analysis.dependsOn.add(used.slice(0, used.lastIndexOf("#")));
			}
		}

		for (const module of analysis.modules) {
			analysis.dependsOn.add(module);
		}

		analysis.dependsOn.delete(path);

		return analysis;
	}

	return {
		"graph": async (files, read) => {
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
			const touched = new Set([...changed, ...removed]);

			for (const path of removed) {
				cache.delete(path);
			}

			for (const [path, oid] of sources) {
				const known = cache.get(path);

				if (known === undefined || known.oid !== oid || [...known.dependsOn].some((dependency) => touched.has(dependency))) {
					cache.set(path, analyze(project, path, oid));
				}
			}

			previous = sources;

			return graphOf(new Map(cache));
		},
		"close": () => {
			snapshot?.dispose?.();
			api.close();
		}
	};
}

/** The declaration graph of a set of analyzed files. */
function graphOf(files: ReadonlyMap<string, FileAnalysis>): DeclarationGraph {
	const fingerprints = new Map<string, string>();

	for (const [path, analysis] of files) {
		for (const [name, { fingerprint }] of analysis.declarations) {
			fingerprints.set(nodeId(path, name), fingerprint);
		}
	}

	return {
		"fingerprints": fingerprints,
		"nodes": () => [...files].flatMap(([path, analysis]) => [...[...analysis.declarations.keys()].map((name) => nodeId(path, name)), ...[...analysis.imports.keys()].map((local) => nodeId(path, local))]),
		"edges": (id) => {
			const hash = id.lastIndexOf("#");
			const [path, name] = [id.slice(0, hash), id.slice(hash + 1)];
			const analysis = files.get(path);

			if (analysis === undefined) {
				return [];
			}

			const declaration = analysis.declarations.get(name);

			if (declaration !== undefined) {
				// A module's body runs the bodies of the modules it imports.
				return name === TOP ? [...declaration.uses, ...analysis.modules.map((module) => nodeId(module, TOP)).filter((top) => fingerprints.has(top))] : declaration.uses;
			}

			const imported = analysis.imports.get(name);

			if (imported !== undefined) {
				// What it names, and the bodies importing it runs (the module it's from, and the one that declares it).
				const declaring = imported[0]?.slice(0, imported[0].lastIndexOf("#"));

				return [...new Set([...imported, ...declaring === undefined ? [] : [nodeId(declaring, TOP)]])].filter((target) => !target.endsWith("#" + TOP) || fingerprints.has(target));
			}

			// `ns.member`: the member of the module a namespace import names.
			const dot = name.indexOf(".");
			const module = dot > 0 ? analysis.namespaces.get(name.slice(0, dot)) : undefined;

			return module === undefined ? [] : [nodeId(module, name.slice(dot + 1))].filter((target) => fingerprints.has(target));
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

