/**
 * silo — a program's declaration graph (pure, browser-portable): which of its top-level declarations use which, across
 * its files' imports. What a feature REACHES (`./history`): from its registration, the declarations it uses, and theirs
 * in turn — so a change to any of them is a change to the feature, wherever in the program it was made.
 *
 * A node is a name in a file, `file#name`: a top-level declaration (a function, a class, a variable, an enum, the
 * default export) or an import. A declaration's edges are the names its code uses that the file declares or imports; an
 * import's one edge is what it resolves to — a relative import, or one of the program's own packages by name (a
 * workspace's, through its package.json `exports`) — through `export … from` re-exports, to the declaration that module
 * exports (`import * as ns` then `ns.name`: that export; `ns` alone: every declaration of the module). Any other
 * package (`vscode`, a dependency) is outside the program and ends the walk.
 *
 * A module's body — its top-level statements that aren't declarations — is a node too, `file#(top)`: importing a module
 * runs it, and it runs every module it imports, so an import leads to its module's body as well as to what it exports.
 * (A registry filled as its modules load is reached this way; a program's entry, which nothing imports, isn't — its
 * boot isn't any one feature's.) Left out: types (a type changes no behavior), and a name shadowed by a local of the
 * same name (counted as the top-level one).
 * Each declaration carries a fingerprint — its AST without positions — so a change in comments or whitespace isn't one.
 *
 * `oxc` + pure AST logic only, the same portability contract as `./features`: no fs, git or network.
 */

import { isEntry } from "@brianjenkins94/util/env";
import { parseSync } from "oxc-parser";

/** One top-level declaration: what it is, as a fingerprint, and the names (declared or imported here) its code uses. */
export interface Declaration {
	"name": string;
	"fingerprint": string;
	"uses": string[];
}

/** What a file contributes to the graph — computed once per version of the file (by its content). */
export interface FileGraph {
	/** Its declarations, and its body as `(top)` (see `TOP`). */
	"declarations": Declaration[];
	/** Each import, by its local name: the module it's from, and the name it imports (`default`, `*` for a namespace). */
	"imports": Record<string, { "from": string; "name": string }>;
	/** Each export, by the name it's exported as: the local name it exports. */
	"exports": Record<string, string>;
	/** `export { a as b } from "./x"` (`name` a, `as` b) and `export * from "./x"` (`name` and `as` both `*`). */
	"reexports": { "from": string; "name": string; "as": string }[];
	/** Every module it imports, re-exports from, or imports only to run (`import "./x"`): what running its body runs. */
	"modules": string[];
}

/** A module's body: its top-level statements that aren't declarations. */
export const TOP = "(top)";

// oxc's ESTree, typed loosely: the handful of node shapes read below.
export interface Node { "type": string; "start": number; "end": number; [key: string]: any }

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** Every node under `node`, depth first; `skip` prunes a subtree (its node not visited either). */
export function walk(node: Node, visit: (node: Node, parent: Node | undefined) => void, skip: (node: Node) => boolean = () => false, parent?: Node): void {
	if (skip(node)) {
		return;
	}

	visit(node, parent);

	for (const key in node) {
		if (key === "parent") {
			continue;
		}

		const value = node[key];

		if (Array.isArray(value)) {
			for (const child of value) {
				if (isNode(child)) {
					walk(child, visit, skip, node);
				}
			}
		} else if (isNode(value)) {
			walk(value, visit, skip, node);
		}
	}
}

/** A node without its positions or its literals' spelling: two versions with equal fingerprints differ only in
 *  comments, whitespace or quotes. */
export function fingerprintOf(node: unknown): string {
	return JSON.stringify(node, (key, value: unknown) => (key === "start" || key === "end" || key === "range" || key === "loc" || key === "raw" ? undefined : typeof value === "bigint" ? value.toString() + "n" : value));
}

/** Types say nothing about what code does. */
const isType = (node: Node): boolean => node.type.startsWith("TS") && node.type !== "TSEnumDeclaration" && node.type !== "TSAsExpression" && node.type !== "TSSatisfiesExpression" && node.type !== "TSNonNullExpression";

/**
 * The names `node`'s code refers to — each identifier that isn't a property's name — with a namespace's member read as
 * `ns.member` when `namespaces` says `ns` is one. A JSX element counts by its tag when it's a component (capitalized).
 */
export function namesIn(node: Node, namespaces: ReadonlySet<string> = new Set()): Set<string> {
	const names = new Set<string>();

	walk(node, (each, parent) => {
		if (each.type === "Identifier") {
			const isKey = parent !== undefined && !parent["computed"] && (
				(parent.type === "MemberExpression" && parent["property"] === each)
				|| ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent["key"] === each && !(parent.type === "Property" && parent["shorthand"]))
			);

			if (isKey) {
				return;
			}

			if (namespaces.has(each["name"]) && parent?.type === "MemberExpression" && parent["object"] === each && !parent["computed"]) {
				names.add(each["name"] + "." + parent["property"]["name"]);
			} else {
				names.add(each["name"]);
			}
		} else if (each.type === "JSXIdentifier" && /^[A-Z]/u.test(each["name"]) && (parent?.type === "JSXOpeningElement" || parent?.type === "JSXMemberExpression")) {
			names.add(each["name"]);
		}
	}, isType);

	return names;
}

/** The names a binding pattern binds: `a`, `{ a, b: c }`, `[a, ...rest]`. */
function boundNames(pattern: Node | undefined): string[] {
	if (pattern === undefined || pattern === null) {
		return [];
	}

	switch (pattern.type) {
		case "Identifier":
			return [pattern["name"]];
		case "ObjectPattern":
			return pattern["properties"].flatMap((each: Node) => boundNames(each.type === "RestElement" ? each["argument"] : each["value"]));
		case "ArrayPattern":
			return pattern["elements"].flatMap((each: Node | null) => boundNames(each ?? undefined));
		case "RestElement":
			return boundNames(pattern["argument"]);
		case "AssignmentPattern":
			return boundNames(pattern["left"]);
		default:
			return [];
	}
}

/** A top-level statement's declarations, as [name, the node that is its code]. */
function declared(statement: Node): [string, Node][] {
	switch (statement.type) {
		case "FunctionDeclaration":
		case "ClassDeclaration":
		case "TSEnumDeclaration":
			return statement["id"] === null ? [] : [[statement["id"]["name"], statement]];
		case "VariableDeclaration":
			return statement["declarations"].flatMap((declarator: Node) => boundNames(declarator["id"]).map((name): [string, Node] => [name, declarator]));
		default:
			return [];
	}
}

/** A program's top-level names — what it declares and imports (not types) — and which of them are namespaces. */
export function topLevelNames(program: Node): { "known": Set<string>; "namespaces": Set<string> } {
	const known = new Set<string>();
	const namespaces = new Set<string>();

	for (const statement of program["body"] as Node[]) {
		if (statement.type === "ImportDeclaration") {
			if (statement["importKind"] === "type") {
				continue;
			}

			for (const specifier of statement["specifiers"] as Node[]) {
				if (specifier["importKind"] !== "type") {
					known.add(specifier["local"]["name"]);

					if (specifier.type === "ImportNamespaceSpecifier") {
						namespaces.add(specifier["local"]["name"]);
					}
				}
			}

			continue;
		}

		const inner = (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") && isNode(statement["declaration"]) ? statement["declaration"] : statement;

		for (const [name] of declared(inner)) {
			known.add(name);
		}
	}

	return { "known": known, "namespaces": namespaces };
}

/**
 * The top-level names `node` uses, as written in `statement` (the top-level statement it's in): a name the file declares
 * or imports counts as itself; a local of the function it's in (`const runner = createRunner()`) counts as the names
 * its declaration uses, followed until they reach the top level.
 */
export function topLevelUses(node: Node, statement: Node, scope: { "known": ReadonlySet<string>; "namespaces": ReadonlySet<string> }): string[] {
	let locals: Map<string, Node> | undefined;
	// The locals declared anywhere in `statement`, by name: read once, when a name isn't a top-level one.
	const localsIn = (): Map<string, Node> => {
		if (locals === undefined) {
			const map = new Map<string, Node>();

			walk(statement, (each) => {
				if (each.type === "VariableDeclarator") {
					for (const bound of boundNames(each["id"])) {
						map.set(bound, each);
					}
				} else if ((each.type === "FunctionDeclaration" || each.type === "ClassDeclaration") && each["id"] !== null && each !== statement) {
					map.set(each["id"]["name"], each);
				}
			}, isType);
			locals = map;
		}

		return locals;
	};
	const found = new Set<string>();
	const seen = new Set<string>();
	const pending = [...namesIn(node, scope.namespaces)];

	while (pending.length > 0) {
		const name = pending.pop()!;

		if (seen.has(name)) {
			continue;
		}

		seen.add(name);

		if (scope.known.has(name) || scope.known.has(name.split(".")[0]!)) {
			found.add(name);
			continue;
		}

		const local = localsIn().get(name);

		if (local !== undefined && local !== node) {
			pending.push(...namesIn(local, scope.namespaces));
		}
	}

	return [...found].sort();
}

/** What a file contributes to the graph. A file that doesn't parse contributes nothing. */
export function fileGraph(file: string, text: string): FileGraph {
	const graph: FileGraph = { "declarations": [], "imports": {}, "exports": {}, "reexports": [], "modules": [] };
	const { program, errors } = parseSync(file, text);

	if (errors.length > 0 && program.body.length === 0) {
		return graph;
	}

	const namespaces = new Set<string>();
	const code: [string, Node][] = [];
	const body: Node[] = [];
	const runs = (specifier: string): void => {
		if (!graph.modules.includes(specifier)) {
			graph.modules.push(specifier);
		}
	};

	for (const statement of program.body as Node[]) {
		if (statement.type === "ImportDeclaration") {
			if (statement["importKind"] === "type" || (statement["specifiers"].length > 0 && statement["specifiers"].every((specifier: Node) => specifier["importKind"] === "type"))) {
				continue;
			}

			runs(statement["source"]["value"]);

			for (const specifier of statement["specifiers"] as Node[]) {
				if (specifier["importKind"] === "type") {
					continue;
				}

				const name = specifier.type === "ImportNamespaceSpecifier" ? "*" : specifier.type === "ImportDefaultSpecifier" ? "default" : specifier["imported"]["name"] ?? specifier["imported"]["value"];

				graph.imports[specifier["local"]["name"]] = { "from": statement["source"]["value"], "name": name };

				if (name === "*") {
					namespaces.add(specifier["local"]["name"]);
				}
			}
		} else if (statement.type === "ExportNamedDeclaration") {
			if (statement["source"] !== null && statement["source"] !== undefined) {
				if (statement["exportKind"] !== "type") {
					runs(statement["source"]["value"]);
				}

				for (const specifier of statement["specifiers"] as Node[]) {
					graph.reexports.push({ "from": statement["source"]["value"], "name": specifier["local"]["name"] ?? specifier["local"]["value"], "as": specifier["exported"]["name"] ?? specifier["exported"]["value"] });
				}
			} else if (statement["declaration"] !== null && statement["declaration"] !== undefined) {
				for (const [name, node] of declared(statement["declaration"])) {
					graph.exports[name] = name;
					code.push([name, node]);
				}
			} else {
				for (const specifier of statement["specifiers"] as Node[]) {
					graph.exports[specifier["exported"]["name"] ?? specifier["exported"]["value"]] = specifier["local"]["name"];
				}
			}
		} else if (statement.type === "ExportAllDeclaration") {
			if (statement["exportKind"] !== "type") {
				runs(statement["source"]["value"]);
			}

			graph.reexports.push({ "from": statement["source"]["value"], "name": "*", "as": statement["exported"]?.["name"] ?? "*" });
		} else if (statement.type === "ExportDefaultDeclaration") {
			const declaration = statement["declaration"] as Node;
			const name = declaration["id"]?.["name"] as string | undefined;

			if (name !== undefined && (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration")) {
				graph.exports["default"] = name;
				code.push([name, declaration]);
			} else if (declaration.type === "Identifier") {
				graph.exports["default"] = declaration["name"];
			} else {
				graph.exports["default"] = "default";
				code.push(["default", declaration]);
			}
		} else if (declared(statement).length > 0) {
			code.push(...declared(statement));
		} else if (!isType(statement)) {
			body.push(statement);
		}
	}

	if (body.length > 0 || graph.modules.length > 0) {
		code.push([TOP, { "type": "Program", "start": 0, "end": 0, "body": body }]);
	}

	const known = new Set([...code.map(([name]) => name), ...Object.keys(graph.imports)]);

	for (const [name, node] of code) {
		const uses = [...namesIn(node, namespaces)].filter((used) => used !== name && (known.has(used) || known.has(used.split(".")[0])));

		graph.declarations.push({ "name": name, "fingerprint": fingerprintOf(node), "uses": uses.sort() });
	}

	return graph;
}

/** One of the program's own packages: where it is, and the file each of its entry points (`.`, `./sub`) names. */
export interface Package {
	"name": string;
	"dir": string;
	"exports": Record<string, string>;
}

/** A package.json's package — if it names one with an entry point — for `./graph`'s resolution of imports by name. */
export function packageOf(manifest: string, text: string): Package | undefined {
	let json: Record<string, any>;

	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}

	if (typeof json["name"] !== "string") {
		return undefined;
	}

	// An export's file: a path, or the condition a bundler takes (`import`, else `default`, else the first path).
	const pick = (value: unknown): string | undefined => typeof value === "string" ? value : typeof value === "object" && value !== null ? pick((value as Record<string, unknown>)["import"] ?? (value as Record<string, unknown>)["default"] ?? Object.values(value).find((each) => typeof each === "string")) : undefined;
	const raw = json["exports"] ?? json["main"];
	const exports: Record<string, string> = {};

	if (typeof raw === "string" || (typeof raw === "object" && raw !== null && !Object.keys(raw).some((key) => key.startsWith(".")))) {
		const file = pick(raw);

		if (file !== undefined) {
			exports["."] = file;
		}
	} else if (typeof raw === "object" && raw !== null) {
		for (const [subpath, value] of Object.entries(raw)) {
			const file = pick(value);

			if (file !== undefined && !subpath.includes("*")) {
				exports[subpath] = file;
			}
		}
	}

	return Object.keys(exports).length === 0 ? undefined : { "name": json["name"], "dir": manifest.slice(0, Math.max(0, manifest.lastIndexOf("/"))), "exports": exports };
}

/** The node id of `name` in `file`. */
export const nodeId = (file: string, name: string): string => file + "#" + name;

/** The files a module specifier, imported from `from`, can be (a relative one; a package import is none). */
export function candidates(from: string, specifier: string): string[] {
	if (!specifier.startsWith(".")) {
		return [];
	}

	const parts = from.split("/").slice(0, -1);

	for (const part of specifier.split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== ".") {
			parts.push(part);
		}
	}

	const base = parts.join("/");
	// TypeScript's own spelling: `./x.js` names `./x.ts`.
	const stem = base.replace(/\.[cm]?js$/u, "");

	return [base, ...[".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"].map((extension) => stem + extension), ...["/index.ts", "/index.tsx", "/index.js"].map((index) => base + index)];
}

/**
 * The program's graph: every file's declarations and imports, resolved across files. Built per snapshot from the
 * files' `FileGraph`s (each computed once per version), so building one is a walk over what's already parsed.
 */
export class ProgramGraph {
	readonly "files": ReadonlyMap<string, FileGraph>;
	/** Each declaration's fingerprint, by node id. */
	readonly "fingerprints" = new Map<string, string>();
	readonly #edges = new Map<string, string[]>();
	readonly #bodied = new Set<string>();
	#reverse: Map<string, string[]> | undefined;

	readonly #packages: Package[];

	/** `packages`: the program's own, so an import of one by name is followed into it. */
	constructor(files: ReadonlyMap<string, FileGraph>, packages: Iterable<Package> = []) {
		this.files = files;
		// The longest name first: `@scope/a-b` before `@scope/a`.
		this.#packages = [...packages].sort((left, right) => right.name.length - left.name.length);

		for (const [file, graph] of files) {
			for (const declaration of graph.declarations) {
				const id = nodeId(file, declaration.name);

				this.fingerprints.set(id, declaration.fingerprint);
				this.#edges.set(id, declaration.uses.map((used) => nodeId(file, used)));
			}
		}
	}

	/** Running `file`'s body runs the bodies of the modules it imports. Resolved on first ask (it needs the packages). */
	#bodyEdges(file: string): string[] {
		const graph = this.files.get(file)!;
		const own = graph.declarations.find((declaration) => declaration.name === TOP)?.uses.map((used) => nodeId(file, used)) ?? [];
		const ran = graph.modules.map((specifier) => this.resolveModule(file, specifier)).filter((target): target is string => target !== undefined && this.fingerprints.has(nodeId(target, TOP))).map((target) => nodeId(target, TOP));

		return [...own, ...ran];
	}

	/** The file a specifier imported from `from` names, if it's in the program. */
	resolveModule(from: string, specifier: string): string | undefined {
		if (!specifier.startsWith(".")) {
			const found = this.#packages.find((each) => specifier === each.name || specifier.startsWith(each.name + "/"));
			const entry = found?.exports["." + specifier.slice(found.name.length)];

			return found === undefined || entry === undefined ? undefined : candidates((found.dir === "" ? "" : found.dir + "/") + "package.json", entry.startsWith(".") ? entry : "./" + entry).find((path) => this.files.has(path));
		}

		return candidates(from, specifier).find((path) => this.files.has(path));
	}

	/** The declarations `name`, exported from `file`, is — through re-exports (several, for a namespace). */
	#exported(file: string, name: string, seen = new Set<string>()): string[] {
		const graph = this.files.get(file);

		if (graph === undefined || seen.has(file + "|" + name)) {
			return [];
		}

		seen.add(file + "|" + name);

		if (name === "*") {
			return graph.declarations.map((declaration) => nodeId(file, declaration.name));
		}

		const local = graph.exports[name];

		if (local !== undefined) {
			return [nodeId(file, local)];
		}

		for (const reexport of graph.reexports) {
			const target = this.resolveModule(file, reexport.from);

			if (target === undefined) {
				continue;
			}

			if (reexport.as === name) {
				return this.#exported(target, reexport.name, seen);
			}

			if (reexport.as === "*" && reexport.name === "*") {
				const found = this.#exported(target, name, seen);

				if (found.length > 0) {
					return found;
				}
			}
		}

		return [];
	}

	/** Where node `id` leads: a declaration's uses, or an import's declaration (none, for a package's). */
	edges(id: string): string[] {
		const hash = id.lastIndexOf("#");
		const [file, name] = [id.slice(0, hash), id.slice(hash + 1)];

		if (name === TOP && !this.#bodied.has(id) && this.files.has(file)) {
			this.#bodied.add(id);
			this.#edges.set(id, this.#bodyEdges(file));
		}

		const known = this.#edges.get(id);

		if (known !== undefined) {
			return known;
		}

		const [local, member] = name.includes(".") ? [name.slice(0, name.indexOf(".")), name.slice(name.indexOf(".") + 1)] : [name, undefined];
		const imported = this.files.get(file)?.imports[local];
		let resolved: string[] = [];

		if (imported !== undefined) {
			const target = this.resolveModule(file, imported.from);

			// What it imports, and the module's body, which importing it runs.
			resolved = target === undefined ? [] : [...this.#exported(target, imported.name === "*" && member !== undefined ? member : imported.name), ...this.fingerprints.has(nodeId(target, TOP)) ? [nodeId(target, TOP)] : []];
		}

		this.#edges.set(id, resolved);

		return resolved;
	}

	/** Every declaration reachable from `roots` (node ids: declarations or imports), the roots' own included. */
	reach(roots: Iterable<string>): Set<string> {
		const seen = new Set<string>();
		const queue = [...roots];

		while (queue.length > 0) {
			const id = queue.pop()!;

			if (seen.has(id)) {
				continue;
			}

			seen.add(id);
			queue.push(...this.edges(id));
		}

		return new Set([...seen].filter((id) => this.fingerprints.has(id)));
	}

	/**
	 * Every node that reaches one of `targets`, each with the target it reaches (the nearest, by the walk back). The
	 * other direction of `reach`: from a few changed declarations to everything that uses them.
	 */
	reachers(targets: Iterable<string>): Map<string, string> {
		if (this.#reverse === undefined) {
			this.#reverse = new Map();

			const add = (from: string): void => {
				for (const to of this.edges(from)) {
					this.#reverse!.set(to, [...this.#reverse!.get(to) ?? [], from]);
				}
			};

			for (const [file, graph] of this.files) {
				for (const declaration of graph.declarations) {
					add(nodeId(file, declaration.name));
				}

				for (const local of Object.keys(graph.imports)) {
					add(nodeId(file, local));
				}

				// A namespace's members are nodes of their own (`ns.name`): add the ones its declarations use.
				for (const declaration of graph.declarations) {
					for (const used of declaration.uses) {
						if (used.includes(".")) {
							add(nodeId(file, used));
						}
					}
				}
			}
		}

		const origin = new Map<string, string>();
		const queue: string[] = [];

		for (const target of targets) {
			origin.set(target, target);
			queue.push(target);
		}

		// (The queue grows as it's walked: a for-of sees what's pushed.)
		for (const id of queue) {
			for (const from of this.#reverse.get(id) ?? []) {
				if (!origin.has(from)) {
					origin.set(from, origin.get(id)!);
					queue.push(from);
				}
			}
		}

		return origin;
	}
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

		// A file's declarations and what each uses: imports and its own names, not types, keys or property names.
		const app = fileGraph("src/app.tsx", `import type { Props } from "./types";\nimport Panel, { title as heading } from "./panel";\nconst size = 3;\ntype Size = number;\nexport default function App(props: Props) { return <Panel size={size}>{heading}</Panel>; }\nexport const unrelated = { "size": 1 }.size;\n`);

		assert.deepEqual(app.declarations.map((declaration) => declaration.name + ": " + declaration.uses.join(",")), ["size: ", "App: Panel,heading,size", "unrelated: ", "(top): "]);
		assert.deepEqual(app.imports, { "Panel": { "from": "./panel", "name": "default" }, "heading": { "from": "./panel", "name": "title" } }, "a type import isn't one");
		assert.equal(app.exports["default"], "App");

		// Across files: a default export, a named one; reach from a root, and back from a change.
		const program = new ProgramGraph(new Map([
			["src/app.tsx", app],
			["src/panel.tsx", fileGraph("src/panel.tsx", "export const title = \"t\";\nexport default function Panel() { return frame(); }\nfunction frame() { return 1; }\nfunction alone() { return 2; }\n")]
		]));

		assert.deepEqual([...program.reach(["src/app.tsx#App"])].sort(), ["src/app.tsx#App", "src/app.tsx#size", "src/panel.tsx#Panel", "src/panel.tsx#frame", "src/panel.tsx#title"]);

		const back = program.reachers(["src/panel.tsx#frame"]);

		assert.equal(back.get("src/app.tsx#App"), "src/panel.tsx#frame", "App reaches frame");
		assert.equal(back.has("src/panel.tsx#alone"), false);

		// One of the program's own packages, imported by name: followed through its exports.
		const lib = packageOf("packages/lib/package.json", JSON.stringify({ "name": "@me/lib", "exports": { ".": "./src/index.ts", "./extra": { "types": "./x.d.ts", "import": "./src/extra.ts" } } }));

		assert.deepEqual(lib, { "name": "@me/lib", "dir": "packages/lib", "exports": { ".": "./src/index.ts", "./extra": "./src/extra.ts" } });

		const workspace = new ProgramGraph(new Map([
			["app/main.ts", fileGraph("app/main.ts", "import { go } from \"@me/lib\";\nimport { more } from \"@me/lib/extra\";\nexport const run = () => go() + more();\n")],
			["packages/lib/src/index.ts", fileGraph("packages/lib/src/index.ts", "export const go = () => 1;\n")],
			["packages/lib/src/extra.ts", fileGraph("packages/lib/src/extra.ts", "export const more = () => 2;\n")]
		]), [lib]);

		assert.deepEqual([...workspace.reach(["app/main.ts#run"])].sort(), ["app/main.ts#run", "packages/lib/src/extra.ts#more", "packages/lib/src/index.ts#go"]);

		// A module's body runs when it's imported, and runs what it imports: a registry filled as its modules load.
		const registry = new ProgramGraph(new Map([
			["vm.ts", fileGraph("vm.ts", "import { handlers } from \"./registry\";\nimport \"./calls\";\nexport const run = (kind: string) => handlers.get(kind)();\n")],
			["registry.ts", fileGraph("registry.ts", "export const handlers = new Map();\nexport const on = (kind: string, handler: () => void) => handlers.set(kind, handler);\n")],
			["calls.ts", fileGraph("calls.ts", "import { on } from \"./registry\";\non(\"call\", call);\nfunction call() { return 1; }\n")],
			["main.ts", fileGraph("main.ts", "import { run } from \"./vm\";\nrun(\"call\");\n")]
		]));

		assert.ok(registry.reach(["main.ts#run"]).has("calls.ts#call"), "vm's import runs calls.ts, which registers call");
		assert.equal(registry.reachers(["main.ts#(top)"]).size, 1, "nothing imports the entry");
	})();
}
