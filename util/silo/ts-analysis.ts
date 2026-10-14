/**
 * silo — what a program says about itself, read from TypeScript's own tree (pure, any host): each file's ways in (the
 * recognizers whose patterns are `./features`') and its part of the declaration graph (`./graph`), with every name
 * resolved by TypeScript's checker. One reading, two hosts:
 *
 *   • TypeScript 7.1's API, in Node — `./typescript` (silo's command line, with the TypeScript it bundles);
 *   • a TypeScript server's own TypeScript, in-process — `classicHost` here: the editor's history plugin, which reads the
 *     program the server already holds, edits as they're typed included.
 *
 * Both present the same tree (kinds, `pos`/`end`, `parent`, `text`, the same properties), so the only difference is how a
 * name is resolved — a `TsHost`. A file's result (`FileAnalysis`) is plain JSON, so a plugin can hand it over as it is;
 * `analysisOf` makes a program's `Analysis` of them.
 *
 * Ids: a feature keyed by what it is, a node by its file's own name for it (`file#name`; a module's body `#(top)`; an
 * import by its local name), so either host's output reads the same downstream.
 */

import type { WayIn } from "./features";
import type { Analysis, DeclarationGraph } from "./graph";
import { agentTool, codeArgumentsFrom, CLI_CALL, cliCommand, CREATE, CREATE_RECEIVER, type ObjectReader, REGISTER, words } from "./features";
import { isEntry } from "@brianjenkins94/util/env";
import { candidates, nodeId, TOP } from "./graph";

/** A node of TypeScript's tree, as either host presents it. */
export interface TsNode { "kind": number; "pos": number; "end": number; "parent"?: TsNode; "text"?: string; [key: string]: any }

/** A symbol, as a host hands it out: an id to know it again, and whether it's an alias (an import). */
export interface TsSymbol { "id": number | string; "alias": boolean }

/** How a host answers what the reading needs of its TypeScript. */
export interface TsHost {
	/** SyntaxKind's number for a name. (By number, never by name: SyntaxKind has aliases — a variable statement's number is
	 *  `FirstStatement` too — so a name read back from a number can be the alias.) */
	kind(name: string): number;
	/** Each child of a node, in order. */
	children(node: TsNode, visit: (child: TsNode) => void): void;
	/** What each of `nodes` (names) is: a batch, so a host across a process asks once. */
	symbols(nodes: readonly TsNode[]): (TsSymbol | undefined)[];
	/** What an alias names (an import, followed through re-exports). */
	aliased(symbol: TsSymbol): TsSymbol | undefined;
	/** Where a symbol is declared: the program's file (relative to the program's root) and the node; undefined for one
	 *  outside the program (a library, a package). */
	declaration(symbol: TsSymbol): { "file": string; "node": TsNode } | undefined;
	/** Whether a (relative) path is one of the program's files — for a module that exports nothing, so has no symbol. */
	has(file: string): boolean;
}

/** One version of a file, read: its ways in, and its part of the declaration graph. Plain JSON. */
export interface FileAnalysis {
	/** What it was read from (a content id, a file version). */
	"version": string;
	"ways": WayIn[];
	/** Each declaration (and the body, `(top)`): its fingerprint, and the node ids its code uses. */
	"declarations": Record<string, { "fingerprint": string; "uses": string[]; "range"?: [number, number] }>;
	/** Each import, by its local name: what it names, and the body of the module it's from. */
	"imports": Record<string, string[]>;
	/** A namespace import's local name → the file it names (for `ns.member`). */
	"namespaces": Record<string, string>;
	/** The files its body runs (what it imports and re-exports from). */
	"modules": string[];
	/** The files whose change could change what its names resolve to: read again when one changes. */
	"dependsOn": string[];
}

/** Read one file of the program, with `host` answering for its TypeScript. `text` is its source (for a name written at
 *  run time, keyed by how it's written). */
export function analyzeFile(host: TsHost, path: string, file: TsNode, text: string, version: string): FileAnalysis {
	const kind = host.kind.bind(host);
	const is = (node: TsNode | undefined, name: string): boolean => node !== undefined && node.kind === kind(name);
	const each = (node: TsNode, visit: (child: TsNode) => void): void => {
		host.children(node, visit);
	};
	const analysis: FileAnalysis = { "version": version, "ways": [], "declarations": {}, "imports": {}, "namespaces": {}, "modules": [], "dependsOn": [] };

	const TEXT_KINDS = new Set(["Identifier", "PrivateIdentifier", "StringLiteral", "NumericLiteral", "BigIntLiteral", "NoSubstitutionTemplateLiteral", "TemplateHead", "TemplateMiddle", "TemplateTail", "RegularExpressionLiteral", "JsxText"].map(kind));
	// Type positions: what's under them names types, which change no behavior. (A class's `extends` names a value.)
	const TYPE_NODES = new Set(["TypeReference", "TypeLiteral", "TypeQuery", "TypeParameter", "TypePredicate", "TypeOperator", "UnionType", "IntersectionType", "ArrayType", "TupleType", "FunctionType", "ConstructorType", "ConditionalType", "IndexedAccessType", "MappedType", "LiteralType", "ImportType", "InferType", "OptionalType", "RestType", "ParenthesizedType", "ThisType", "TemplateLiteralType", "InterfaceDeclaration", "TypeAliasDeclaration"].map(kind));
	const isTypeNode = (node: TsNode): boolean => TYPE_NODES.has(node.kind) || (is(node, "HeritageClause") && node["token"] !== kind("ExtendsKeyword"));
	const isDeclare = (node: TsNode): boolean => (node["modifiers"] ?? []).some((modifier: TsNode) => is(modifier, "DeclareKeyword"));
	const isTypeStatement = (node: TsNode): boolean => is(node, "InterfaceDeclaration") || is(node, "TypeAliasDeclaration") || (is(node, "ModuleDeclaration") && is(node["name"], "StringLiteral")) || isDeclare(node);

	// ── reading ───────────────────────────────────────────────────────────────────────────────────────────

	/** A node's fingerprint: its kinds and its names' and literals' text, without positions, trivia or comments. */
	function fingerprint(node: TsNode): string {
		let out = String(node.kind);

		if (TEXT_KINDS.has(node.kind) && typeof node.text === "string") {
			out += ":" + JSON.stringify(node.text);
		}

		const children: string[] = [];

		each(node, (child) => {
			children.push(fingerprint(child));
		});

		return children.length === 0 ? out : out + "(" + children.join(",") + ")";
	}

	/** Where a node's own text starts: past the whitespace and comments `pos` includes. */
	function startOf(node: TsNode): number {
		let at = node.pos;

		for (;;) {
			while (at < node.end && /\s/u.test(text[at]!)) {
				at += 1;
			}

			if (text.startsWith("//", at)) {
				const line = text.indexOf("\n", at);

				at = line < 0 ? node.end : line + 1;
			} else if (text.startsWith("/*", at)) {
				const close = text.indexOf("*/", at + 2);

				at = close < 0 ? node.end : close + 2;
			} else {
				return at;
			}
		}
	}

	const source = (node: TsNode): string => text.slice(startOf(node), node.end);

	/** A string literal's value, or a template's with nothing interpolated. */
	const literal = (node: TsNode | undefined): string | undefined => (is(node, "StringLiteral") || is(node, "NoSubstitutionTemplateLiteral") ? node!.text : undefined);

	/** Every literal an argument can be: `pace === "fast" ? "a" : "b"` registers both. */
	function literals(node: TsNode | undefined): string[] {
		if (is(node, "ConditionalExpression")) {
			return [...literals(node!["whenTrue"]), ...literals(node!["whenFalse"])];
		}

		if (is(node, "ParenthesizedExpression")) {
			return literals(node!["expression"]);
		}

		const value = literal(node);

		return value === undefined ? [] : [value];
	}

	/** The names a binding declares: `a`, `{ a, b: c }`, `[a, ...rest]`. */
	function bindingNames(name: TsNode | undefined): TsNode[] {
		if (name === undefined) {
			return [];
		}

		if (is(name, "Identifier")) {
			return [name];
		}

		const names: TsNode[] = [];

		each(name, (child) => {
			if (is(child, "BindingElement")) {
				names.push(...bindingNames(child["name"]));
			}
		});

		return names;
	}

	/** A top-level statement's declarations, as [name, the node that is its code]. */
	function declarationsOf(statement: TsNode): [string, TsNode][] {
		if (is(statement, "FunctionDeclaration") || is(statement, "ClassDeclaration") || is(statement, "EnumDeclaration")) {
			const isDefault = (statement["modifiers"] ?? []).some((modifier: TsNode) => is(modifier, "DefaultKeyword"));
			const name = statement["name"]?.text ?? (isDefault ? "default" : "");

			return name === "" ? [] : [[name, statement]];
		}

		if (is(statement, "VariableStatement")) {
			return [...statement["declarationList"]["declarations"]].flatMap((declarator: TsNode) => bindingNames(declarator["name"]).map((name): [string, TsNode] => [name.text!, declarator]));
		}

		return is(statement, "ExportAssignment") ? [["default", statement]] : [];
	}

	/** The top-level statement a node is in. */
	function statementOf(node: TsNode): TsNode | undefined {
		let at: TsNode | undefined = node;

		while (at?.parent !== undefined && !is(at.parent, "SourceFile")) {
			at = at.parent;
		}

		return at;
	}

	/** Which of its file's own names a node is part of: a declaration's, an import's local, the body's, or none (a type). */
	function ownerName(statement: TsNode, node: TsNode): string | undefined {
		if (is(statement, "ImportDeclaration")) {
			const clause = statement["importClause"];
			let local: string | undefined;

			if (clause === undefined) {
				return undefined;
			}

			if (clause["name"] !== undefined && clause["name"].pos <= node.pos && node.end <= clause["name"].end) {
				return clause["name"].text;
			}

			const visit = (child: TsNode): void => {
				if (local === undefined && child.pos <= node.pos && node.end <= child.end && (is(child, "ImportSpecifier") || is(child, "NamespaceImport"))) {
					local = child["name"].text;
				}

				each(child, visit);
			};

			visit(clause);

			return local;
		}

		if (isTypeStatement(statement) || is(statement, "ExportDeclaration")) {
			return undefined;
		}

		const declared = declarationsOf(statement);

		if (declared.length === 0) {
			return TOP;
		}

		// The declarator the node is in; else the statement's first.
		return (declared.find(([, code]) => code.pos <= node.pos && node.end <= code.end) ?? declared[0])![0];
	}

	// ── resolving names ───────────────────────────────────────────────────────────────────────────────────

	const located = new Map<string, string | null>();

	/** The node a symbol is in the program's graph — the name its declaration's file has for it. An import stays that
	 *  import (it leads on to what it names, and to the bodies importing runs); `follow` resolves it, for its own edge. */
	function locate(symbol: TsSymbol | undefined, follow = false): string | null {
		if (symbol === undefined) {
			return null;
		}

		const target = follow && symbol.alias ? host.aliased(symbol) : symbol;

		if (target === undefined) {
			return null;
		}

		const key = String(target.id) + (follow ? "+" : "");

		if (located.has(key)) {
			return located.get(key)!;
		}

		const declaration = host.declaration(target);
		const statement = declaration === undefined ? undefined : statementOf(declaration.node);
		const name = statement === undefined ? undefined : ownerName(statement, declaration!.node);
		// An alias that's no name of its file's own (a re-export, `export { a } from`) is what it names.
		const id = name === undefined ? (!follow && symbol.alias ? locate(symbol, true) : null) : nodeId(declaration!.file, name);

		located.set(key, id);

		return id;
	}

	/** The identifiers under `node` that can name a value: not in a type, not `skip` (a declaration's own name). */
	function identifiers(node: TsNode, skip?: TsNode): TsNode[] {
		const found: TsNode[] = [];
		const visit = (child: TsNode): void => {
			if (isTypeNode(child)) {
				return;
			}

			if (is(child, "Identifier") && child !== skip) {
				found.push(child);
			}

			each(child, visit);
		};

		visit(node);

		return found;
	}

	/**
	 * Where a way in's code leads, as node ids: what its names are — and for a local of the function it's registered in
	 * (`const runner = createRunner(); registerCommand("x", () => runner.go())`), what that local is made from, followed
	 * until the names are the file's own or another file's.
	 */
	function rootsOf(nodes: readonly TsNode[], statement: TsNode): string[] {
		const roots = new Set<string>();
		const seen = new Set<TsNode>();
		let pending = nodes.flatMap((node) => identifiers(node));

		while (pending.length > 0) {
			const symbols = host.symbols(pending);
			const next: TsNode[] = [];

			for (const symbol of symbols) {
				const declaration = symbol === undefined || symbol.alias ? undefined : host.declaration(symbol);

				// A local of the statement it's registered in: what it's made from.
				if (declaration !== undefined && declaration.file === path && statement.pos <= declaration.node.pos && declaration.node.end <= statement.end && statementOf(declaration.node) === statement && declaration.node !== statement) {
					if (!seen.has(declaration.node) && !nodes.some((node) => node.pos <= declaration.node.pos && declaration.node.end <= node.end)) {
						seen.add(declaration.node);
						next.push(...identifiers(declaration.node, declaration.node["name"]));
					}

					continue;
				}

				const id = locate(symbol);

				if (id !== null) {
					roots.add(id);
				}
			}

			pending = next;
		}

		return [...roots].sort();
	}

	// ── ways in ───────────────────────────────────────────────────────────────────────────────────────────

	const imports = new Map<string, string>();

	for (const statement of file["statements"] as TsNode[]) {
		if (is(statement, "ImportDeclaration")) {
			const clause = statement["importClause"];
			const from = literal(statement["moduleSpecifier"]) ?? "";

			if (clause?.["name"] !== undefined) {
				imports.set(clause["name"].text, from);
			}

			each(clause ?? statement, (child) => {
				if (is(child, "NamedImports")) {
					for (const element of child["elements"]) {
						imports.set(element["name"].text, from);
					}
				} else if (is(child, "NamespaceImport")) {
					imports.set(child["name"].text, from);
				}
			});
		}
	}

	// A name made at run time (`virtual.debug.${port}`, `controlSubject(SESSION)`): keyed by how it's written.
	const isName = (node: TsNode | undefined): boolean => node !== undefined && ["TemplateExpression", "Identifier", "CallExpression", "PropertyAccessExpression", "ElementAccessExpression", "BinaryExpression"].some((name) => is(node, name));
	const spelled = (node: TsNode): string => source(node).replace(/\s+/gu, " ");
	const property = (object: TsNode, key: string): TsNode | undefined => {
		for (const member of object["properties"] as TsNode[]) {
			const name = member["name"];
			const named = name === undefined ? undefined : is(name, "Identifier") || is(name, "StringLiteral") ? name.text : undefined;

			if (named === key) {
				return is(member, "PropertyAssignment") ? member["initializer"] : member;
			}
		}

		return undefined;
	};

	const objects: ObjectReader<TsNode> = { "property": property, "literal": literal, "isObject": (node) => is(node, "ObjectLiteralExpression"), "left": (node) => (is(node, "BinaryExpression") && is(node["operatorToken"], "PlusToken") ? node["left"] : undefined) };
	// The objects `command(…)` was given: CLI commands, not agent tools.
	const commands = new Set<TsNode>();

	function waysAt(node: TsNode, statement: TsNode): WayIn[] {
		const ways: WayIn[] = [];

		if (is(node, "CallExpression")) {
			const callee = node["expression"] as TsNode;
			const name: string | undefined = is(callee, "PropertyAccessExpression") ? callee["name"].text : is(callee, "Identifier") ? callee.text : undefined;
			const receiver = is(callee, "PropertyAccessExpression") ? source(callee["expression"]) : "";
			const args = [...node["arguments"]] as TsNode[];
			const [first, second] = args;

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
			} else if (name === "serve" && args.length >= 3 && (literal(second) !== undefined || (first !== undefined && /hub/iu.test(source(first)) && isName(second)))) {
				ways.push({ "facet": "hub request", "id": literal(second) ?? spelled(second!), "label": "" });
			} else if (name === "subscribe" && /hub/iu.test(receiver) && (literal(first) !== undefined || isName(first))) {
				ways.push({ "facet": "hub subscription", "id": literal(first) ?? spelled(first!), "label": "" });
			} else if (name === "defineCommand" && literal(first) !== undefined) {
				ways.push({ "facet": "terminal command", "id": literal(first)!, "label": "" });
			} else if ((name === "get" || name === "has" || name === "getAll") && literal(first) !== undefined && receiver.includes("location") && /URLSearchParams|search/u.test(receiver)) {
				ways.push({ "facet": "url parameter", "id": "?" + literal(first)!, "label": "" });
			} else if (name === "addEventListener" && (literal(first) === "message" || literal(first) === "connect") && is(statement, "ExpressionStatement") && statement["expression"] === node && /^(?:|globalThis|self)$/u.test(receiver)) {
				ways.push({ "facet": "worker", "id": "", "label": "", "weak": true });
			} else if (name !== undefined && /^install[A-Z]/u.test(name) && is(callee, "Identifier") && imports.get(name)?.startsWith(".") === true) {
				ways.push({ "facet": "core module", "id": name, "label": "" });
			} else if (name === CLI_CALL && is(first, "ObjectLiteralExpression")) {
				// Shaped like an agent tool, but it isn't one.
				const command = cliCommand(first, objects);

				commands.add(first);

				if (command !== undefined) {
					ways.push(command);
				}
			}
		} else if (is(node, "BinaryExpression") && is(node["operatorToken"], "EqualsToken") && is(statement, "ExpressionStatement") && statement["expression"] === node && /^(?:(?:globalThis|self)\.)?on(?:message|connect)$/u.test(source(node["left"]))) {
			ways.push({ "facet": "worker", "id": "", "label": "", "weak": true });
		} else if (is(node, "ObjectLiteralExpression") && !commands.has(node)) {
			const tool = agentTool(node, objects);

			if (tool !== undefined) {
				ways.push(tool);
			}
		} else if ((is(node, "JsxOpeningElement") || is(node, "JsxSelfClosingElement")) && /button/iu.test(source(node["tagName"]))) {
			const attribute = (attributeName: string): TsNode | undefined => [...node["attributes"]["properties"]].find((each: TsNode) => is(each, "JsxAttribute") && source(each["name"]) === attributeName);
			const label = literal(attribute("aria-label")?.["initializer"]) ?? literal(attribute("title")?.["initializer"]);

			if (label !== undefined) {
				ways.push({ "facet": "button", "id": label, "label": attribute("onClick") !== undefined || attribute("ref") !== undefined ? "" : "no handler" });
			}
		}

		if (ways.length > 0) {
			const code = fingerprint(node);
			// A registering call's own code is what follows its name (codeArgumentsFrom): not the API that registers it.
			const from = is(node, "CallExpression") ? codeArgumentsFrom(ways[0]!.facet) : undefined;
			const roots = rootsOf(from === undefined ? [node] : [...node["arguments"]].slice(from), statement);

			for (const way of ways) {
				way.code = code;
				way.range = [startOf(node), node.end];
				way.roots = roots;
			}
		}

		return ways;
	}

	for (const statement of file["statements"] as TsNode[]) {
		const visit = (node: TsNode): void => {
			analysis.ways.push(...waysAt(node, statement));
			each(node, visit);
		};

		visit(statement);
	}

	// ── the graph ─────────────────────────────────────────────────────────────────────────────────────────

	const body: TsNode[] = [];
	const code: [string, TsNode][] = [];
	// Each import's local name, its name node, and which module specifier it's from.
	const importNames: [string, TsNode, number][] = [];
	const moduleNodes: TsNode[] = [];

	for (const statement of file["statements"] as TsNode[]) {
		if (is(statement, "ImportDeclaration")) {
			const clause = statement["importClause"];

			if (clause?.["isTypeOnly"] === true) {
				continue;
			}

			const module = moduleNodes.push(statement["moduleSpecifier"]) - 1;

			if (clause?.["name"] !== undefined) {
				importNames.push([clause["name"].text, clause["name"], module]);
			}

			const bindings = clause?.["namedBindings"];

			if (is(bindings, "NamespaceImport")) {
				importNames.push([bindings["name"].text, bindings["name"], module]);
			} else if (bindings !== undefined) {
				for (const element of bindings["elements"]) {
					if (element["isTypeOnly"] !== true) {
						importNames.push([element["name"].text, element["name"], module]);
					}
				}
			}
		} else if (is(statement, "ExportDeclaration")) {
			if (statement["moduleSpecifier"] !== undefined && statement["isTypeOnly"] !== true) {
				moduleNodes.push(statement["moduleSpecifier"]);
			}
		} else if (isTypeStatement(statement)) {
			continue;
		} else if (declarationsOf(statement).length > 0) {
			code.push(...declarationsOf(statement));
		} else {
			body.push(statement);
		}
	}

	// Every name each declaration's code uses (and the body's), resolved in one batch.
	const owners: [string, TsNode][] = [
		...code.flatMap(([name, node]) => identifiers(node, node["name"]).map((identifier): [string, TsNode] => [name, identifier])),
		...body.flatMap((statement) => identifiers(statement).map((identifier): [string, TsNode] => [TOP, identifier]))
	];
	const symbols = owners.length === 0 ? [] : host.symbols(owners.map(([, node]) => node));
	const importSymbols = importNames.length === 0 ? [] : host.symbols(importNames.map(([, node]) => node));
	const moduleSymbols = moduleNodes.length === 0 ? [] : host.symbols(moduleNodes);
	const uses = new Map<string, Set<string>>();

	owners.forEach(([owner], index) => {
		const id = locate(symbols[index]);

		if (id !== null && id !== nodeId(path, owner)) {
			uses.set(owner, (uses.get(owner) ?? new Set()).add(id));
		}
	});

	for (const [name, node] of code) {
		const existing = analysis.declarations[name];

		analysis.declarations[name] = { "fingerprint": (existing === undefined ? "" : existing.fingerprint + "|") + fingerprint(node), "uses": [...uses.get(name) ?? []].sort(), "range": existing?.range ?? [startOf(node), node.end] };
	}

	const moduleFiles: (string | undefined)[] = moduleNodes.map((node, index) => {
		const declaration = moduleSymbols[index] === undefined ? undefined : host.declaration(moduleSymbols[index]!);

		// A module that exports nothing has no symbol (`import "./handlers/calls"`): its path, then.
		return declaration?.file ?? candidates(path, literal(node) ?? "").find((candidate) => host.has(candidate));
	});

	moduleNodes.forEach((node, index) => {
		const target = moduleFiles[index];

		if (target === undefined) {
			return;
		}

		if (!analysis.modules.includes(target)) {
			analysis.modules.push(target);
		}

		// A namespace import's module, for `ns.member`.
		const bindings = node.parent?.["importClause"]?.["namedBindings"];

		if (is(bindings, "NamespaceImport")) {
			analysis.namespaces[bindings["name"].text] = target;
		}
	});

	// An import leads to what it names, and to the body of the module it's from (a barrel's, which runs its re-exports).
	importNames.forEach(([local, , module], index) => {
		const id = locate(importSymbols[index], true);
		const from = moduleFiles[module];

		analysis.imports[local] = [...id === null ? [] : [id], ...from === undefined ? [] : [nodeId(from, TOP)]];
	});

	if (body.length > 0 || analysis.modules.length > 0) {
		analysis.declarations[TOP] = { "fingerprint": body.map(fingerprint).join("|"), "uses": [...uses.get(TOP) ?? []].sort() };
	}

	const dependsOn = new Set<string>(analysis.modules);

	for (const ids of [...Object.values(analysis.declarations).map((declaration) => declaration.uses), ...Object.values(analysis.imports), ...analysis.ways.map((way) => way.roots ?? [])]) {
		for (const id of ids) {
			dependsOn.add(id.slice(0, id.lastIndexOf("#")));
		}
	}

	dependsOn.delete(path);
	analysis.dependsOn = [...dependsOn].sort();

	return analysis;
}

/** Whether a file's analysis needs reading again: it changed (`version`), or a file it resolves names into did. */
export function stale(analysis: FileAnalysis | undefined, version: string, changed: ReadonlySet<string>): boolean {
	return analysis === undefined || analysis.version !== version || analysis.dependsOn.some((file) => changed.has(file));
}

/** A program's analysis from its files' (and the ways in its manifests state, by path). */
export function analysisOf(files: ReadonlyMap<string, FileAnalysis>, manifests: ReadonlyMap<string, WayIn[]> = new Map()): Analysis {
	const ways = new Map<string, WayIn[]>(manifests);

	for (const [path, analysis] of files) {
		ways.set(path, analysis.ways);
	}

	return { "graph": graphOf(files), "ways": ways };
}

/** The declaration graph of a set of read files. */
export function graphOf(files: ReadonlyMap<string, FileAnalysis>): DeclarationGraph {
	const fingerprints = new Map<string, string>();

	for (const [path, analysis] of files) {
		for (const [name, { fingerprint }] of Object.entries(analysis.declarations)) {
			fingerprints.set(nodeId(path, name), fingerprint);
		}
	}

	return {
		"fingerprints": fingerprints,
		"range": (id) => {
			const hash = id.lastIndexOf("#");
			const range = files.get(id.slice(0, hash))?.declarations[id.slice(hash + 1)]?.range;

			return range === undefined ? undefined : { "file": id.slice(0, hash), "start": range[0], "end": range[1] };
		},
		"nodes": () => [...files].flatMap(([path, analysis]) => [...Object.keys(analysis.declarations), ...Object.keys(analysis.imports)].map((name) => nodeId(path, name))),
		"edges": (id) => {
			const hash = id.lastIndexOf("#");
			const [path, name] = [id.slice(0, hash), id.slice(hash + 1)];
			const analysis = files.get(path);

			if (analysis === undefined) {
				return [];
			}

			const declaration = analysis.declarations[name];

			if (declaration !== undefined) {
				// A module's body runs the bodies of the modules it imports.
				return name === TOP ? [...declaration.uses, ...analysis.modules.map((module) => nodeId(module, TOP)).filter((top) => fingerprints.has(top))] : declaration.uses;
			}

			const imported = analysis.imports[name];

			if (imported !== undefined) {
				// What it names, and the bodies importing it runs (the module it's from, and the one that declares it).
				const declaring = imported[0]?.slice(0, imported[0].lastIndexOf("#"));

				return [...new Set([...imported, ...declaring === undefined ? [] : [nodeId(declaring, TOP)]])].filter((target) => !target.endsWith("#" + TOP) || fingerprints.has(target));
			}

			// `ns.member`: the member of the module a namespace import names.
			const dot = name.indexOf(".");
			const module = dot > 0 ? analysis.namespaces[name.slice(0, dot)] : undefined;

			return module === undefined ? [] : [nodeId(module, name.slice(dot + 1))].filter((target) => fingerprints.has(target));
		}
	};
}

// ── the in-process host ──────────────────────────────────────────────────────────────────────────────────────

/** One text read on its own by a classic TypeScript (≤ 6, in process: a TypeScript server's, a `typescript` package's)
 *  — no other files, so a name resolves within it alone. A file read apart from its program: a single buffer, a test. */
export function readText(ts: any, file: string, text: string, version = "v1"): FileAnalysis {
	const options = { "allowJs": true, "noLib": true, "noResolve": true };
	const host = { ...ts.createCompilerHost(options), "fileExists": (name: string) => name === "/r/" + file, "readFile": () => text, "getSourceFile": (name: string, target: unknown) => ts.createSourceFile(name, text, target, true) };
	const program = ts.createProgram(["/r/" + file], options, host);

	return analyzeFile(classicHost(ts, program, (name) => name.slice(3)), file, program.getSourceFile("/r/" + file), text, version);
}

/**
 * The host for TypeScript's in-process API (a TypeScript server's, a `typescript` package's): `ts` the module, `program`
 * its program, `relative` a file's path in the program's own terms (undefined for one outside it: a library, a package).
 */
export function classicHost(ts: any, program: any, relative: (fileName: string) => string | undefined): TsHost {
	const checker = program.getTypeChecker();
	const ids = new WeakMap<object, number>();
	const symbols = new Map<number, any>();
	let next = 0;
	let files: Set<string> | undefined;
	const wrap = (symbol: any): TsSymbol | undefined => {
		if (symbol === undefined) {
			return undefined;
		}

		let id = ids.get(symbol);

		if (id === undefined) {
			next += 1;
			id = next;
			ids.set(symbol, id);
			symbols.set(id, symbol);
		}

		return { "id": id, "alias": (symbol.flags & ts.SymbolFlags.Alias) !== 0 };
	};

	return {
		"kind": (name) => ts.SyntaxKind[name] as number,
		"children": (node, visit) => {
			ts.forEachChild(node, (child: TsNode) => {
				visit(child);
			});
		},
		"symbols": (nodes) => nodes.map((node) => {
			try {
				return wrap(checker.getSymbolAtLocation(node));
			} catch {
				return undefined;
			}
		}),
		"aliased": (symbol) => {
			try {
				return wrap(checker.getAliasedSymbol(symbols.get(symbol.id as number)));
			} catch {
				return undefined;
			}
		},
		"declaration": (symbol) => {
			const raw = symbols.get(symbol.id as number);
			const node = raw?.valueDeclaration ?? raw?.declarations?.[0];
			let source = node;

			while (source !== undefined && source.kind !== ts.SyntaxKind.SourceFile) {
				source = source.parent;
			}

			const file = source === undefined ? undefined : relative(source.fileName);

			return file === undefined ? undefined : { "file": file, "node": node };
		},
		"has": (file) => {
			files ??= new Set(program.getSourceFiles().map((source: any) => relative(source.fileName)).filter((each: string | undefined) => each !== undefined));

			return files.has(file);
		}
	};
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// lib's own TypeScript: the in-process API a TypeScript server has. (A specifier made at run time, so a bundler of
		// this module doesn't follow it into a copy of TypeScript: the tests only run here.)
		const ts: typeof import("typescript") = (await import(/* @vite-ignore */ ["typescript"].join(""))).default;
		const { featuresOf } = await import("./features");
		const { reach } = await import("./graph");

		/** A program over in-memory files, read with the in-process host. */
		function analyze(files: Record<string, string>): { "analysis": ReturnType<typeof analysisOf>; "features": ReturnType<typeof featuresOf> } {
			const options = { "module": ts.ModuleKind.ESNext, "moduleResolution": ts.ModuleResolutionKind.Bundler, "target": ts.ScriptTarget.ESNext, "allowJs": true, "jsx": ts.JsxEmit.Preserve, "noLib": true };
			const base = ts.createCompilerHost(options);
			const host = { ...base, "fileExists": (name: string) => "/r/" + name.replace(/^\/r\//u, "") in Object.fromEntries(Object.keys(files).map((file) => ["/r/" + file, true])), "readFile": (name: string) => files[name.replace(/^\/r\//u, "")], "getSourceFile": (name: string, target: any) => (files[name.replace(/^\/r\//u, "")] === undefined ? undefined : ts.createSourceFile(name, files[name.replace(/^\/r\//u, "")]!, target, true)), "getCurrentDirectory": () => "/r", "useCaseSensitiveFileNames": () => true, "getCanonicalFileName": (name: string) => name, "directoryExists": () => true, "realpath": (name: string) => name, "getDirectories": () => [] };
			const program = ts.createProgram(Object.keys(files).map((file) => "/r/" + file), options, host);
			const reading = classicHost(ts, program, (fileName) => (fileName.startsWith("/r/") ? fileName.slice(3) : undefined));
			const analyses = new Map(Object.keys(files).map((file) => [file, analyzeFile(reading, file, program.getSourceFile("/r/" + file) as unknown as TsNode, files[file]!, "v1")]));
			const analysis = analysisOf(analyses);

			return { "analysis": analysis, "features": featuresOf([...analysis.ways].map(([file, ways]) => ({ "file": file, "ways": ways }))) };
		}

		// A hub name made at run time: `debug.${id}`, written so.
		const DEBUG = ["`debug.$", "{id}`"].join("");
		const { analysis, features } = analyze({
			"x/extension.ts": "import { makeRunner } from \"./runner\";\nimport * as text from \"./text\";\nexport function activate() {\n\tconst runner = makeRunner();\n\tvscode.commands.registerCommand(\"run.go\", () => runner.go());\n\tserve(hub, " + DEBUG + ", () => text.shout(\"x\"));\n}\n",
			"x/runner.ts": "import { Shouter } from \"./shouter\";\nexport function makeRunner() { const shouter = new Shouter(); return { \"go\": () => shouter.shout(\"a\") }; }\n",
			"x/shouter.ts": "export class Shouter { shout(s: string) { return s + \"!\"; } }\n",
			"x/text.ts": "export { shout } from \"./shout\";\n",
			"x/shout.ts": "export const shout = (s: string) => s + \"?\";\n"
		});

		// The ways in the recognizers find, keyed by what they are — a name made at run time by how it's written.
		assert.deepEqual([...features.keys()].sort(), ["command|run.go", "hub request|" + DEBUG]);
		// A local of the function it's registered in counts as what it's made from (`runner` → the makeRunner import), and a
		// method call is what declares the method (`runner.go` → the object makeRunner returns); on through a class's method
		// to Shouter, and a namespace import's member through a barrel to its declaration.
		assert.deepEqual(features.get("command|run.go")!.roots, ["x/extension.ts#makeRunner", "x/runner.ts#makeRunner"]);
		assert.ok(reach(analysis.graph, features.get("command|run.go")!.roots).has("x/shouter.ts#Shouter"), [...reach(analysis.graph, features.get("command|run.go")!.roots)].join(", "));
		assert.ok(reach(analysis.graph, features.get("hub request|" + DEBUG)!.roots).has("x/shout.ts#shout"), "through a namespace import and a barrel's re-export");
		assert.ok(!reach(analysis.graph, features.get("command|run.go")!.roots).has("x/shout.ts#shout"), "run.go doesn't reach what only the hub request uses");
	})();
}
