/**
 * silo — oxc's reading of a program (pure, browser-portable): its ways in (`./features`' model, found by oxc's parse)
 * and its declaration graph (`./graph`'s seam), each file version parsed once and cached by content. TypeScript's
 * reading is the same over the compiler's own tree (`./ts-analysis`); this one needs no compiler, and serves wherever
 * there's none.
 *
 * The graph: a node is a top-level declaration, an import, or a module's body (`TOP`: what importing it runs); a
 * declaration's edges are the names it uses that its file declares or imports, an import's what it resolves to — a
 * relative module or one of the program's own packages by name (package.json exports), through re-exports and
 * namespaces. Each declaration carries a fingerprint (its AST without positions), so formatting isn't a change. Left
 * out: types, and a name shadowed by a local of the same name (counted as the top-level one).
 */

import type { WayIn } from "./features";
import type { Analyzer, DeclarationGraph, Package } from "./graph";
import { isEntry } from "@brianjenkins94/util/env";
import { parseSync } from "oxc-parser";
import { agentTool, codeArgumentsFrom, CLI_CALL, cliCommand, CREATE, CREATE_RECEIVER, isManifest, isSource, type ObjectReader, REGISTER, waysInManifest, words } from "./features";
import { candidates, nodeId, packageOf, reach, reachers, TOP } from "./graph";

/** One top-level declaration: what it is, as a fingerprint, and the names (declared or imported here) its code uses. */
export interface Declaration {
	"name": string;
	"fingerprint": string;
	"uses": string[];
	/** Where its code is in the file. */
	"start": number;
	"end": number;
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

		graph.declarations.push({ "name": name, "fingerprint": fingerprintOf(node), "uses": uses.sort(), "start": node.start, "end": node.end });
	}

	return graph;
}

// ── the AST ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A whole file's fingerprint (see `fingerprintOf`); its text, if it doesn't parse. */
export function fileFingerprint(file: string, text: string): string {
	if (!isSource(file)) {
		return text;
	}

	const { program, errors } = parseSync(file, text);

	return errors.length > 0 ? text : fingerprintOf(program);
}

/** A string literal's value, or a template literal's with nothing interpolated. */
function literal(node: Node | undefined): string | undefined {
	if (node?.type === "Literal" && typeof node["value"] === "string") {
		return node["value"];
	}

	if (node?.type === "TemplateLiteral" && node["expressions"].length === 0) {
		return node["quasis"][0]?.value.cooked ?? undefined;
	}

	return undefined;
}

/** Every literal an argument can be: `pace === "fast" ? "a" : "b"` registers both. */
function literals(node: Node | undefined): string[] {
	if (node?.type === "ConditionalExpression") {
		return [...literals(node["consequent"]), ...literals(node["alternate"])];
	}

	if (node?.type === "ParenthesizedExpression") {
		return literals(node["expression"]);
	}

	const value = literal(node);

	return value === undefined ? [] : [value];
}

const property = (object: Node, name: string): Node | undefined => object["properties"].find((each: Node) => each.type === "Property" && (each["key"].name ?? each["key"].value) === name)?.value;
const objects: ObjectReader<Node> = { "property": property, "literal": literal, "isObject": (node) => node?.type === "ObjectExpression", "left": (node) => (node?.type === "BinaryExpression" && node["operator"] === "+" ? node["left"] : undefined) };

// ── ways in ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The ways in a source file states. */
export function waysInSource(file: string, text: string): WayIn[] {
	const { program } = parseSync(file, text);
	const ways: WayIn[] = [];
	const source = (node: Node): string => text.slice(node.start, node.end);
	const imports = new Map<string, string>();
	const scope = topLevelNames(program);
	// A name made at run time (`virtual.debug.${port}`, `controlSubject(SESSION)`): keyed by how it's written.
	const isName = (node: Node | undefined): boolean => node !== undefined && ["TemplateLiteral", "Identifier", "CallExpression", "MemberExpression", "BinaryExpression"].includes(node.type);
	const spelled = (node: Node): string => source(node).replace(/\s+/gu, " ");
	let statement: Node = program;
	// The objects `command(…)` was given: CLI commands, not agent tools.
	const commands = new Set<Node>();

	for (const statement of program.body as Node[]) {
		if (statement.type === "ImportDeclaration") {
			for (const specifier of statement["specifiers"] as Node[]) {
				imports.set(specifier["local"].name, statement["source"].value);
			}
		}
	}

	const visit = (node: Node): void => {
		const before = ways.length;

		if (node.type === "CallExpression") {
			const callee = node["callee"] as Node;
			const name: string | undefined = callee.type === "MemberExpression" && !callee["computed"] ? callee["property"].name : callee.type === "Identifier" ? callee["name"] : undefined;
			const receiver = callee.type === "MemberExpression" ? source(callee["object"]) : "";
			const [first, second] = node["arguments"] as Node[];

			if (name === "registerCommand" || name === "registerTextEditorCommand") {
				for (const id of literals(first)) {
					ways.push({ "facet": "command", "side": "registered", "id": id, "label": "" });
				}
			} else if (name !== undefined && REGISTER.test(name)) {
				const facet = name === "registerWebviewViewProvider" || name === "registerTreeDataProvider" ? "view" : words(name.replace(/^register/u, "").replace(/(?:Provider|Factory)$/u, "")) + " provider";
				const id = literal(first);

				ways.push({ "facet": facet, ...facet === "view" ? { "side": "registered" } : {}, "id": id ?? "", "label": "", ...id === undefined ? { "weak": true } : {} });
			} else if (name !== undefined && CREATE.test(name) && CREATE_RECEIVER.test(receiver)) {
				const facet = name === "createTreeView" ? "view" : words(name.replace(/^create/u, ""));
				const id = literal(first);

				ways.push({ "facet": facet, ...facet === "view" ? { "side": "registered" } : {}, "id": id ?? "", "label": literal(second) ?? "", ...id === undefined ? { "weak": true } : {} });
			} else if (name === "serve" && (node["arguments"] as Node[]).length >= 3 && (literal(second) !== undefined || (first !== undefined && /hub/iu.test(source(first)) && isName(second)))) {
				ways.push({ "facet": "hub request", "id": literal(second) ?? spelled(second), "label": "" });
			} else if (name === "subscribe" && /hub/iu.test(receiver) && (literal(first) !== undefined || isName(first))) {
				ways.push({ "facet": "hub subscription", "id": literal(first) ?? spelled(first), "label": "" });
			} else if (name === "defineCommand" && literal(first) !== undefined) {
				ways.push({ "facet": "terminal command", "id": literal(first), "label": "" });
			} else if ((name === "get" || name === "has" || name === "getAll") && literal(first) !== undefined && receiver.includes("location") && /URLSearchParams|search/u.test(receiver)) {
				ways.push({ "facet": "url parameter", "id": "?" + literal(first), "label": "" });
			} else if (name === "addEventListener" && (literal(first) === "message" || literal(first) === "connect") && node === statement["expression"] && /^(?:|globalThis|self)$/u.test(receiver)) {
				ways.push({ "facet": "worker", "id": "", "label": "", "weak": true });
			} else if (name !== undefined && /^install[A-Z]/u.test(name) && callee.type === "Identifier" && imports.get(name)?.startsWith(".") === true) {
				// What it is: the module's `install…` function, and what that reaches (its `roots`).
				ways.push({ "facet": "core module", "id": name, "label": "" });
			} else if (name === CLI_CALL && first?.type === "ObjectExpression") {
				// Shaped like an agent tool, but it isn't one.
				const command = cliCommand(first, objects);

				commands.add(first);

				if (command !== undefined) {
					ways.push(command);
				}
			}
		} else if (node.type === "AssignmentExpression" && node === statement["expression"] && /^(?:(?:globalThis|self)\.)?on(?:message|connect)$/u.test(source(node["left"]))) {
			ways.push({ "facet": "worker", "id": "", "label": "", "weak": true });
		} else if (node.type === "ObjectExpression" && !commands.has(node)) {
			const tool = agentTool(node, objects);

			if (tool !== undefined) {
				ways.push(tool);
			}
		} else if (node.type === "JSXOpeningElement" && /button/iu.test(source(node["name"]))) {
			const attribute = (name: string): Node | undefined => (node["attributes"] as Node[]).find((each) => each.type === "JSXAttribute" && source(each["name"]) === name);
			const label = literal(attribute("aria-label")?.["value"]) ?? literal(attribute("title")?.["value"]);

			if (label !== undefined) {
				ways.push({ "facet": "button", "id": label, "label": attribute("onClick") !== undefined || attribute("ref") !== undefined ? "" : "no handler" });
			}
		}

		if (ways.length > before) {
			const code = fingerprintOf(node);
			// A registering call's own code is what follows its name (codeArgumentsFrom): not the API that registers it.
			const from = node.type === "CallExpression" ? codeArgumentsFrom(ways[before]!.facet) : undefined;
			const uses = [...new Set((from === undefined ? [node] : (node["arguments"] as Node[]).slice(from)).flatMap((each) => topLevelUses(each, statement, scope)))].sort();

			for (let index = before; index < ways.length; index++) {
				ways[index].code = code;
				ways[index].roots = uses.map((used) => nodeId(file, used));
				ways[index].range = [node.start, node.end];
			}
		}
	};

	for (statement of program.body as Node[]) {
		walk(statement, visit);
	}

	return ways;
}

/** The ways in a file states: a manifest's, a source file's, or none. A file that doesn't parse states none. */
export function waysIn(file: string, text: string): WayIn[] {
	if (isManifest(file)) {
		return waysInManifest(text);
	}

	if (!isSource(file)) {
		return [];
	}

	try {
		return waysInSource(file, text);
	} catch {
		return [];
	}
}

// ── oxc's graph ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * oxc's declaration graph: every file's declarations and imports, resolved across files by name. Built per snapshot
 * from the files' `FileGraph`s (each computed once per version), so building one is a walk over what's already parsed.
 */
export class ProgramGraph implements DeclarationGraph {
	readonly "files": ReadonlyMap<string, FileGraph>;
	/** Each declaration's fingerprint, by node id. */
	readonly "fingerprints" = new Map<string, string>();
	readonly #edges = new Map<string, string[]>();
	readonly #bodied = new Set<string>();

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

	range(id: string): { "file": string; "start": number; "end": number } | undefined {
		const hash = id.lastIndexOf("#");
		const file = id.slice(0, hash);
		const found = this.files.get(file)?.declarations.find((declaration) => declaration.name === id.slice(hash + 1));

		return found === undefined ? undefined : { "file": file, "start": found.start, "end": found.end };
	}

	nodes(): Iterable<string> {
		const ids: string[] = [];

		for (const [file, graph] of this.files) {
			for (const declaration of graph.declarations) {
				ids.push(nodeId(file, declaration.name));

				// A namespace's members are nodes of their own (`ns.name`).
				for (const used of declaration.uses) {
					if (used.includes(".")) {
						ids.push(nodeId(file, used));
					}
				}
			}

			for (const local of Object.keys(graph.imports)) {
				ids.push(nodeId(file, local));
			}
		}

		return ids;
	}

	reach(roots: Iterable<string>): Set<string> {
		return reach(this, roots);
	}

	reachers(targets: Iterable<string>): Map<string, string> {
		return reachers(this, targets);
	}
}

/** oxc's analyzer: each file version parsed once (its ways in and `fileGraph`, cached by content id), names resolved by
 *  `ProgramGraph`. */
export function oxcAnalyzer(): Analyzer {
	const cache = new Map<string, FileGraph | Package | null>();
	const waysCache = new Map<string, WayIn[]>();

	return {
		"analyze": async (files, read) => {
			const graphs = new Map<string, FileGraph>();
			const packages: Package[] = [];
			const ways = new Map<string, WayIn[]>();

			for (const [path, oid] of files) {
				// By path too: a way's roots name its file, so the same text moved is different ways.
				const key = oid + ":" + path;
				let found = waysCache.get(key);

				if (found === undefined) {
					found = waysIn(path, await read(oid));
					waysCache.set(key, found);
				}

				ways.set(path, found);
			}

			for (const [path, oid] of files) {
				const manifest = /(^|\/)package\.json$/u.test(path);

				if (!manifest && !/\.[cm]?[jt]sx?$/u.test(path)) {
					continue;
				}

				// A manifest's package names its folder, so the same text in two places is two packages.
				const key = manifest ? oid + ":" + path : oid;
				let found = cache.get(key);

				if (found === undefined) {
					const text = await read(oid);

					try {
						found = (manifest ? packageOf(path, text) : fileGraph(path, text)) ?? null;
					} catch {
						found = null; // doesn't parse: no declarations
					}

					cache.set(key, found);
				}

				if (found !== null && manifest) {
					packages.push(found as Package);
				} else if (found !== null) {
					graphs.set(path, found as FileGraph);
				}
			}

			return { "graph": new ProgramGraph(graphs, packages), "ways": ways };
		}
	};
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
