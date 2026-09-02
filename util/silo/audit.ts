/**
 * silo — the Node audit layer over the pure kernels (`./detect`, `./review`). Extracted from the `silo`
 * prototype; combines `detect/import-surface.ts` (fs file-walking), `commands/audit.ts` (baseline + drift),
 * `shared/paths.ts` (root/`.silo/` layout), and the fs half of `commands/review-store.ts` — with silo's two
 * heavy edges CUT:
 *
 *   • NO node_modules-package capability probing (silo's `detect/package-capabilities` → rolldown/webcrack
 *     DCE — that lives in `./packages`). A builtin's caps come from `./detect` `builtinCaps`; a package
 *     records its member/version surface but no bundle-probed cap set. A file's own reach is `./detect`
 *     `detect` (a pure source scan).
 *   • NO trust-ratchet review coupling in drift (silo's git-heavy `commands/review.ts`). `capabilityDrift`
 *     returns the capability/surface diff as data; review STATE is read from the store via `./review`
 *     `understoodOf`, separately.
 *
 * The project root is a PARAMETER (default `findRoot(cwd)`), not the cwd-anchored module constants silo used.
 */

import * as path from "node:path";

import * as fs from "@brianjenkins94/util/fs";

import { type Surface, type SurfaceEntry, add, builtinCaps, classifyKind, detect, surfaceOfSource } from "./detect.js";
import { type SiloPaths, ensureSiloDir, findRoot, siloPaths } from "./paths.js";
import { type ReviewStore, serializeStore } from "./review.js";

// The `.silo/` location + layout live in ./paths (oxc-free, shared with ./runs and util/mcp). Re-exported so
// `@brianjenkins94/util/silo/audit` stays a one-stop import for the audit surface.
export { ensureSiloDir, findRoot, siloPaths, type SiloPaths };

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Consumer surface — which members of each dependency the code imports (silo's detect/import-surface.ts)
// ───────────────────────────────────────────────────────────────────────────────────────────────────

const isCode = (f: string) => /\.(m|c)?[jt]sx?$/.test(f);

/** Classify a specifier and, for real deps, resolve the installed version from node_modules. Kind is the
 *  pure part (`./detect` `classifyKind`); version resolution is Node-only. */
export function classify(spec: string, fromDir: string, stopRoot: string = fromDir): { "kind": "builtin" | "package" | "local"; "pkg"?: string; "version"?: string } {
	const kind = classifyKind(spec);

	if (kind.kind !== "package") { return kind; }
	const pkg = kind.pkg as string;

	// Walk node_modules up from the workspace dir to the project root: a workspace-local version wins, else the
	// hoisted root one — so non-hoisted monorepos resolve the version each package actually has.
	for (let d = path.resolve(fromDir), stop = path.resolve(stopRoot); ; d = path.dirname(d)) {
		const pj = path.join(d, "node_modules", pkg, "package.json");

		if (fs.existsSync(pj)) { try { return { "kind": "package", "pkg": pkg, "version": JSON.parse(fs.readFileSync(pj)).version }; } catch { break; } }
		if (d === stop || d === path.dirname(d)) { break; }
	}

	return { "kind": "package", "pkg": pkg };
}

/** The consumer surface of a file — reads it, then delegates to the pure kernel. */
export function analyze(file: string): Surface {
	return surfaceOfSource(file, fs.readFileSync(file));
}

/** A directory that is its own package and is marked `private: true`. Such NESTED workspaces are silo-ignored
 *  everywhere — a private subproject carries its own deps and isn't governed by the enclosing baseline. */
function isPrivateWorkspace(dir: string): boolean {
	const pj = path.join(dir, "package.json");

	if (!fs.existsSync(pj)) { return false; }
	try { return JSON.parse(fs.readFileSync(pj))["private"] === true; } catch { return false; }
}

async function files(target: string): Promise<string[]> {
	const st = await fs.stat(target);

	if (st.isFile()) { return [target]; }
	const out: string[] = [];

	for (const e of await fs.readdir(target, { "withFileTypes": true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) { continue; }
		const p = path.join(target, e.name);

		// Descend into subdirectories, but prune a nested private workspace (it self-governs).
		if (e.isDirectory()) { if (!isPrivateWorkspace(p)) { out.push(...(await files(p))); } } else if (isCode(e.name)) { out.push(p); }
	}

	return out;
}

/** Merge every code file under `target` into one consumer surface (specifier → members). */
export async function projectSurface(target: string): Promise<{ "perFile": Record<string, Record<string, SurfaceEntry>>; "surface": Record<string, SurfaceEntry> }> {
	const merged: Surface = new Map();
	const perFile: Record<string, Record<string, SurfaceEntry>> = {};

	for (const f of await files(path.resolve(target))) {
		const s = analyze(f);

		perFile[path.relative(process.cwd(), f)] = Object.fromEntries([...s].map(([k, v]) => [k, { "members": [...v.members].sort(), "dynamic": v.dynamic }]));
		for (const [spec, use] of s) { for (const m of use.members) { add(merged, spec, m); } if (use.dynamic) { add(merged, spec, "", true); } }
	}

	return { "perFile": perFile, "surface": Object.fromEntries([...merged].map(([k, v]) => [k, { "members": [...v.members].sort(), "dynamic": v.dynamic }])) };
}

/** Nearest enclosing package (a file's "workspace"), as a path relative to `root` ("." for root code). */
function owningWorkspace(file: string, root: string): string {
	const rootAbs = path.resolve(root);

	for (let d = path.dirname(path.resolve(file)); ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "package.json"))) { return path.relative(rootAbs, d) || "."; }
		if (d === rootAbs || d === path.dirname(d)) { return "."; }
	}
}

/** Like projectSurface, but partitioned by workspace (nearest package.json) — so a monorepo audit can
 *  attribute each dep's usage to the package that imports it, keyed by path relative to `root`. */
export async function workspaceSurfaces(target: string, root: string): Promise<Record<string, Record<string, SurfaceEntry>>> {
	const buckets = new Map<string, Surface>();

	for (const f of await files(path.resolve(target))) {
		const ws = owningWorkspace(f, root);
		const bucket = buckets.get(ws) ?? new Map();

		buckets.set(ws, bucket);
		for (const [spec, use] of analyze(f)) {
			for (const m of use.members) { add(bucket, spec, m); }
			if (use.dynamic) { add(bucket, spec, "", true); }
		}
	}

	const out: Record<string, Record<string, SurfaceEntry>> = {};

	for (const [ws, surface] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) { out[ws] = Object.fromEntries([...surface].map(([k, v]) => [k, { "members": [...v.members].sort(), "dynamic": v.dynamic }])); }

	return out;
}

/** Per workspace, which files import each specifier — so drift can attribute a drifting capability back to
 *  the source file(s) that brought it in. Same walk/keys as `workspaceSurfaces`; file paths relative to cwd. */
export async function workspaceImporters(target: string, root: string): Promise<Record<string, Record<string, string[]>>> {
	const out: Record<string, Record<string, string[]>> = {};

	for (const f of await files(path.resolve(target))) {
		const ws = owningWorkspace(f, root);
		const rel = path.relative(process.cwd(), f);
		const byWs = out[ws] ??= {};

		for (const spec of analyze(f).keys()) { (byWs[spec] ??= []).push(rel); }
	}

	return out;
}

/** A file's own reachable capabilities — the pure `./detect` `detect` source scan (fs:read/write, net, exec,
 *  eval, env), no bundler. Coarse but honest: it sees direct calls/imports in the file, not what an imported
 *  dependency reaches (that's `./packages`' DCE path). */
export function capabilitiesOf(file: string): string[] {
	return detect(fs.readFileSync(file));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Baseline + capability drift (silo's commands/audit.ts, minus the package-DCE and the review ratchet)
// ───────────────────────────────────────────────────────────────────────────────────────────────────

interface DepEntry { "kind": string; "version"?: string; "members": string[]; "dynamic": boolean; "caps": string[] }
export type WsConsumer = Record<string, DepEntry>;   // spec → dep, for one workspace
interface PkgEntry { "version"?: string; "caps": string[] }
export interface Baseline { "consumer": Record<string, WsConsumer>; "packages": Record<string, PkgEntry> }

export const loadBaseline = (paths: SiloPaths): Baseline => ({ "consumer": {}, "packages": {}, ...(fs.existsSync(paths.baseline) ? JSON.parse(fs.readFileSync(paths.baseline)) : {}) });

export async function saveBaseline(paths: SiloPaths, b: Baseline): Promise<void> {
	await ensureSiloDir(paths);
	fs.writeFileSync(paths.baseline, JSON.stringify(b, null, 2) + "\n");
}

/** The current OWN-CODE consumer surface under `target`, partitioned by workspace: per dependency, which
 *  members are imported (+ dynamic), its resolved version, and — for builtins — the capabilities that reach
 *  (`./detect` `builtinCaps`). Packages carry an empty `caps` (no DCE probe here); their drift is tracked by
 *  member/version/dynamic expansion. This is silo `auditConsumer`'s data-collection half, without printing. */
export async function consumerSurface(target: string, root: string): Promise<Record<string, WsConsumer>> {
	const surfaces = await workspaceSurfaces(path.resolve(target), root);
	const out: Record<string, WsConsumer> = {};

	for (const ws of Object.keys(surfaces).sort()) {
		const wsDir = path.join(root, ws);   // resolve this workspace's deps local-first, then hoisted root
		const cur: WsConsumer = out[ws] = {};

		for (const [spec, use] of Object.entries(surfaces[ws]).sort((a, b) => a[0].localeCompare(b[0]))) {
			const c = classify(spec, wsDir, root);

			if (c.kind === "local") { continue; }   // own files — tracked as their own units, not deps
			const caps = c.kind === "builtin" ? builtinCaps(spec, use.members, use.dynamic) : [];

			cur[spec] = { "kind": c.kind, "version": c.version, "members": use.members, "dynamic": use.dynamic, "caps": caps };
		}
	}

	return out;
}

/** One dependency's change vs the baseline. `new`/`expanded` count as drift; `version`/`removed` are
 *  reported but don't (a version bump or a dropped dep isn't a capability EXPANSION). */
export interface CapabilityChange {
	"workspace": string;
	"spec": string;
	"kind": "new" | "expanded" | "version" | "removed";
	"addedMembers"?: string[];
	"addedCaps"?: string[];
	"newDynamic"?: boolean;
	"from"?: string;
	"to"?: string;
}

export interface DriftResult { "fresh": boolean; "drift": number; "changes": CapabilityChange[] }

/** Capability drift of `target` vs the committed baseline — structured, never printed. `fresh` = no baseline
 *  yet (nothing to gate against; onboard first). Mirrors silo `auditConsumer`'s new/↑/~/removed marks. */
export async function capabilityDrift(paths: SiloPaths, target: string): Promise<DriftResult> {
	if (!fs.existsSync(paths.baseline)) { return { "fresh": true, "drift": 0, "changes": [] }; }

	const b = loadBaseline(paths);
	const next = await consumerSurface(target, paths.root);
	const changes: CapabilityChange[] = [];

	for (const ws of Object.keys(next).sort()) {
		const prev = b.consumer[ws] ?? {};
		const cur = next[ws];

		for (const spec of Object.keys(cur).sort()) {
			const p = prev[spec];
			const n = cur[spec];

			if (!p) { changes.push({ "workspace": ws, "spec": spec, "kind": "new", "addedMembers": n.members, "addedCaps": n.caps, ...(n.dynamic ? { "newDynamic": true } : {}) }); continue; }

			const addedMembers = n.members.filter((m) => !p.members.includes(m));
			const addedCaps = n.caps.filter((x) => !(p.caps ?? []).includes(x));
			const newDynamic = n.dynamic && !p.dynamic;

			if (addedMembers.length || addedCaps.length || newDynamic) {
				changes.push({ "workspace": ws, "spec": spec, "kind": "expanded", ...(addedMembers.length ? { "addedMembers": addedMembers } : {}), ...(addedCaps.length ? { "addedCaps": addedCaps } : {}), ...(newDynamic ? { "newDynamic": true } : {}) });
			} else if (n.version && p.version && n.version !== p.version) {
				changes.push({ "workspace": ws, "spec": spec, "kind": "version", "from": p.version, "to": n.version });
			}
		}

		for (const spec of Object.keys(prev).filter((s) => !(s in cur))) { changes.push({ "workspace": ws, "spec": spec, "kind": "removed" }); }
	}

	// A workspace present in the baseline but gone now — every dep it had reads as removed.
	for (const ws of Object.keys(b.consumer).filter((w) => !(w in next))) {
		for (const spec of Object.keys(b.consumer[ws])) { changes.push({ "workspace": ws, "spec": spec, "kind": "removed" }); }
	}

	const drift = changes.filter((c) => c.kind === "new" || c.kind === "expanded").length;

	return { "fresh": false, "drift": drift, "changes": changes };
}

/** First-run onboarding: accept the CURRENT consumer surface as the baseline starting line and write it
 *  (the TOFU bare `silo` does on a fresh project). Every later expansion still drifts against this. */
export async function establishBaseline(paths: SiloPaths, target: string): Promise<Baseline> {
	const b = loadBaseline(paths);

	b.consumer = await consumerSurface(target, paths.root);
	await saveBaseline(paths, b);

	return b;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Review store — fs persistence for the hash-anchored review records (record shape lives in ./review)
// ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Load `.silo/review.json` (unit id → record), or `{}` when it doesn't exist yet. */
export function loadReviewStore(paths: SiloPaths): ReviewStore {
	try { return JSON.parse(fs.readFileSync(paths.review)); } catch { return {}; }
}

/** Write the review store, git-merge-friendly (sorted, one record per line — see `./review` `serializeStore`). */
export async function saveReviewStore(paths: SiloPaths, store: ReviewStore): Promise<void> {
	await ensureSiloDir(paths);
	fs.writeFileSync(paths.review, serializeStore(store));
}
