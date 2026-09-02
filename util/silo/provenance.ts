/**
 * silo — AI-authorship provenance (Node). Extracted from the `silo` prototype; was `shared/provenance.ts`.
 *
 * Estimate how likely a source file was AI-authored. Two signals: STRUCTURAL — the fraction of a file's
 * functions carrying a non-JSDoc doc comment directly above them (LLMs preface nearly every declaration with
 * an explanatory block; humans document selectively); and ATTRIBUTION MARKERS — explicit "Co-authored-by:
 * Claude" / "AI-generated" in comments (the git-trailer form is `gitCoauthoredFiles`). A SMOKE DETECTOR, not
 * a polygraph. `scoreSource` is pure (no disk/git); `analyzeFile` reads a file; `gitCoauthoredFiles` shells git.
 */

import * as path from "node:path";

import { exec } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";
import { parseSync } from "oxc-parser";

export type Verdict = "clean" | "possible" | "likely";
export interface Signal { "name": string; "matches": number; "sample": string }
export interface Provenance { "score": number; "verdict": Verdict; "signals": Signal[]; "functions": number; "documented": number }

// The structural tell is doc-comment COVERAGE: AI puts a comment in front of nearly every function, while
// humans document selectively — so the signal is the FRACTION of a file's functions carrying a non-JSDoc doc
// comment. Tagged JSDoc (@param/@returns) doesn't count (those authors are deliberately undetectable here).
const LIKELY_RATIO = 0.7;
const POSSIBLE_RATIO = 0.4;
const JSDOC_TAG = /(?:^|\n)\s*(?:\*\s*)?@\w+/u;
const MARKER = /co-?authored-?by:\s*claude|generated (?:with|by) (?:an? )?(?:ai|claude)|\bai[- ]generated\b|chatgpt|gpt-\d|github copilot/iu;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Group comments that sit back-to-back (only whitespace between) into single blocks. */
function commentBlocks(comments: { "start": number; "end": number; "value": string }[], src: string) {
	const sorted = [...comments].sort((a, b) => a.start - b.start);
	const blocks: { "start": number; "end": number; "text": string }[] = [];

	for (const c of sorted) {
		const last = blocks[blocks.length - 1];

		if (last && /^\s*$/u.test(src.slice(last.end, c.start))) { last.end = c.end; last.text += "\n" + c.value; } else { blocks.push({ "start": c.start, "end": c.end, "text": c.value }); }
	}

	return blocks;
}

/** Start offsets of every "documentable" declaration: top-level functions/classes (incl. exported and
 *  `const f = () => …`) plus class methods. */
function declStarts(program: any): number[] {
	const out: number[] = [];
	const isFn = (d: any) => d && (d.type === "FunctionDeclaration" || d.type === "TSDeclareFunction" || d.type === "ClassDeclaration");
	const isVarFn = (d: any) => d && d.type === "VariableDeclaration" && d.declarations?.some((v: any) => v.init && (v.init.type === "ArrowFunctionExpression" || v.init.type === "FunctionExpression"));

	for (const stmt of program.body as any[]) {
		const decl = stmt.type?.startsWith("Export") ? (stmt.declaration ?? stmt) : stmt;

		if (isFn(decl) || isVarFn(decl)) { out.push(stmt.start); }
		if (decl?.type === "ClassDeclaration") {
			for (const m of decl.body?.body ?? []) {
				if (m.type === "MethodDefinition") { out.push(m.start); }
			}
		}

		// Object-literal handlers (defineTool({ handler }), a default-export object, a const object) are
		// "documentable" too, so a tool authored as `export default defineTool({…})` isn't scored functions:0.
		const objectFn = (obj: any) => { for (const p of obj.properties ?? []) { if ((p.type === "Property" || p.type === "ObjectProperty") && (p.value?.type === "ArrowFunctionExpression" || p.value?.type === "FunctionExpression")) { out.push(p.start); } } };
		const mine = (value: any) => { if (value?.type === "ObjectExpression") { objectFn(value); } else if (value?.type === "CallExpression") { for (const a of value.arguments ?? []) { if (a?.type === "ObjectExpression") { objectFn(a); } } } };

		if (stmt.type === "ExportDefaultDeclaration") { mine(decl); } else if (decl?.type === "VariableDeclaration") { for (const v of decl.declarations ?? []) { mine(v.init); } }
	}

	return out;
}

/** Score a source string for AI-authorship. Pure (no disk/git) so it can be unit-tested directly. */
export function scoreSource(file: string, src: string): Provenance {
	const { program, comments = [] } = parseSync(file, src) as any;
	const blocks = commentBlocks(comments, src);
	const starts = declStarts(program);

	let markerSample = "";

	for (const c of comments) {
		const m = MARKER.exec(c.value);

		if (m) { markerSample = m[0].trim(); break; }
	}

	let docSample = "";
	let documented = 0;

	for (const start of starts) {
		let lead: { "start": number; "end": number; "text": string } | undefined;

		for (const b of blocks) { if (b.end <= start) { lead = b; } else { break; } }
		if (!lead || !/^\s*$/u.test(src.slice(lead.end, start))) { continue; }       // must sit directly above
		if (!/(?:^|\n)[ \t]*$/u.test(src.slice(0, lead.start))) { continue; }        // …and start its own line
		if (JSDOC_TAG.test(lead.text)) { continue; }
		documented += 1;
		if (!docSample) { docSample = lead.text.replace(/\s+/gu, " ").trim().slice(0, 50); }
	}

	const functions = starts.length;
	const ratio = functions ? documented / functions : 0;
	const signals: Signal[] = [];

	if (markerSample) { signals.push({ "name": "marker", "matches": 1, "sample": markerSample.slice(0, 60) }); }
	if (documented) { signals.push({ "name": "doc-coverage", "matches": documented, "sample": `${documented}/${functions} fns — “${docSample}”` }); }

	const verdict: Verdict = markerSample ? "likely"
		: functions >= 1 && ratio >= LIKELY_RATIO ? "likely"
			: functions >= 1 && ratio >= POSSIBLE_RATIO ? "possible"
				: "clean";
	const score = markerSample ? 1 : round2(ratio);

	return { "score": score, "verdict": verdict, "signals": signals, "functions": functions, "documented": documented };
}

export function analyzeFile(file: string): Provenance {
	return scoreSource(file, fs.readFileSync(file));
}

/** Files touched by any commit carrying a Claude/AI `Co-authored-by:` trailer — a high-confidence,
 *  low-recall signal the caller can merge in (returns ABSOLUTE paths; empty outside a git repo). */
export async function gitCoauthoredFiles(cwd: string = process.cwd()): Promise<Set<string>> {
	const out = new Set<string>();

	try {
		const top = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);

		if (!top.ok) { return out; }
		const root = top.stdout;   // exec already trims
		const r = await exec("git", ["-C", cwd, "log", "--no-merges", "--format=%H\t%(trailers:key=Co-authored-by,valueonly,separator=%x2C)", "--name-only"]);

		if (!r.ok) { return out; }
		let aiCommit = false;

		for (const line of r.stdout.split("\n")) {
			const head = /^([0-9a-f]{40})\t(.*)$/u.exec(line);

			if (head) { aiCommit = MARKER.test(head[2]); continue; }
			if (aiCommit && line.trim()) { out.add(path.join(root, line.trim())); }
		}
	} catch { /* git missing / not a repo */ }

	return out;
}
