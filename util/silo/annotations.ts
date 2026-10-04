/**
 * silo — durable annotations on code spans (pure, zero-dep): one way for anything attached to code to stay attached as
 * the code moves and changes, and one way to handle losing its place (packages/vscode/SPAN-ANNOTATIONS.md in editor).
 *
 * A span is a BABLR `spanAnchors` id: content-addressed, so it survives edits around it and moves (even to another
 * file), and changes when the span itself is edited. An annotation keeps a REFERENCE to its span — the id, plus what the
 * span looked like (its shape) and where it was (its neighbours, its baseline) — so when the id is gone it can be found
 * again. Finding is kept apart from deciding:
 *
 *   - STRATEGIES each look for the span their own way and score what they find (0–1). Independent and pure; a pipeline
 *     is just a list of them, so they can be reordered, swapped, tuned or experimented with one at a time.
 *   - A POLICY turns the best score into what happens: re-placed on its own, attached as uncertain (the user confirms or
 *     re-places), or orphaned (the user re-places or dismisses).
 *
 * `evaluate` scores a pipeline and policy against a corpus of edit cases. Everything here works on spans' SHAPES — id,
 * node type, offsets, tokens — which whoever has the parse (the editor's BABLR worker) supplies.
 *
 * Stored like silo's evidence: `.silo/<collection>/<user>/<file>.jsonl`, one annotation a line, sorted, `merge=union`,
 * folded by annotation id (the line updated last wins); a dismissal is a tombstone line, so a merge can't resurrect it.
 */

import { SILO_DIR, slug } from "./evidence.js";

/** One span of a text as strategies see it: its id, node type, offsets, and tokens (whitespace and comments left out). */
export interface SpanShape { "id": string; "type": string; "start": number; "end": number; "atoms": string[] }

/** How an annotation refers to its span. */
export interface SpanRef {
	/** The span's `spanAnchors` id, and the scheme that made it. */
	"span": string;
	"key": "bablr1";
	/** Where it was last found (repo-relative). */
	"file": string;
	/** The file's git blob oid when the span was last placed, and the span's offsets in it — for re-identifying. */
	"baseline"?: { "blob": string; "start": number; "end": number };
	/** What the span looked like: its node type and tokens. */
	"shape": { "type": string; "atoms": string[] };
	/** Where it was: the ids of the spans just before and after it (neighbours usually survive an edit to the span). */
	"context": { "before"?: string; "after"?: string };
}

/** Something attached to a span: a note, a dismissed suggestion, a call site's decision… `kind` says which. */
export interface Annotation<Payload = unknown> {
	"id": string;
	"kind": string;
	"ref": SpanRef;
	"payload"?: Payload;
	/** Who made it (a slug of their git identity), and when it was made and last changed (ISO). */
	"author": string;
	"createdAt": string;
	"updatedAt": string;
	/** Dismissed: a tombstone, kept so a branch merge can't bring the annotation back. */
	"dismissed"?: true;
	/** How it was last placed, when a strategy other than its own id found it. */
	"placed"?: { "strategy": string; "score": number };
}

// ── references ──

/** The spans just before and after `target`: of those not overlapping it, the outermost ending last before it starts
 *  and the outermost starting first after it ends. */
export function neighboursOf(shapes: SpanShape[], target: { "start": number; "end": number }): { "before"?: SpanShape; "after"?: SpanShape } {
	let before: SpanShape | undefined;
	let after: SpanShape | undefined;

	for (const shape of shapes) {
		if (shape.end <= target.start && (before === undefined || shape.end > before.end || (shape.end === before.end && shape.start < before.start))) {
			before = shape;
		} else if (shape.start >= target.end && (after === undefined || shape.start < after.start || (shape.start === after.start && shape.end > after.end))) {
			after = shape;
		}
	}

	return { "before": before, "after": after };
}

/** A reference to span `id` of `file`, whose spans are `shapes` (and whose blob oid is `blob`, when known). */
export function referTo(shapes: SpanShape[], id: string, file: string, blob?: string): SpanRef | undefined {
	const shape = shapes.find((candidate) => candidate.id === id);

	if (shape === undefined) {
		return undefined;
	}

	const { before, after } = neighboursOf(shapes, shape);

	return {
		"span": shape.id,
		"key": "bablr1",
		"file": file,
		...blob === undefined ? {} : { "baseline": { "blob": blob, "start": shape.start, "end": shape.end } },
		"shape": { "type": shape.type, "atoms": shape.atoms },
		"context": { ...before === undefined ? {} : { "before": before.id }, ...after === undefined ? {} : { "after": after.id } }
	};
}

// ── strategies ──

/** A span a strategy found for a reference, how sure it is (0–1), and which strategy found it. */
export interface Candidate { "span": string; "file": string; "start"?: number; "end"?: number; "score": number; "strategy": string }

/** What strategies look in: the file the reference names, as it is now. `elsewhere` finds a span id in another file;
 *  `reidentified` is where the span's node went, by the structural diff from its baseline to this text (BABLR's
 *  `follow`): the same node (`kept` — a container survives edits inside it), or the one that replaced it. */
export interface Surroundings {
	"file": string;
	"shapes": SpanShape[];
	"elsewhere"?: (id: string) => { "file": string; "shape": SpanShape } | undefined;
	"reidentified"?: { "id": string; "how": "kept" | "replaced" };
}

export interface Strategy { "name": string; "find": (ref: SpanRef, here: Surroundings) => Candidate[] }

const candidate = (shape: SpanShape, file: string, score: number, strategy: string): Candidate => ({ "span": shape.id, "file": file, "start": shape.start, "end": shape.end, "score": score, "strategy": strategy });

/** Its id is in the file. */
export const sameSpan: Strategy = {
	"name": "same span",
	"find": (ref, here) => here.shapes.filter((shape) => shape.id === ref.span).map((shape) => candidate(shape, here.file, 1, "same span"))
};

/** Its id is in another file — ids don't depend on the file. */
export const moved: Strategy = {
	"name": "moved",
	"find": (ref, here) => {
		const found = here.elsewhere?.(ref.span);

		return found === undefined ? [] : [candidate(found.shape, found.file, 0.95, "moved")];
	}
};

/** How the re-identified strategy scores what the structural diff followed: a `base` (lower for a node an edit
 *  replaced than for one it kept), plus `weight` times how much of the node's head — its first `head` tokens, roughly a
 *  call's callee and first arguments, a function's name and signature — survived. The head matters because the diff
 *  matches containers by type alone: `fn(foo, bar, baz)` replaced by `other(1)` is still "the same" call to it. */
export interface FollowWeights { "kept": number; "replaced": number; "weight": number; "head": number }

export const FOLLOW_WEIGHTS: FollowWeights = { "kept": 0.6, "replaced": 0.5, "weight": 0.35, "head": 8 };

/** The baseline's node, followed onto the current text by the structural diff, is this span. */
export function reidentifiedStrategy(weights: FollowWeights = FOLLOW_WEIGHTS): Strategy {
	return {
		"name": "re-identified",
		"find": (ref, here) => {
			const followed = here.reidentified;

			return followed === undefined ? [] : here.shapes.filter((shape) => shape.id === followed.id).map((shape) => candidate(shape, here.file, (followed.how === "kept" ? weights.kept : weights.replaced) + weights.weight * similarity(ref.shape.atoms.slice(0, weights.head), shape.atoms.slice(0, weights.head)), "re-identified"));
		}
	};
}

export const reidentified = reidentifiedStrategy();

/** Twice the longest common subsequence of two token lists over their total length: 1 the same, 0 nothing shared. */
export function similarity(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) {
		return 1;
	}

	let previous = new Array<number>(b.length + 1).fill(0);

	for (const atom of a) {
		const row = [0];

		for (let index = 0; index < b.length; index += 1) {
			row.push(atom === b[index] ? previous[index] + 1 : Math.max(previous[index + 1], row[index]));
		}

		previous = row;
	}

	return (2 * previous[b.length]) / (a.length + b.length);
}

/** How the shape strategy weighs what it compares: shared tokens, surviving neighbours, nearness to where it was (sum
 *  to 1), and how far (in characters) halves nearness. */
export interface ShapeWeights { "tokens": number; "neighbours": number; "nearness": number; "halfDistance": number }

export const SHAPE_WEIGHTS: ShapeWeights = { "tokens": 0.7, "neighbours": 0.2, "nearness": 0.1, "halfDistance": 500 };

/** Spans of the same node type, scored by the tokens they share with the recorded shape, whether its recorded
 *  neighbours still sit beside them, and how near they are to where it was. */
export function sameShapeStrategy(weights: ShapeWeights = SHAPE_WEIGHTS): Strategy {
	return {
		"name": "same shape",
		"find": (ref, here) => here.shapes.filter((shape) => shape.type === ref.shape.type).map((shape) => {
			const recorded = [ref.context.before, ref.context.after].filter((id): id is string => id !== undefined);
			const { before, after } = recorded.length === 0 ? {} : neighboursOf(here.shapes, shape);
			const kept = recorded.filter((id) => id === before?.id || id === after?.id).length;
			const neighbours = recorded.length === 0 ? 0.5 : kept / recorded.length;
			const nearness = ref.baseline === undefined ? 0.5 : 1 / (1 + Math.abs(shape.start - ref.baseline.start) / weights.halfDistance);
			const score = weights.tokens * similarity(ref.shape.atoms, shape.atoms) + weights.neighbours * neighbours + weights.nearness * nearness;

			return candidate(shape, here.file, score, "same shape");
		}).filter((found) => found.score > 0.2).sort((a, b) => b.score - a.score).slice(0, 5)
	};
}

export const sameShape = sameShapeStrategy();

/** The strategies tried, in order. */
export const PIPELINE: Strategy[] = [sameSpan, moved, reidentified, sameShape];

// ── policy ──

/** What a score means: at or above `autoAt` (with no other candidate within `margin`) re-placed on its own; at or
 *  above `askAt`, uncertain; below, orphaned. */
export interface Policy { "autoAt": number; "askAt": number; "margin": number }

export const POLICY: Policy = { "autoAt": 0.85, "askAt": 0.5, "margin": 0.05 };

/** Where an annotation stands: on its own span (`attached`), on its span in another file (`moved`), placed by a match
 *  sure enough to act on (`re-placed`), placed by a match to confirm (`uncertain`), or nowhere (`orphaned`). */
export type Status = "attached" | "moved" | "re-placed" | "uncertain" | "orphaned";

export interface Resolution { "status": Status; "candidate"?: Candidate; "alternatives": Candidate[] }

/** Find `ref`'s place: try `pipeline`'s strategies in order — a strategy's best, sure enough under `policy` and clear of
 *  any close second, ends the search — then decide by `policy` on the best of everything found. */
export function resolve(ref: SpanRef, here: Surroundings, pipeline: Strategy[] = PIPELINE, policy: Policy = POLICY): Resolution {
	const found: Candidate[] = [];

	for (const strategy of pipeline) {
		const ranked = strategy.find(ref, here).sort((a, b) => b.score - a.score);
		const [best, second] = ranked;

		found.push(...ranked);

		if (best !== undefined && best.score >= policy.autoAt && (second === undefined || best.score - second.score >= policy.margin)) {
			break;
		}
	}

	const ranked = found.sort((a, b) => b.score - a.score);
	const [best, second] = ranked;
	const alternatives = ranked.slice(1, 4);

	if (best === undefined || best.score < policy.askAt) {
		return { "status": "orphaned", "alternatives": ranked.slice(0, 3) };
	}

	const clear = second === undefined || best.score - second.score >= policy.margin || second.span === best.span;

	if (best.strategy === "same span") {
		return { "status": "attached", "candidate": best, "alternatives": alternatives };
	}

	if (best.strategy === "moved") {
		return { "status": "moved", "candidate": best, "alternatives": alternatives };
	}

	return { "status": best.score >= policy.autoAt && clear ? "re-placed" : "uncertain", "candidate": best, "alternatives": alternatives };
}

// ── evaluation ──

/** An edit case: a reference made before an edit, the file after it, and the span it should land on (null: it should
 *  be orphaned — its code went). */
export interface EditCase { "name": string; "ref": SpanRef; "here": Surroundings; "expected": string | null }

export interface Evaluation {
	/** Placed on its own (attached, moved, re-placed): on the right span, or the wrong one. */
	"right": string[];
	"wrong": string[];
	/** Left to the user (uncertain or orphaned): with the right span the best guess, or not; or correctly orphaned. */
	"askedRight": string[];
	"askedWrong": string[];
	"orphanedRight": string[];
}

/** How `pipeline` under `policy` does on `cases` — wrong is the costly bucket: an annotation silently moved. */
export function evaluate(cases: EditCase[], pipeline: Strategy[] = PIPELINE, policy: Policy = POLICY): Evaluation {
	const result: Evaluation = { "right": [], "wrong": [], "askedRight": [], "askedWrong": [], "orphanedRight": [] };

	for (const edit of cases) {
		const { status, candidate: best } = resolve(edit.ref, edit.here, pipeline, policy);
		const decided = status === "attached" || status === "moved" || status === "re-placed";

		if (decided) {
			(best?.span === edit.expected ? result.right : result.wrong).push(edit.name);
		} else if (edit.expected === null && status === "orphaned") {
			result.orphanedRight.push(edit.name);
		} else {
			(best?.span === edit.expected ? result.askedRight : result.askedWrong).push(edit.name);
		}
	}

	return result;
}

// ── storage ──

/** Where `user`'s annotations of `collection` on `file` (repo-relative) go, from the repo root. */
export function annotationsPath(collection: string, user: string, file: string): string {
	return `${SILO_DIR}/${slug(collection) ?? "annotations"}/${slug(user) ?? "local"}/${file}.jsonl`;
}

/** The annotations in a file, each once: a branch merge can bring two versions of one in; the one updated last wins,
 *  tombstones included (filter on `dismissed` for the live ones). Lines that aren't one are skipped. */
export function parseAnnotations(text: string): Annotation[] {
	const byId = new Map<string, Annotation>();

	for (const line of text.split("\n")) {
		try {
			const value = JSON.parse(line) as Partial<Annotation>;

			if (typeof value.id === "string" && typeof value.updatedAt === "string" && value.ref !== undefined) {
				const known = byId.get(value.id);

				if (known === undefined || value.updatedAt > known.updatedAt) {
					byId.set(value.id, value as Annotation);
				}
			}
		} catch { /* not a line of ours */ }
	}

	return [...byId.values()];
}

/** An annotations file's text: one per line, sorted by id, so concurrent edits touch distinct lines. */
export function annotationsText(annotations: Annotation[]): string {
	return [...annotations].sort((a, b) => a.id.localeCompare(b.id)).map((annotation) => JSON.stringify(annotation) + "\n").join("");
}
