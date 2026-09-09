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
 * `oxc` + pure AST logic only — no fs, network, or top-level side effects — so it runs unchanged in Node AND the
 * browser (a browser build resolves oxc-parser's wasm), the same portability contract as `./detect`. The oxc
 * coupling is contained to `parseSync` + the ESTree node shapes read below (CallExpression, Identifier,
 * MemberExpression, Literal); the TypeScript 7.1 native LSP (beta expected ~Sept 2026, microsoft/TypeScript#63703)
 * is the intended future backend, and its SEMANTIC info belongs to the separate non-literal-argument axis.
 */

import { parseSync } from "oxc-parser";
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

// eslint-disable-next-line ts/no-explicit-any
function matchesCallee(matcher: Matcher, callee: any): boolean {
	if (matcher.callee !== undefined) {
		return callee?.type === "Identifier" && callee.name === matcher.callee;
	}

	if (matcher.property !== undefined) {
		if (callee?.type !== "MemberExpression" || callee.computed) { return false; }
		if (callee.property?.type !== "Identifier" || callee.property.name !== matcher.property) { return false; }

		return matcher.object === undefined || (callee.object?.type === "Identifier" && callee.object.name === matcher.object);
	}

	return false;
}

// eslint-disable-next-line ts/no-explicit-any
function renderCallee(callee: any): string {
	if (callee?.type === "Identifier") { return callee.name; }

	if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier") {
		return (callee.object?.type === "Identifier" ? callee.object.name : "?") + "." + callee.property.name;
	}

	return "?";
}

/** Render a static dotted member/identifier chain (`process.env`), or undefined if any segment is computed/dynamic. */
// eslint-disable-next-line ts/no-explicit-any
function renderMember(node: any): string | undefined {
	if (node?.type === "Identifier") { return node.name; }

	if (node?.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
		const object = renderMember(node.object);

		return object === undefined ? undefined : object + "." + node.property.name;
	}

	return undefined;
}

/** The key a MemberExpression reads: `.name` (non-computed) or `["name"]` (computed string literal). */
// eslint-disable-next-line ts/no-explicit-any
function memberKey(node: any): string | undefined {
	if (!node.computed && node.property?.type === "Identifier") { return node.property.name; }
	if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") { return node.property.value; }

	return undefined;
}

/** Recursively visit every AST node (object with a string `type`) — same walk as `./detect`. */
// eslint-disable-next-line ts/no-explicit-any
function walk(node: any, visit: (n: any) => void): void {
	if (!node || typeof node !== "object") { return; }
	if (Array.isArray(node)) { for (const child of node) { walk(child, visit); } return; }
	if (typeof node.type === "string") { visit(node); }
	for (const key in node) { if (key === "type") { continue; } walk(node[key], visit); }
}

/** 1-based line/column for a source offset. */
function locate(src: string, offset: number): { "line": number; "column": number } {
	const before = src.slice(0, offset);

	return { "line": before.split("\n").length, "column": offset - (before.lastIndexOf("\n") + 1) + 1 };
}

/**
 * Find every place `src` reaches a capability per the configured matchers, capturing string-literal resources.
 * `file` names the source for oxc (drives its TS/JSX handling by extension).
 */
export function findReach(file: string, src: string, config: MatcherConfig = ALL_MATCHERS): Reach[] {
	const matchers = normalize(config);
	const callMatchers = matchers.filter((matcher) => matcher.member === undefined);
	const memberMatchers = matchers.filter((matcher) => matcher.member !== undefined);
	const { program } = parseSync(file, src);
	const found: Reach[] = [];

	walk(program, (node) => {
		if (node.type === "CallExpression") {
			const matcher = callMatchers.find((candidate) => matchesCallee(candidate, node.callee));

			if (matcher === undefined) { return; }

			const argument = node.arguments?.[matcher.arg ?? 0];

			if (argument?.type === "Literal" && typeof argument.value === "string") {
				found.push({
					"capability": matcher.capability,
					"value": argument.value,
					"callee": renderCallee(node.callee),
					"safe": matcher.safe,
					"start": node.start,
					"end": node.end,
					...locate(src, node.start)
				});
			}
		} else if (node.type === "MemberExpression") {
			const receiver = renderMember(node.object);

			if (receiver === undefined) { return; }

			const matcher = memberMatchers.find((candidate) => candidate.member === receiver);

			if (matcher === undefined) { return; }

			const key = memberKey(node);

			if (key !== undefined) {
				found.push({
					"capability": matcher.capability,
					"value": key,
					"callee": receiver,
					"safe": matcher.safe,
					"start": node.start,
					"end": node.end,
					...locate(src, node.start)
				});
			}
		}
	});

	return found;
}
