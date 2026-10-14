/**
 * silo — what TypeScript's checker says of a file, beside what `./reach` reads off its tree: the type at each of a file's
 * ranges (runtime evidence's declared types — what a site observed: the base a `?.` tested, the left side of `??`, a
 * parameter, what a `return` gave), the type at a finding (a capability call's), and a file's top-level statements as
 * cards (each one's title, detail, comment and the types of what it declares — a program's projection).
 *
 * Every reading takes `ts` and the checker of the program that holds the file, so it runs wherever the tree is: a
 * TypeScript server's (the editor's capabilities plugin, today), or TypeScript 7.1's API (the connection VS Code's
 * TypeScript 7 extension will give). Pure: no fs, network, or parser of its own.
 */

import { isEntry } from "@brianjenkins94/util/env";

/** TypeScript's module, its checker, and a node of its tree: whichever TypeScript holds the file. */
// eslint-disable-next-line ts/no-explicit-any
type Ts = any;
// eslint-disable-next-line ts/no-explicit-any
type Checker = any;
// eslint-disable-next-line ts/no-explicit-any
type TsNode = any;

/** A top-level statement as a card: its range, kind, title and detail, the `//` comment above it, and what it declares. */
export interface Statement {
	"start": number;
	"end": number;
	"kind": string;
	"title": string;
	"detail": string;
	"comment"?: string;
	"declares"?: { "name": string; "type": string | null }[];
}

/** The innermost node of `sourceFile` whose range is exactly [start, end) — or that only adds its statement's `;`, which
 *  TypeScript counts and BABLR's spans don't. Undefined when none is. */
export function nodeAt(ts: Ts, sourceFile: TsNode, start: number, end: number): TsNode {
	let found: TsNode;
	const text: string = sourceFile.text;

	function visit(node: TsNode): void {
		const nodeStart = node.getStart(sourceFile);
		const nodeEnd = node.getEnd();

		if (nodeStart > start || nodeEnd < end) {
			return;
		}

		if (nodeStart === start && (nodeEnd === end || (nodeEnd === end + 1 && text[end] === ";"))) {
			found = node; // deeper matches overwrite: the innermost wins
		}

		ts.forEachChild(node, visit);
	}

	ts.forEachChild(sourceFile, visit);

	return found;
}

/** The type of what a site observed: the base a `?.` tested, the left side of `??`, a parameter, the value a `return`
 *  gave, a function's return type — otherwise the node's own type. */
function observedType(ts: Ts, checker: Checker, node: TsNode): unknown {
	if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken !== undefined) {
		return checker.getTypeAtLocation(node.expression);
	}

	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
		return checker.getTypeAtLocation(node.left);
	}

	if (ts.isParameter(node)) {
		return checker.getTypeAtLocation(node.name);
	}

	if (ts.isReturnStatement(node)) {
		return node.expression === undefined ? checker.getVoidType() : checker.getTypeAtLocation(node.expression);
	}

	if (ts.isFunctionLike(node)) {
		const signature = checker.getSignatureFromDeclaration(node);

		if (signature !== undefined) {
			return checker.getReturnTypeOfSignature(signature);
		}
	}

	return checker.getTypeAtLocation(node);
}

/** The type TypeScript gives each of `ranges` in `sourceFile` — what the site observed (observedType) — or null where no
 *  node has the range, or the checker can't say. */
export function typesAt(ts: Ts, checker: Checker, sourceFile: TsNode, ranges: readonly { "start": number; "end": number }[]): (string | null)[] {
	return ranges.map((range) => {
		try {
			const node = nodeAt(ts, sourceFile, range.start, range.end);

			return node === undefined ? null : checker.typeToString(observedType(ts, checker, node), node, ts.TypeFormatFlags.NoTruncation);
		} catch {
			return null;
		}
	});
}

/** The type of the expression that starts at `start` — the outermost node starting there, so a finding anchored at
 *  `fetch` gives the call's result (`Promise<Response>`), not the bare function's type. Undefined where it can't say. */
export function typeAtStart(ts: Ts, checker: Checker, sourceFile: TsNode, start: number): string | undefined {
	let found: TsNode;

	(function visit(node: TsNode): void {
		if (start >= node.getStart(sourceFile) && start < node.getEnd()) {
			found = node;
			node.forEachChild(visit);
		}
	})(sourceFile);

	// (up to the expression, not the statement it is: `greet(name);` is the call's type, not the statement's)
	while (found !== undefined && found.parent !== undefined && !ts.isExpressionStatement(found.parent) && found.parent.getStart(sourceFile) === found.getStart(sourceFile) && found.parent.getEnd() >= found.getEnd()) {
		found = found.parent;
	}

	try {
		return found === undefined ? undefined : checker.typeToString(checker.getTypeAtLocation(found), found, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrayAsGenericType);
	} catch {
		return undefined;
	}
}

/** A variable statement's keyword, from its declaration list's `flags`. */
function declarationKeyword(ts: Ts, flags: number): string {
	if ((flags & ts.NodeFlags.Const) !== 0) {
		return "const";
	}

	return (flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
}

/** A function or class declaration as a card says it. */
function describeDeclaration(ts: Ts, statement: TsNode, typeOf: (node: TsNode) => string | null): Omit<Statement, "start" | "end" | "kind"> {
	const name = statement.name === undefined ? "(anonymous)" : statement.name.text;
	const isAsync = ts.isFunctionDeclaration(statement) && statement.modifiers?.some((modifier: TsNode) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
	let detail = "function";

	if (ts.isClassDeclaration(statement)) {
		detail = "class";
	} else if (isAsync) {
		detail = "async function";
	}

	return { "title": name, "detail": detail, "declares": statement.name === undefined ? [] : [{ "name": name, "type": typeOf(statement.name) }] };
}

/** A statement as a card says it: a title (the names it declares, or what it calls), a detail (how), and the types of
 *  what it declares. */
function describeStatement(ts: Ts, statement: TsNode, sourceFile: TsNode, typeOf: (node: TsNode) => string | null): Omit<Statement, "start" | "end" | "kind"> {
	const text = (node: TsNode): string => node.getText(sourceFile).replace(/\s+/gu, " ");

	// The callee of a call, however it's reached (`await f()`, `x = f()`, `f().then(…)` is `…then`).
	const calleeOf = (expression: TsNode): string | undefined => {
		let node = expression;

		while (node !== undefined && (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isVoidExpression(node))) {
			node = node.expression;
		}

		return node !== undefined && ts.isCallExpression(node) ? text(node.expression) : undefined;
	};
	// The names a binding declares — `[, , country = "CA", coupon]` is country and coupon.
	const namesOf = (name: TsNode): TsNode[] => (ts.isIdentifier(name) ? [name] : name.elements.flatMap((element: TsNode) => (ts.isOmittedExpression(element) ? [] : namesOf(element.name))));

	if (ts.isVariableStatement(statement)) {
		const declarations = statement.declarationList.declarations;
		const keyword = declarationKeyword(ts, statement.declarationList.flags);
		const callee = declarations.length === 1 && declarations[0].initializer !== undefined ? calleeOf(declarations[0].initializer) : undefined;
		const names: TsNode[] = declarations.flatMap((declaration: TsNode) => namesOf(declaration.name));

		return {
			"title": names.map((name) => name.text).join(", "),
			"detail": callee === undefined ? keyword : keyword + " · " + callee + "()",
			"declares": names.map((name) => ({ "name": name.text, "type": typeOf(name) }))
		};
	}

	if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
		return describeDeclaration(ts, statement, typeOf);
	}

	if (ts.isImportDeclaration(statement)) {
		return { "title": ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : text(statement.moduleSpecifier), "detail": "import" };
	}

	if (ts.isExpressionStatement(statement)) {
		const expression = statement.expression;

		if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const callee = calleeOf(expression.right);

			return { "title": text(expression.left), "detail": callee === undefined ? "assigned" : "assigned · " + callee + "()" };
		}

		const callee = calleeOf(expression);

		return callee === undefined ? { "title": text(expression).slice(0, 40), "detail": "expression" } : { "title": callee, "detail": "call" };
	}

	if (ts.isIfStatement(statement)) {
		return { "title": "if " + text(statement.expression).slice(0, 40), "detail": "branch" };
	}

	if (ts.isIterationStatement(statement, false)) {
		return { "title": text(statement).split("{")[0].trim().slice(0, 40), "detail": "loop" };
	}

	return { "title": String(ts.SyntaxKind[statement.kind]).replace(/Statement$|Declaration$/u, "").toLowerCase(), "detail": "" };
}

/** `sourceFile`'s top-level statements as cards: each one's range, kind, title and detail (what it declares or calls),
 *  the `//` comment right above it, and the types of what it declares. */
export function statementsOf(ts: Ts, checker: Checker, sourceFile: TsNode): Statement[] {
	const typeOf = (node: TsNode): string | null => {
		try {
			return checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation);
		} catch {
			return null;
		}
	};

	return sourceFile.statements.map((statement: TsNode) => {
		// The `//` comment right above it, if any — a step's own title.
		const comment = (ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) ?? []).filter((range: TsNode) => range.kind === ts.SyntaxKind.SingleLineCommentTrivia).map((range: TsNode) => (sourceFile.text as string).slice(range.pos + 2, range.end).trim()).join(" ");

		return { "start": statement.getStart(sourceFile), "end": statement.getEnd(), "kind": ts.SyntaxKind[statement.kind], ...comment === "" ? {} : { "comment": comment }, ...describeStatement(ts, statement, sourceFile, typeOf) };
	});
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// lib's own TypeScript (a classic, in-process one, as a TypeScript server's). (A specifier made at run time, so a
		// bundler of this module doesn't follow it.)
		const ts: typeof import("typescript") = (await import(/* @vite-ignore */ ["typescript"].join(""))).default;
		const text = [
			"// Fetch the user",
			"const user = await fetch(\"https://example.com/u\").then((r) => r.json() as Promise<{ name?: string }>);",
			"const name = user.name ?? \"anon\";",
			"export async function greet(who: string): Promise<string> { return \"hi \" + who; }",
			"greet(name);"
		].join("\n");
		const options = { "target": ts.ScriptTarget.ESNext, "module": ts.ModuleKind.ESNext, "lib": ["lib.esnext.d.ts", "lib.dom.d.ts"], "strict": true };
		const host = ts.createCompilerHost(options);
		const original = host.getSourceFile;

		host.getSourceFile = (name, target, ...rest) => (name === "/r/app.ts" ? ts.createSourceFile(name, text, target, true) : original.call(host, name, target, ...rest));

		const program = ts.createProgram(["/r/app.ts"], options, host);
		const checker = program.getTypeChecker();
		const sourceFile = program.getSourceFile("/r/app.ts")!;
		const at = (code: string): { "start": number; "end": number } => ({ "start": text.indexOf(code), "end": text.indexOf(code) + code.length });

		// What a site observed: `??`'s left side, a return's value, a parameter.
		assert.deepEqual(typesAt(ts, checker, sourceFile, [at("user.name ?? \"anon\""), at("return \"hi \" + who;"), at("nowhere")]), ["string | undefined", "string", null]);

		// A finding's type: the call's result, not the function's.
		assert.equal(typeAtStart(ts, checker, sourceFile, text.indexOf("greet(name)")), "Promise<string>");

		// Statements as cards: the comment above, what's declared and its type, what's called.
		assert.deepEqual(statementsOf(ts, checker, sourceFile).map((statement) => [statement.kind, statement.title, statement.detail, statement.comment, statement.declares?.map((each) => each.name + ": " + each.type).join(", ")]), [
			["FirstStatement", "user", "const · fetch(\"https://example.com/u\").then()", "Fetch the user", "user: { name?: string; }"],
			["FirstStatement", "name", "const", undefined, "name: string"],
			["FunctionDeclaration", "greet", "async function", undefined, "greet: (who: string) => Promise<string>"],
			["ExpressionStatement", "greet", "call", undefined, undefined]
		]);
	})();
}
