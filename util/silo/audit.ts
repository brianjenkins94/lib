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

import { isEntry } from "@brianjenkins94/util/env";
import { find } from "@brianjenkins94/util/find";
import * as fs from "@brianjenkins94/util/fs";

import { type Surface, type SurfaceEntry, type WsConsumer, add, classifyKind, consumerOf, detect, packageCaps, surfaceEntries } from "./detect.js";
import { surfaceOfSource } from "./oxc.js";
import { type BaselinePackages, syncPackages } from "./evidence.js";
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
	// Prune node_modules, dot-directories and NESTED private workspaces (they self-govern) — never the target
	// itself: the project being audited is usually `private: true` and must still be walked.
	const prune = (dir: string) => dir !== target && (path.basename(dir) === "node_modules" || path.basename(dir).startsWith(".") || isPrivateWorkspace(dir));

	return (await find(target).type("f").prune(prune).exec()).filter((f) => !path.basename(f).startsWith(".") && isCode(path.basename(f)));
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

	for (const [ws, surface] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) { out[ws] = surfaceEntries(surface); }

	return out;
}

/** Per workspace, which files import each specifier — so drift can attribute a drifting capability back to
 *  the source file(s) that brought it in. Same walk/keys as `workspaceSurfaces`; file paths relative to cwd. */
export async function workspaceImporters(target: string, root: string): Promise<Record<string, Record<string, string[]>>> {
	const out: Record<string, Record<string, string[]>> = {};

	for (const f of await files(path.resolve(target))) {
		const ws = owningWorkspace(f, root);
		const rel = path.relative(process.cwd(), f);
		out[ws] ??= {};
		const byWs = out[ws];

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

export type { WsConsumer };
type PkgEntry = BaselinePackages[string];
export interface Baseline { "consumer": Record<string, WsConsumer>; "packages": BaselinePackages }

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
	// (each workspace's deps resolved local-first, then hoisted root)
	return consumerOf(await workspaceSurfaces(path.resolve(target), root), (workspace, pkg) => classify(pkg, path.join(root, workspace), root).version);
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

/** Every package installed in `root`'s node_modules — nested installs too (npm's layout), each by name with the version
 *  its package.json gives (the first found, root before nested, keeps the name) — and the capabilities ITS OWN files can
 *  reach: `./detect`'s scan of each code file, never what it depends on (each dependency is its own entry). What a run
 *  sees a package do is told apart the same way (an effect's `package`), so the two compare. */
export async function installedPackages(root: string): Promise<Record<string, PkgEntry>> {
	const packages: Record<string, PkgEntry> = {};
	const queue = [path.join(root, "node_modules")];
	const manifestOf = (dir: string): { "name"?: string; "version"?: string } | undefined => {
		try {
			return JSON.parse(fs.readFileSync(path.join(dir, "package.json")));
		} catch {
			return undefined;
		}
	};

	// (its own files — never a nested node_modules: each dependency is its own entry — read for detect's one package analysis)
	const ownCaps = async (dir: string): Promise<string[]> => {
		const files = await find(dir).type("f").prune((container) => container !== dir && path.basename(container) === "node_modules").exec();

		return packageCaps(files.map((file) => path.relative(dir, file).split(path.sep).join("/")).filter((file) => /\.[cm]?js$/u.test(file) || file === "package.json").map((file) => [file, fs.readFileSync(path.join(dir, file))] as const));
	};

	while (queue.length > 0) {
		const modules = queue.shift() ?? "";
		const names = fs.existsSync(modules) ? (await fs.readdir(modules)).filter((name) => !name.startsWith(".")) : [];
		const dirs = (await Promise.all(names.map(async (name) => (name.startsWith("@") ? (await fs.readdir(path.join(modules, name))).map((scoped) => path.join(modules, name, scoped)) : [path.join(modules, name)])))).flat();

		for (const dir of dirs.sort()) {
			const pj = manifestOf(dir);

			if (pj !== undefined) {
				const name = pj.name ?? path.relative(modules, dir);

				if (fs.existsSync(path.join(dir, "node_modules"))) {
					queue.push(path.join(dir, "node_modules"));
				}

				if (!(name in packages)) {
					packages[name] = { ...pj.version === undefined ? {} : { "version": pj.version }, "caps": await ownCaps(dir) };
				}
			}
		}
	}

	return Object.fromEntries(Object.entries(packages).sort(([one], [other]) => one.localeCompare(other)));
}

/** First-run onboarding: take the CURRENT surface as the baseline starting line and write it — what the code imports
 *  (`consumer`) and what each installed package can do (`packages`) — the TOFU bare `silo` does on a fresh project.
 *  Every later expansion still drifts against this. */
export async function establishBaseline(paths: SiloPaths, target: string): Promise<Baseline> {
	const b = loadBaseline(paths);

	b.consumer = await consumerSurface(target, paths.root);
	b.packages = await installedPackages(paths.root);
	await saveBaseline(paths, b);

	return b;
}

/** The baseline, made if there isn't one (establishBaseline) — else brought up to what's installed: a library added is
 *  taken as its code is, a new version that can do more records what it grew (evidence's syncPackages). It's never
 *  remade, and runs never change it. `changed` names the packages synced (none when it was just made). */
export async function ensureBaseline(paths: SiloPaths, target: string = paths.root): Promise<{ "created": boolean; "baseline": Baseline; "changed": ReturnType<typeof syncPackages>["changed"] }> {
	const none = { "added": [], "updated": [], "grew": [] };

	if (!fs.existsSync(paths.baseline)) {
		return { "created": true, "baseline": await establishBaseline(paths, target), "changed": none };
	}

	const baseline = loadBaseline(paths);
	const { packages, changed } = syncPackages(baseline.packages, await installedPackages(paths.root));

	if (changed.added.length + changed.updated.length + changed.grew.length > 0) {
		baseline.packages = Object.fromEntries(Object.entries(packages).toSorted(([one], [other]) => one.localeCompare(other)));
		await saveBaseline(paths, baseline);
	}

	return { "created": false, "baseline": baseline, "changed": changed };
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

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const root = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-audit-"));
		const write = async (relative: string, text: string): Promise<void> => {
			await fs.mkdir(path.dirname(path.join(root, relative)), { "recursive": true });
			fs.writeFileSync(path.join(root, relative), text);
		};

		await write("package.json", JSON.stringify({ "name": "app", "private": true }));
		await write("app.js", "import { spawn } from \"tool\";\nspawn();\n");
		await write("node_modules/tool/package.json", JSON.stringify({ "name": "tool", "version": "1.0.0" }));
		await write("node_modules/tool/index.js", "const cp = require(\"child_process\"); exports.spawn = () => cp.execSync(\"ls\");");
		await write("node_modules/tool/node_modules/fetcher/package.json", JSON.stringify({ "name": "fetcher", "version": "2.0.0" }));
		await write("node_modules/tool/node_modules/fetcher/index.js", "module.exports = () => fetch(\"https://example.com\");");
		await write("node_modules/@scope/quiet/package.json", JSON.stringify({ "name": "@scope/quiet", "version": "0.1.0" }));
		await write("node_modules/@scope/quiet/index.js", "module.exports = 1;");

		// Each package by its own files: tool's exec isn't fetcher's, nor fetcher's net tool's.
		const packages = await installedPackages(root);

		assert.deepEqual(Object.keys(packages), ["@scope/quiet", "fetcher", "tool"]);
		assert.deepEqual(packages["tool"], { "version": "1.0.0", "caps": ["exec"] });
		assert.deepEqual(packages["fetcher"]?.caps, ["net"]);
		assert.deepEqual(packages["@scope/quiet"]?.caps, []);

		// The one package analysis, on files however they were read: code files, and install hooks (a hook is exec, plus
		// what its command reveals); what isn't code (a README naming a call) is not.
		assert.deepEqual(packageCaps([
			["package.json", JSON.stringify({ "name": "probe", "scripts": { "postinstall": "node -e \"fetch('https://x.example')\"", "test": "rm -rf /" } })],
			["index.js", "module.exports = () => require('fs').readFileSync('a');"],
			["README.md", "require('child_process').execSync('ls')"]
		]), ["exec", "fs:read", "net"]);
		assert.deepEqual(packageCaps([["package.json", "{"], ["index.js", "module.exports = 1;"]]), [], "no hooks, nothing it can do");

		// Made once; then kept up to what's installed, never remade: a library added is taken as it is, and a new version
		// that can do more records what it grew.
		const paths = siloPaths(root);
		const first = await ensureBaseline(paths);

		assert.equal(first.created, true);
		assert.ok("tool" in first.baseline.packages);
		fs.writeFileSync(paths.baseline, JSON.stringify({ ...first.baseline, "packages": { "tool": { "version": "0.9.0", "caps": [] } } }));

		const again = await ensureBaseline(paths);

		assert.equal(again.created, false);
		assert.deepEqual(again.changed, { "added": ["@scope/quiet", "fetcher"], "updated": [], "grew": ["tool"] });
		assert.deepEqual(loadBaseline(paths).packages["tool"], { "version": "1.0.0", "caps": ["exec"], "grew": { "exec": "1.0.0" } });
		assert.deepEqual((await ensureBaseline(paths)).changed, { "added": [], "updated": [], "grew": [] }, "nothing installed changed: nothing to do");

		await fs.rm(root, { "recursive": true, "force": true });
	})();
}
