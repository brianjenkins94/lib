/**
 * silo — the fine-grained CAPABILITY-REACH kernel (pure, browser-portable). Sibling to `./detect`: detect
 * answers "does this file have capability X" (coarse — regex + import surface); this answers "WHERE, and against
 * WHAT concrete resource" a file reaches a capability — the URL a `fetch` requests, the path a `writeFile`
 * writes, the command a `spawn` runs, the key a `process.env` reads. Config-driven matchers over the SAME
 * capability vocabulary silo already uses (net, fs:read, fs:write, exec, env, eval), so a wrapper is covered by
 * DECLARING it, not by hard-coding.
 *
 * Two matcher shapes: CALL matchers (a `fetch(...)` / `writeFile(...)` / `fs.writeFile(...)` / `spawn(...)`,
 * capturing a string-literal argument) and MEMBER matchers (a `process.env.KEY` / `process.env["KEY"]` read,
 * capturing the key). fs/exec presets reuse `./detect`'s `CALL_DETECTORS` name lists (single source of truth).
 *
 * SCOPE: string-LITERAL resources only — a non-literal argument or computed key (const/template/runtime) is the
 * separate value-resolution axis and is silently skipped. `eval`, whole-`process.env` (no key), and destructured
 * env (`const { KEY } = process.env`) are not covered yet.
 *
 * Read off TypeScript's tree — the compiler that already holds the file (a TypeScript server's, in the editor; a
 * `typescript` package's, elsewhere): `ts` is passed in, so this module loads no parser of its own and stays pure — no
 * fs, network, or top-level side effects. Analysis is TypeScript's job (graph.ts); TypeScript 7's API is the same tree,
 * and its SEMANTIC info belongs to the separate non-literal-argument axis.
 */

import { isEntry } from "@brianjenkins94/util/env";
import { CALL_DETECTORS } from "./detect";

/**
 * One capability-reach shape. `capability` is the silo axis it exercises (net, fs:read, fs:write, exec, env).
 * A CALL matcher recognizes EITHER a bare identifier (`callee`, e.g. `fetch`, `writeFile`, `spawn`) OR a member
 * call (`property`, e.g. `get`/`writeFile`; optionally pinned to a receiver with `object`, e.g. `fido`, `fs`),
 * and captures the argument at index `arg` (default 0). A MEMBER matcher instead sets `member` to a dotted
 * receiver path (e.g. `"process.env"`) and captures the property read off it. `safe` marks a read vs a mutation
 * (net GET, fs:read, env read); usually implied by the capability, set explicitly only where one callee spans
 * both (net).
 */
export interface Matcher {
	"capability": string;
	"callee"?: string;
	"object"?: string;
	"property"?: string;
	"arg"?: number;
	"member"?: string;
	"safe"?: boolean;
}

/** The basic (shorthand-string, net-only) or advanced (structured, any capability) form, singular or as a list. */
export type MatcherConfig = Matcher | string | (Matcher | string)[];

/** One place the code reaches a capability. `value` is the literal resource (URL/path/command/env key); `callee`
 *  is the rendered call, or the receiver path for a member read (e.g. `process.env`). */
export interface Reach {
	"capability": string;
	"value": string;
	"callee": string;
	"safe"?: boolean;
	"line": number;
	"column": number;
	/** source span of the whole finding node (the call / member expression) — for anchoring to a document node. */
	"start": number;
	"end": number;
}

const SAFE_VERBS = new Set(["get", "head", "options"]);
const HTTP_VERBS = new Set([...SAFE_VERBS, "post", "put", "patch", "delete"]);

/** fetch + the fido verb surface — the `net` presets, as shorthand. */
export const NET_MATCHERS: string[] = ["fetch", "*.fetch", "*.get", "*.post", "*.put", "*.patch", "*.delete"];

/** Each call name → a bare-identifier matcher AND an any-receiver member-call matcher, matching `./detect`'s
 *  regex coverage (a plain `writeFile(` and an `fs.writeFile(` both count). */
function callsFor(capability: string, safe: boolean): Matcher[] {
	return CALL_DETECTORS[capability].flatMap((name): Matcher[] => [
		{ "capability": capability, "callee": name, "safe": safe },
		{ "capability": capability, "property": name, "safe": safe }
	]);
}

/** fs:read + fs:write call presets, sourced from `./detect`'s name lists. */
export const FS_MATCHERS: Matcher[] = [...callsFor("fs:read", true), ...callsFor("fs:write", false)];

/** child_process call presets, sourced from `./detect`'s name lists. */
export const EXEC_MATCHERS: Matcher[] = callsFor("exec", false);

/** `process.env.KEY` / `process.env["KEY"]` reads. */
export const ENV_MATCHERS: Matcher[] = [{ "capability": "env", "member": "process.env", "safe": true }];

/** Every capability — the default for `findReach`. */
export const ALL_MATCHERS: (Matcher | string)[] = [...NET_MATCHERS, ...FS_MATCHERS, ...EXEC_MATCHERS, ...ENV_MATCHERS];

/** `"fetch"` → identifier; `"fido.get"` → receiver+method; `"*.get"` → any receiver. Splits on the first dot.
 *  Shorthand is a `net` convenience: it tags `capability: "net"` and infers `safe` from known HTTP verb names. */
function parseShorthand(spec: string): Matcher {
	const dot = spec.indexOf(".");
	const matcher: Matcher = { "capability": "net" };

	if (dot === -1) {
		matcher.callee = spec;
	} else {
		const object = spec.slice(0, dot);

		if (object !== "*") { matcher.object = object; }
		matcher.property = spec.slice(dot + 1);
	}

	const name = (matcher.property ?? matcher.callee ?? "").toLowerCase();

	if (HTTP_VERBS.has(name)) { matcher.safe = SAFE_VERBS.has(name); }

	return matcher;
}

/** Basic shorthand and/or structured matchers → the structured list `findReach` runs against. */
export function normalize(config: MatcherConfig): Matcher[] {
	const list = Array.isArray(config) ? config : [config];

	return list.map((entry) => (typeof entry === "string" ? parseShorthand(entry) : { ...entry }));
}

/** TypeScript's module and a node of its tree: whichever TypeScript holds the file (a TypeScript server's own). */
// eslint-disable-next-line ts/no-explicit-any
type Ts = any;
// eslint-disable-next-line ts/no-explicit-any
type TsNode = any;

function matchesCallee(ts: Ts, matcher: Matcher, callee: TsNode): boolean {
	if (matcher.callee !== undefined) {
		return ts.isIdentifier(callee) && callee.text === matcher.callee;
	}

	if (matcher.property !== undefined) {
		if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name) || callee.name.text !== matcher.property) { return false; }

		return matcher.object === undefined || (ts.isIdentifier(callee.expression) && callee.expression.text === matcher.object);
	}

	return false;
}

function renderCallee(ts: Ts, callee: TsNode): string {
	if (ts.isIdentifier(callee)) { return callee.text; }

	if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
		return (ts.isIdentifier(callee.expression) ? callee.expression.text : "?") + "." + callee.name.text;
	}

	return "?";
}

/** Render a static dotted member/identifier chain (`process.env`), or undefined if any segment is computed/dynamic. */
function renderMember(ts: Ts, node: TsNode): string | undefined {
	if (ts.isIdentifier(node)) { return node.text; }

	if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
		const object = renderMember(ts, node.expression);

		return object === undefined ? undefined : object + "." + node.name.text;
	}

	return undefined;
}

/** A member read's receiver and key: `.name`, or `["name"]` (a string literal). Undefined for anything else. */
function memberRead(ts: Ts, node: TsNode): { "object": TsNode; "key": string } | undefined {
	if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) { return { "object": node.expression, "key": node.name.text }; }
	if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) { return { "object": node.expression, "key": node.argumentExpression.text }; }

	return undefined;
}

/**
 * Find every place `sourceFile` (a TypeScript SourceFile, read by `ts`) reaches a capability per the configured
 * matchers, capturing string-literal resources — a call's argument, or a member read's key.
 */
export function findReach(ts: Ts, sourceFile: TsNode, config: MatcherConfig = ALL_MATCHERS): Reach[] {
	const matchers = normalize(config);
	const callMatchers = matchers.filter((matcher) => matcher.member === undefined);
	const memberMatchers = matchers.filter((matcher) => matcher.member !== undefined);
	const found: Reach[] = [];
	const at = (node: TsNode): Pick<Reach, "start" | "end" | "line" | "column"> => {
		const start = node.getStart(sourceFile);
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);

		return { "start": start, "end": node.getEnd(), "line": line + 1, "column": character + 1 };
	};

	(function visit(node: TsNode): void {
		if (ts.isCallExpression(node)) {
			const matcher = callMatchers.find((candidate) => matchesCallee(ts, candidate, node.expression));
			const argument = matcher === undefined ? undefined : node.arguments[matcher.arg ?? 0];

			if (matcher !== undefined && argument !== undefined && ts.isStringLiteralLike(argument)) {
				found.push({ "capability": matcher.capability, "value": argument.text, "callee": renderCallee(ts, node.expression), "safe": matcher.safe, ...at(node) });
			}
		} else {
			const read = memberRead(ts, node);
			const receiver = read === undefined ? undefined : renderMember(ts, read.object);
			const matcher = receiver === undefined ? undefined : memberMatchers.find((candidate) => candidate.member === receiver);

			if (read !== undefined && receiver !== undefined && matcher !== undefined) {
				found.push({ "capability": matcher.capability, "value": read.key, "callee": receiver, "safe": matcher.safe, ...at(node) });
			}
		}

		node.forEachChild(visit);
	})(sourceFile);

	return found;
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		// (a specifier made at run time, so a bundler of this module doesn't pull TypeScript in)
		const ts: typeof import("typescript") = (await import(/* @vite-ignore */ ["typescript"].join(""))).default;
		const reach = (text: string, config?: MatcherConfig): Reach[] => findReach(ts, ts.createSourceFile("app.ts", text, ts.ScriptTarget.Latest, true), config);
		const src = [
			"import * as fs from \"node:fs\";",
			"const page = await fetch(\"https://example.com/a\");",
			"fs.writeFileSync(`/tmp/out.txt`, \"x\");",
			"readFileSync(\"/etc/hosts\");",
			"spawn(\"ls\", [\"-l\"]);",
			"const key = process.env.TOKEN ?? process.env[\"HOME\"];",
			"fetch(url); fs.writeFileSync(path, data); process.env[name];",
			"map.get(\"key\"); client.post(\"/api\", {});"
		].join("\n");

		// Each capability call with a literal resource — where, against what — and each literal env key read; a
		// non-literal resource or key is the canary's to see (not here). `*.get` is net, a GET: safe.
		assert.deepEqual(reach(src).map((each) => [each.capability, each.callee, each.value, each.safe, each.line]), [
			["net", "fetch", "https://example.com/a", undefined, 2],
			["fs:write", "fs.writeFileSync", "/tmp/out.txt", false, 3],
			["fs:read", "readFileSync", "/etc/hosts", true, 4],
			["exec", "spawn", "ls", false, 5],
			["env", "process.env", "TOKEN", true, 6],
			["env", "process.env", "HOME", true, 6],
			["net", "map.get", "key", true, 8],
			["net", "client.post", "/api", false, 8]
		]);

		// The span is the whole call, so a document anchors it; a receiver can be pinned (`fido.get`, not `map.get`).
		const [first] = reach(src);

		assert.equal(src.slice(first.start, first.end), "fetch(\"https://example.com/a\")");
		assert.deepEqual(reach("fido.get(\"/a\"); map.get(\"/b\");", ["fido.get"]).map((each) => each.callee), ["fido.get"]);
	})();
}
