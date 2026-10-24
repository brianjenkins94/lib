/**
 * silo — purity, decided statically (silo README, *Purity*): whether a function is pure, pure if the callbacks it's
 * given are, reads mutable state from outside, writes only to its arguments, is effectful, or can't be known — from its
 * body and, through TypeScript's checker, the bodies of what it calls. The verdict a caller gets is the worst of its own
 * and its callees' (a fixpoint: cycles settle). Measured on the editor's repository (2026-10-24): four functions in five
 * get a definite verdict; most unknowns are dynamic dispatch and external packages, which runs answer.
 *
 * Assumptions (the README's): no getters or setters with hidden effects, no Proxies, built-ins as the table below says,
 * types honest enough to resolve calls (a call through `any` is unknown), throwing and allocating aren't effects. And
 * the measurement's three fixes: a write through a local holding what a call returned or a field held is a write
 * outside (it may alias), unless the local was made there; a name read as a property access's base is seen; a module's
 * `const` holding a Map, an array or an object is mutable state. A nested function counts as part of the one around it.
 *
 * Every reading takes `ts` and the program that holds the code — a TypeScript server's (the editor's capabilities
 * plugin), or the command line's — and reads lazily: a function's verdict needs only what it reaches. Pure.
 */

import { isEntry } from "@brianjenkins94/util/env";

// eslint-disable-next-line ts/no-explicit-any
type Ts = any;
// eslint-disable-next-line ts/no-explicit-any
type TsNode = any;
// eslint-disable-next-line ts/no-explicit-any
type Program = any;

export type Purity = "pure" | "pure-if" | "reads-state" | "mutates-args" | "unknown" | "effectful";

/** Least to most: what a caller inherits is the worst of what it calls. */
export const PURITIES: Purity[] = ["pure", "pure-if", "reads-state", "mutates-args", "unknown", "effectful"];

const worse = (left: Purity, right: Purity): Purity => (PURITIES.indexOf(left) >= PURITIES.indexOf(right) ? left : right);

/** A function's verdict, and why it isn't pure — its own reasons (a callee's are the callee's). */
export interface PurityVerdict { "verdict": Purity; "reasons": string[] }

/** One of a file's top-level functions, with its verdict. */
export interface FilePurity extends PurityVerdict { "name": string; "start": number; "end": number }

const PURE = new Set([
	...["abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "cbrt", "ceil", "clz32", "cos", "cosh", "exp", "expm1", "floor", "fround", "hypot", "imul", "log", "log10", "log1p", "log2", "max", "min", "pow", "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh", "trunc"].map((name) => "Math." + name),
	...["map", "filter", "slice", "concat", "join", "indexOf", "lastIndexOf", "includes", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "reduce", "reduceRight", "flat", "flatMap", "at", "entries", "keys", "values", "toSorted", "toReversed", "toSpliced", "with", "forEach", "toString", "toLocaleString"].flatMap((name) => ["Array." + name, "ReadonlyArray." + name]),
	"ArrayConstructor.from", "ArrayConstructor.isArray", "ArrayConstructor.of",
	...["charAt", "charCodeAt", "codePointAt", "concat", "endsWith", "includes", "indexOf", "lastIndexOf", "localeCompare", "match", "matchAll", "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "search", "slice", "split", "startsWith", "substring", "substr", "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase", "trim", "trimEnd", "trimStart", "toString", "valueOf", "at", "isWellFormed", "toWellFormed"].map((name) => "String." + name),
	"StringConstructor.fromCharCode", "StringConstructor.fromCodePoint", "StringConstructor.raw", "JSON.parse", "JSON.stringify",
	...["keys", "values", "entries", "fromEntries", "is", "getPrototypeOf", "getOwnPropertyNames", "getOwnPropertyDescriptor", "getOwnPropertySymbols", "hasOwn", "isFrozen", "groupBy", "create"].map((name) => "ObjectConstructor." + name),
	"Object.hasOwnProperty", "Object.toString", "Object.valueOf",
	...["isFinite", "isInteger", "isNaN", "isSafeInteger", "parseFloat", "parseInt"].map((name) => "NumberConstructor." + name),
	"Number.toFixed", "Number.toString", "Number.toPrecision", "Number.toLocaleString", "Number.valueOf",
	"parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "structuredClone",
	...["get", "has", "keys", "values", "entries", "forEach"].flatMap((name) => ["Map." + name, "ReadonlyMap." + name, "Set." + name, "ReadonlySet." + name, "WeakMap." + name, "WeakSet." + name]),
	"RegExp.test", "RegExp.exec", "Promise.then", "Promise.catch", "Promise.finally", "PromiseLike.then", "PromiseConstructor.resolve", "PromiseConstructor.reject", "PromiseConstructor.all", "PromiseConstructor.allSettled", "PromiseConstructor.race", "PromiseConstructor.any", "PromiseConstructor.withResolvers",
	"TextEncoder.encode", "TextDecoder.decode", "Uint8Array.slice", "Uint8Array.subarray", "MapConstructor.groupBy",
	"Date.getTime", "Date.toISOString", "Date.valueOf", "Date.getFullYear", "Date.toLocaleTimeString", "Date.toLocaleDateString", "Date.toLocaleString", "URL.toString", "URLSearchParams.get", "URLSearchParams.has", "URLSearchParams.toString", "Error.toString"
]);
const FRESH = new Set(["Array.map", "Array.filter", "Array.slice", "Array.concat", "Array.flat", "Array.flatMap", "Array.toSorted", "Array.toReversed", "Array.toSpliced", "Array.with", "ReadonlyArray.map", "ReadonlyArray.filter", "ReadonlyArray.slice", "ReadonlyArray.concat", "ReadonlyArray.flat", "ReadonlyArray.flatMap", "ReadonlyArray.toSorted", "ReadonlyArray.toReversed", "ArrayConstructor.from", "ArrayConstructor.of", "ObjectConstructor.keys", "ObjectConstructor.values", "ObjectConstructor.entries", "ObjectConstructor.fromEntries", "ObjectConstructor.groupBy", "MapConstructor.groupBy", "JSON.parse", "structuredClone", "String.split", "String.match", "RegExp.exec", "Uint8Array.slice"]);
const RECEIVER_WRITES = new Set([...["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"].map((name) => "Array." + name), "Map.set", "Map.delete", "Map.clear", "Set.add", "Set.delete", "Set.clear", "WeakMap.set", "WeakMap.delete", "WeakSet.add", "Uint8Array.set", "URLSearchParams.set", "URLSearchParams.append", "URLSearchParams.delete", "Date.setTime"]);
const FIRST_ARG_WRITES = new Set(["ObjectConstructor.assign", "ObjectConstructor.defineProperty", "ObjectConstructor.defineProperties", "ObjectConstructor.freeze", "ObjectConstructor.setPrototypeOf", "ObjectConstructor.seal"]);
const NONDETERMINISTIC = new Set(["Math.random", "DateConstructor.now", "Performance.now", "Crypto.randomUUID", "Crypto.getRandomValues"]);
const CONSTRUCT_PURE = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array", "Error", "TypeError", "RangeError", "SyntaxError", "URL", "URLSearchParams", "RegExp", "TextEncoder", "TextDecoder", "Uint8Array", "Uint16Array", "Uint32Array", "Int32Array", "Float64Array", "ArrayBuffer", "DataView", "Promise", "AbortController", "Headers", "Response", "Blob", "Proxy", "Date"]);
const HOST = new Set(["process", "window", "document", "navigator", "location", "localStorage", "sessionStorage", "indexedDB", "globalThis", "self", "console", "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "requestAnimationFrame", "postMessage", "addEventListener", "removeEventListener", "crypto", "performance", "Atomics", "importScripts", "caches"]);

interface Unit { "node": TsNode; "local": Purity; "reasons": string[]; "calls": Set<Unit>; "verdict"?: Purity }

/** A program's purity reader. `ours(fileName)`: the program's own code (default: not node_modules, not a .d.ts) — what
 *  it reads the body of; anything else is a built-in or an external package. */
export function purityReader(ts: Ts, program: Program, ours: (fileName: string) => boolean = (fileName) => !fileName.includes("/node_modules/") && !fileName.endsWith(".d.ts")): { "verdictOf": (node: TsNode) => PurityVerdict | undefined; "fileVerdicts": (sourceFile: TsNode) => FilePurity[] } {
	const checker = program.getTypeChecker();
	const units = new Map<TsNode, Unit>();
	const isLib = (node: TsNode): boolean => program.isSourceFileDefaultLibrary(node.getSourceFile()) || /\/typescript\/lib\/lib\./u.test(node.getSourceFile().fileName);
	const inOurs = (node: TsNode): boolean => ours(node.getSourceFile().fileName);
	const isFunction = (node: TsNode): boolean => node.body !== undefined && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node));

	/** The function a declaration's body is (an arrow or function bound to a name included) — none for a signature. */
	const functionOf = (declaration: TsNode): TsNode => {
		if (declaration === undefined) {
			return undefined;
		}

		if (isFunction(declaration)) {
			return declaration;
		}

		return (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer !== undefined && isFunction(declaration.initializer) ? declaration.initializer : undefined;
	};

	const libName = (declaration: TsNode): string => {
		const parent = declaration.parent;
		const container = ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isModuleBlock(parent) ? (parent.name?.text ?? parent.parent?.name?.text) : undefined;
		const member = declaration.name?.getText?.() ?? "";

		return container === undefined ? member : container + "." + member;
	};

	/** Whether `identifier` was declared inside `unit`: its own parameter, a local, or outside it. */
	const declaredWithin = (identifier: TsNode, unit: Unit): "param" | "local" | "outer" | undefined => {
		const symbol = checker.getSymbolAtLocation(identifier);
		const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];

		if (declaration === undefined) {
			return undefined;
		}

		for (let at = declaration; at !== undefined; at = at.parent) {
			if (at === unit.node) {
				return ts.isParameter(declaration) && declaration.parent === unit.node ? "param" : "local";
			}
		}

		return "outer";
	};

	const fresh = (expression: TsNode): boolean => {
		let at = expression;

		while (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isNonNullExpression(at) || (ts.isSatisfiesExpression !== undefined && ts.isSatisfiesExpression(at))) {
			at = at.expression;
		}

		if (ts.isArrayLiteralExpression(at) || ts.isObjectLiteralExpression(at) || ts.isNewExpression(at) || ts.isSpreadElement(at)) {
			return true;
		}

		if (ts.isCallExpression(at)) {
			const declaration = checker.getResolvedSignature(at)?.declaration;

			return declaration !== undefined && isLib(declaration) && FRESH.has(libName(declaration));
		}

		return false;
	};

	const note = (unit: Unit, verdict: Purity, reason: string): void => {
		unit.local = worse(unit.local, verdict);

		if (verdict !== "pure") {
			unit.reasons.push(reason);
		}
	};

	/** A write to `target`: the function's own (a local made there, a literal), its arguments', or outside. `into`: a
	 *  write into the object `target` holds (a mutating method's receiver, Object.assign's first argument), not a
	 *  reassignment of `target` itself. */
	const writeTo = (unit: Unit, target: TsNode, why: string, into = false): void => {
		let base = target;

		while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base) || ts.isNonNullExpression(base) || ts.isParenthesizedExpression(base) || ts.isAsExpression(base)) {
			base = base.expression;
		}

		if (base.kind === ts.SyntaxKind.ThisKeyword) {
			if (!ts.isConstructorDeclaration(unit.node)) {
				note(unit, "effectful", `writes to this (${why})`);
			}

			return;
		}

		if (fresh(base)) {
			return;
		}

		if (!ts.isIdentifier(base)) {
			note(unit, "effectful", `writes to what a call handed back (${why})`);

			return;
		}

		const where = declaredWithin(base, unit);

		// (reassigning a name of its own is fine; writing into what it holds isn't, unless it made it)
		const intoIt = into || base !== target;

		if (where === "param") {
			if (intoIt) {
				note(unit, "mutates-args", "writes to an argument");
			}

			return;
		}

		if (where === "local") {
			const declaration = checker.getSymbolAtLocation(base)?.valueDeclaration;
			const made = declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined || fresh(declaration.initializer);

			if (intoIt && !made) {
				note(unit, "effectful", `writes through a reference it was handed (${why})`);
			}

			return;
		}

		note(unit, "effectful", `writes outside (${why})`);
	};

	const call = (unit: Unit, node: TsNode): void => {
		const callee = node.expression;

		if (ts.isIdentifier(callee) && callee.text === "eval") {
			note(unit, "unknown", "eval");

			return;
		}

		if (ts.isElementAccessExpression(callee)) {
			note(unit, "unknown", "a dynamic call (obj[key]())");

			return;
		}

		if ((checker.getTypeAtLocation(callee).flags & ts.TypeFlags.Any) !== 0) {
			note(unit, "unknown", "a call through any");

			return;
		}

		if (ts.isIdentifier(callee) && declaredWithin(callee, unit) === "param") {
			note(unit, "pure-if", "calls a callback it was given");

			return;
		}

		const declaration = checker.getResolvedSignature(node)?.declaration;

		if (declaration === undefined || declaration.kind === ts.SyntaxKind.JSDocSignature) {
			note(unit, "unknown", "a call TypeScript can't resolve");

			return;
		}

		if (isLib(declaration)) {
			const container = declaration.parent?.name?.text ?? "";

			if (ts.isCallSignatureDeclaration(declaration) && /^(?:String|Number|Boolean|Symbol|BigInt|Object|Array|RegExp|Error|TypeError|RangeError)Constructor$/u.test(container)) {
				return;
			}

			if (ts.isCallSignatureDeclaration(declaration) && container === "DateConstructor") {
				note(unit, "effectful", "nondeterministic: Date()");

				return;
			}

			const name = libName(declaration);

			if (/\/lib\.(?:dom|webworker)[.\w]*\.d\.ts$/u.test(declaration.getSourceFile().fileName) && !/^(?:TextEncoder|TextDecoder|URL|URLSearchParams|Headers|Response|Request|Blob|AbortSignal|DOMException|Event)\./u.test(name)) {
				note(unit, "effectful", "the host: the DOM");
			} else if (PURE.has(name)) {
				// (nothing)
			} else if (NONDETERMINISTIC.has(name)) {
				note(unit, "effectful", "nondeterministic: " + name);
			} else if (RECEIVER_WRITES.has(name) && ts.isPropertyAccessExpression(callee)) {
				writeTo(unit, callee.expression, name, true);
			} else if (FIRST_ARG_WRITES.has(name) && node.arguments[0] !== undefined) {
				writeTo(unit, node.arguments[0], name, true);
			} else if (/^(?:CallableFunction|NewableFunction|Function)\.(?:call|apply|bind)$/u.test(name)) {
				note(unit, "unknown", "call/apply/bind: which function isn't known");
			} else if (HOST.has(name) || /^(?:Console|Window|Document|Storage|Navigator|Location|Performance|Crypto|WorkerGlobalScope|EventTarget)\b/u.test(name)) {
				note(unit, "effectful", "the host: " + name);
			} else {
				note(unit, "unknown", "a built-in not in the table: " + name);
			}

			return;
		}

		if (!inOurs(declaration)) {
			const from = declaration.getSourceFile().fileName;

			if (/\/@types\/node\/(?:path|url|util|buffer(?:\.buffer)?|querystring|string_decoder|assert)(?:\/\w+)?\.d\.ts$/u.test(from) && !/\b(?:debuglog|deprecate|promisify|callbackify)\b/u.test(declaration.name?.getText?.() ?? "")) {
				return;
			}

			note(unit, /\/@types\/node\/|\/@types\/vscode\/|\/monaco-vscode-api\/|\/monaco-editor\//u.test(from) ? "effectful" : "unknown", /\/@types\/node\//u.test(from) ? "the host: node" : /vscode|monaco/u.test(from) ? "the host: VS Code's API" : "an external package: " + (from.split("/node_modules/").at(-1)?.split("/").slice(0, from.includes("/node_modules/@") ? 2 : 1).join("/") ?? from));

			return;
		}

		const target = functionOf(declaration);

		if (target === undefined) {
			note(unit, "unknown", declaration.body === undefined && (ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) ? "an overload or abstract signature" : "a call through an interface or a function-typed value (which code runs isn't known statically)");

			return;
		}

		unit.calls.add(unitOf(target));
	};

	const construct = (unit: Unit, node: TsNode): void => {
		const name = node.expression.getText();

		if (name === "Date" && (node.arguments ?? []).length === 0) {
			note(unit, "effectful", "nondeterministic: new Date()");

			return;
		}

		if (name === "Function") {
			note(unit, "unknown", "new Function");

			return;
		}

		const declaration = checker.getResolvedSignature(node)?.declaration;
		const ownClass = checker.getSymbolAtLocation(node.expression)?.declarations?.some((each: TsNode) => inOurs(each)) === true;

		if (declaration !== undefined && isLib(declaration) && !ownClass) {
			if (!CONSTRUCT_PURE.has(name)) {
				note(unit, /^(?:Worker|WebSocket|SharedWorker|BroadcastChannel|MessageChannel|EventSource|XMLHttpRequest|Notification)$/u.test(name) ? "effectful" : "unknown", /^(?:Worker|WebSocket)/u.test(name) ? "the host: new " + name : "a built-in not in the table: new " + name);
			}

			return;
		}

		if (declaration !== undefined && !inOurs(declaration)) {
			note(unit, "unknown", "an external package's class");

			return;
		}

		if (declaration !== undefined && isFunction(declaration)) {
			unit.calls.add(unitOf(declaration));
		}
	};

	/** A function's own verdict, from its body (its callees' added by the fixpoint). */
	function unitOf(node: TsNode): Unit {
		const known = units.get(node);

		if (known !== undefined) {
			return known;
		}

		const unit: Unit = { "node": node, "local": "pure", "reasons": [], "calls": new Set() };

		units.set(node, unit);

		const walk = (each: TsNode): void => {
			if (ts.isBinaryExpression(each) && each.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && each.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
				if (!ts.isObjectLiteralExpression(each.left) && !ts.isArrayLiteralExpression(each.left)) {
					writeTo(unit, each.left, "assignment");
				}
			} else if ((ts.isPrefixUnaryExpression(each) || ts.isPostfixUnaryExpression(each)) && (each.operator === ts.SyntaxKind.PlusPlusToken || each.operator === ts.SyntaxKind.MinusMinusToken)) {
				writeTo(unit, each.operand, "++/--");
			} else if (ts.isDeleteExpression(each)) {
				writeTo(unit, each.expression, "delete");
			} else if (ts.isCallExpression(each)) {
				call(unit, each);
			} else if (ts.isNewExpression(each)) {
				construct(unit, each);
			} else if (ts.isIdentifier(each) && !(ts.isPropertyAccessExpression(each.parent) && each.parent.name === each) && declaredWithin(each, unit) === "outer") {
				const symbol = checker.getSymbolAtLocation(each);
				const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];

				if (HOST.has(each.text) && declaration !== undefined && isLib(declaration)) {
					note(unit, "effectful", "the host: " + each.text);
				} else if (declaration !== undefined && ts.isVariableDeclaration(declaration) && inOurs(declaration) && (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
					note(unit, "reads-state", "reads a module's let/var");
				} else if (declaration !== undefined && ts.isVariableDeclaration(declaration) && inOurs(declaration) && declaration.initializer !== undefined && (ts.isNewExpression(declaration.initializer) || ts.isArrayLiteralExpression(declaration.initializer) || ts.isObjectLiteralExpression(declaration.initializer)) && !/^[A-Z_]+$/u.test(declaration.name.getText())) {
					note(unit, "reads-state", "reads a module's mutable object");
				}
			} else if (each.kind === ts.SyntaxKind.ThisKeyword && !ts.isConstructorDeclaration(unit.node)) {
				note(unit, "reads-state", "reads this");
			}

			ts.forEachChild(each, walk);
		};

		ts.forEachChild(node, walk);

		return unit;
	}

	/** The verdict of `node`'s function: its own, then — over every function it reaches — the fixpoint. */
	const verdictOf = (node: TsNode): PurityVerdict | undefined => {
		const target = functionOf(node);

		if (target === undefined) {
			return undefined;
		}

		const root = unitOf(target);

		if (root.verdict === undefined) {
			const reached: Unit[] = [];
			const seen = new Set<Unit>();
			const visit = (unit: Unit): void => {
				if (!seen.has(unit) && unit.verdict === undefined) {
					seen.add(unit);
					reached.push(unit);

					for (const callee of unit.calls) {
						visit(callee);
					}
				}
			};

			visit(root);

			const working = new Map(reached.map((unit) => [unit, unit.local]));

			for (let changed = true; changed;) {
				changed = false;

				for (const unit of reached) {
					let verdict = working.get(unit)!;

					for (const callee of unit.calls) {
						verdict = worse(verdict, callee.verdict ?? working.get(callee)!);
					}

					if (verdict !== working.get(unit)) {
						working.set(unit, verdict);
						changed = true;
					}
				}
			}

			for (const unit of reached) {
				unit.verdict = working.get(unit);
			}
		}

		return { "verdict": root.verdict!, "reasons": [...new Set(root.reasons)] };
	};

	/** A file's top-level functions (declared, or an arrow or function bound to a `const`), each with its verdict. */
	const fileVerdicts = (sourceFile: TsNode): FilePurity[] => sourceFile.statements.flatMap((statement: TsNode) => {
		const named = ts.isFunctionDeclaration(statement) ? [{ "name": statement.name?.text ?? "default", "node": statement }] : ts.isVariableStatement(statement) ? statement.declarationList.declarations.filter((declaration: TsNode) => functionOf(declaration) !== undefined).map((declaration: TsNode) => ({ "name": declaration.name.getText(sourceFile), "node": declaration })) : [];

		return named.flatMap(({ name, node }: { "name": string; "node": TsNode }) => {
			const found = verdictOf(node);

			return found === undefined ? [] : [{ "name": name, "start": node.getStart(sourceFile), "end": node.getEnd(), ...found }];
		});
	});

	return { "verdictOf": verdictOf, "fileVerdicts": fileVerdicts };
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// (lib's own TypeScript, a classic one; a specifier made at run time, so a bundler doesn't follow it)
		const ts: typeof import("typescript") = (await import(/* @vite-ignore */ ["typescript"].join(""))).default;
		const text = [
			"let calls = 0;",
			"const cache = new Map<string, number>();",
			"export function add(a: number, b: number) { return a + b; }",
			"export const twice = (n: number) => add(n, n);",
			"export function sorted(xs: number[]) { const copy = [...xs]; copy.sort(); return copy; }",
			"export function sortsIt(xs: number[]) { xs.sort(); return xs; }",
			"export function count() { calls += 1; return calls; }",
			"export function counted() { return count(); }",
			"export function peek() { return calls; }",
			"export function remember(key: string) { const known = cache; known.set(key, 1); }",
			"export function now() { return Date.now(); }",
			"export function log(message: string) { console.log(message); }",
			"export function apply(f: (n: number) => number) { return f(1); }",
			"export function anyCall(x: any) { return x.go(); }",
			"export function even(n: number): boolean { return n === 0 ? true : odd(n - 1); }",
			"export function odd(n: number): boolean { return n === 0 ? false : even(n - 1); }"
		].join("\n");
		const options = { "target": ts.ScriptTarget.ESNext, "module": ts.ModuleKind.ESNext, "lib": ["lib.esnext.d.ts", "lib.dom.d.ts"], "strict": true };
		const host = ts.createCompilerHost(options);
		const original = host.getSourceFile;

		host.getSourceFile = (name, target, ...rest) => (name === "/r/app.ts" ? ts.createSourceFile(name, text, target, true) : original.call(host, name, target, ...rest));

		const program = ts.createProgram(["/r/app.ts"], options, host);
		const reader = purityReader(ts, program);
		const verdicts = Object.fromEntries(reader.fileVerdicts(program.getSourceFile("/r/app.ts")).map((each) => [each.name, each.verdict]));

		assert.deepEqual(verdicts, {
			"add": "pure",
			"twice": "pure", // through what it calls
			"sorted": "pure", // sorts its own copy
			"sortsIt": "mutates-args",
			"count": "effectful",
			"counted": "effectful", // through count
			"peek": "reads-state",
			"remember": "effectful", // a local that aliases a module's Map
			"now": "effectful",
			"log": "effectful",
			"apply": "pure-if",
			"anyCall": "unknown",
			"even": "pure", // a cycle settles
			"odd": "pure"
		});
		assert.ok(reader.fileVerdicts(program.getSourceFile("/r/app.ts")).find((each) => each.name === "remember")?.reasons.some((reason) => reason.includes("writes through a reference")));
	})();
}
