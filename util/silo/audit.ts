/**
 * silo — the Node audit layer over the pure kernels (`./detect`, `./reach`). Extracted from the `silo`
 * prototype; combines `detect/import-surface.ts` (fs file-walking), `commands/audit.ts` (baseline + drift) and
 * `shared/paths.ts` (root/`.silo/` layout). A builtin's caps come from `./detect` `builtinCaps`; a package's, in the
 * code's use of it, are the join — what the members the code imports reach (`./slice`, rolldown tree-shaking the
 * package's files in node_modules), as the editor's are off its tarball. The prototype's per-function review was
 * dropped.
 *
 * Each file's import surface is read by TypeScript ≥ 7.1 (`./typescript`'s readSources, `./reach`'s surfaceOf) — the
 * caller's (silo bundles one), else the project's own.
 *
 * The project root is a PARAMETER (default `findRoot(cwd)`), not the cwd-anchored module constants silo used.
 */

import * as path from "node:path";

import { isEntry } from "@brianjenkins94/util/env";
import { find } from "@brianjenkins94/util/find";
import * as fs from "@brianjenkins94/util/fs";

import { type Surface, type SurfaceEntry, type WsConsumer, add, classifyKind, consumerOf, detect, packageCaps, surfaceEntries } from "./detect.js";
import { type BaselinePackages, JOIN, joinedBefore, joinsWanted, syncConsumer, syncPackages } from "./evidence.js";
import { type SiloPaths, ensureSiloDir, findRoot, siloPaths } from "./paths.js";
import { surfaceOf } from "./reach.js";
import { type Rolldown, sliceCaps } from "./slice.js";
import { type TypeScriptModules, astOf, readSources, typescriptModules } from "./typescript.js";

// The `.silo/` location + layout live in ./paths (parser-free, shared with ./runs and util/mcp). Re-exported so
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
	const dir = packageDir(pkg, fromDir, stopRoot);

	if (dir !== undefined) {
		try { return { "kind": "package", "pkg": pkg, "version": JSON.parse(fs.readFileSync(path.join(dir, "package.json"))).version }; } catch { /* (unreadable: no version) */ }
	}

	return { "kind": "package", "pkg": pkg };
}

/** Where package `pkg` is installed for code in `fromDir`: node_modules walked up to `stopRoot` — a workspace-local
 *  install wins, else the hoisted one, so a non-hoisted monorepo resolves the copy each workspace actually has. */
export function packageDir(pkg: string, fromDir: string, stopRoot: string = fromDir): string | undefined {
	for (let d = path.resolve(fromDir), stop = path.resolve(stopRoot); ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "node_modules", pkg, "package.json"))) { return path.join(d, "node_modules", pkg); }
		if (d === stop || d === path.dirname(d)) { return undefined; }
	}
}

/** A package's own files (in `dir`) that its analysis reads — code files and the manifest, by path within it — never a
 *  nested node_modules: each dependency is its own entry. */
export async function ownFiles(dir: string): Promise<Map<string, string>> {
	const files = await find(dir).type("f").prune((container) => container !== dir && path.basename(container) === "node_modules").exec();

	return new Map(files.map((file) => path.relative(dir, file).split(path.sep).join("/")).filter((file) => /\.[cm]?js$/u.test(file) || file === "package.json").map((file) => [file, fs.readFileSync(path.join(dir, file))] as const));
}

/** TypeScript ≥ 7.1 to read the code with: `typescript`, else the project's own (at `root`). Throws without one. */
async function typescriptFor(root: string, typescript?: TypeScriptModules): Promise<TypeScriptModules> {
	const found = typescript ?? await typescriptModules(root);

	if (found === undefined) {
		throw new Error("silo reads the code with TypeScript 7.1 or later: install one in the project (silo bundles its own)");
	}

	return found;
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

/** Nearest enclosing package (a file's "workspace"), as a path relative to `root` ("." for root code). */
function owningWorkspace(file: string, root: string): string {
	const rootAbs = path.resolve(root);

	for (let d = path.dirname(path.resolve(file)); ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "package.json"))) { return path.relative(rootAbs, d) || "."; }
		if (d === rootAbs || d === path.dirname(d)) { return "."; }
	}
}

/** Each workspace's surface (its nearest package.json's folder, relative to `root`): what its code files under
 *  `target` import, read by `typescript` — so a monorepo audit attributes each dep's usage to the package that imports it. */
export async function workspaceSurfaces(target: string, root: string, typescript: TypeScriptModules): Promise<Record<string, Record<string, SurfaceEntry>>> {
	const all = await files(path.resolve(target));
	const sources = readSources(typescript, path.resolve(root), all);
	const ts = astOf(typescript);
	const buckets = new Map<string, Surface>();

	try {
		for (const f of all) {
			const sourceFile = sources.read(f);
			const ws = owningWorkspace(f, root);
			const bucket = buckets.get(ws) ?? new Map();

			buckets.set(ws, bucket);

			for (const [spec, use] of sourceFile === undefined ? [] : surfaceOf(ts, sourceFile)) {
				for (const m of use.members) { add(bucket, spec, m); }
				if (use.dynamic) { add(bucket, spec, "", true); }
			}
		}
	} finally {
		sources.close();
	}

	const out: Record<string, Record<string, SurfaceEntry>> = {};

	for (const [ws, surface] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) { out[ws] = surfaceEntries(surface); }

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
export interface Baseline { "consumer": Record<string, WsConsumer>; "packages": BaselinePackages; "join"?: number }

export const loadBaseline = (paths: SiloPaths): Baseline => ({ "consumer": {}, "packages": {}, ...(fs.existsSync(paths.baseline) ? JSON.parse(fs.readFileSync(paths.baseline)) : {}) });

export async function saveBaseline(paths: SiloPaths, b: Baseline): Promise<void> {
	await ensureSiloDir(paths);
	fs.writeFileSync(paths.baseline, JSON.stringify(b, null, 2) + "\n");
}

/** The current OWN-CODE consumer surface under `target`, partitioned by workspace: per dependency, which
 *  members are imported (+ dynamic), its resolved version, and — for builtins — the capabilities that reach
 *  (`./detect` `builtinCaps`). Packages carry an empty `caps` (no DCE probe here); their drift is tracked by
 *  member/version/dynamic expansion. This is silo `auditConsumer`'s data-collection half, without printing. */
export async function consumerSurface(target: string, root: string, typescript?: TypeScriptModules): Promise<Record<string, WsConsumer>> {
	// (each workspace's deps resolved local-first, then hoisted root)
	return consumerOf(await workspaceSurfaces(path.resolve(target), root, await typescriptFor(root, typescript)), (workspace, pkg) => classify(pkg, path.join(root, workspace), root).version);
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
export async function capabilityDrift(paths: SiloPaths, target: string, typescript?: TypeScriptModules): Promise<DriftResult> {
	if (!fs.existsSync(paths.baseline)) { return { "fresh": true, "drift": 0, "changes": [] }; }

	const b = loadBaseline(paths);
	const next = await consumerSurface(target, paths.root, typescript);
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

	// (its own files read for detect's one package analysis)
	const ownCaps = async (dir: string): Promise<string[]> => packageCaps(await ownFiles(dir));

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

/** rolldown's, to slice with: `rolldown` when given, else the one installed beside util (its optional peer); undefined
 *  without one — every join is then the whole package's. */
async function rolldownOf(rolldown?: Rolldown): Promise<Rolldown | undefined> {
	// (a specifier made at run time, so a bundler of this module doesn't follow it)
	return rolldown ?? (await import(/* @vite-ignore */ ["rolldown"].join("")).catch(() => undefined) as { "rolldown"?: Rolldown } | undefined)?.rolldown;
}

/**
 * Each package entry of the code's use (`read`, consumerSurface's) set to its join — kept from `existing` where it's
 * the same use of the same version (evidence's joinsWanted), else its slice read off the package's files in
 * node_modules (`./slice`), or the whole package's capabilities where no slice could be built (or there's no
 * rolldown). A package that isn't installed keeps none: the policy decides its calls.
 */
export async function joinUses(read: Record<string, WsConsumer>, existing: Baseline | undefined, root: string, rolldown?: Rolldown): Promise<void> {
	const wanted = joinsWanted(read, existing);
	const bundler = wanted.size > 0 ? await rolldownOf(rolldown) : undefined;

	for (const [name, slices] of wanted) {
		// (by where each workspace's copy is: a non-hoisted monorepo can hold more than one)
		const byDir = Map.groupBy(slices, (slice) => packageDir(name, path.join(root, slice.workspace), root) ?? "");

		for (const [dir, each] of byDir) {
			if (dir === "") {
				continue;
			}

			const files = await ownFiles(dir);
			const whole = packageCaps(files);

			for (const slice of each) {
				read[slice.workspace][slice.spec].caps = (bundler === undefined ? undefined : await sliceCaps(bundler, name, files, slice.spec, slice.members)) ?? whole;
			}
		}
	}
}

/** First-run onboarding: take the CURRENT surface as the baseline starting line and write it — what the code imports
 *  (`consumer`, with the join of each package's use) and what each installed package can do (`packages`) — the TOFU
 *  bare `silo` does on a fresh project. Every later expansion still drifts against this. */
export async function establishBaseline(paths: SiloPaths, target: string, typescript?: TypeScriptModules, rolldown?: Rolldown): Promise<Baseline> {
	const b = loadBaseline(paths);

	b.consumer = await consumerSurface(target, paths.root, typescript);
	await joinUses(b.consumer, undefined, paths.root, rolldown);
	b.packages = await installedPackages(paths.root);
	b.join = JOIN;
	await saveBaseline(paths, b);

	return b;
}

/** The baseline, made if there isn't one (establishBaseline) — else brought up to what's installed and to the code: a
 *  library added is taken as its code is, a new version that can do more records what it grew (evidence's
 *  syncPackages), and the code's use of each package — its join — records what it reaches more, with the members that
 *  brought it in (evidence's syncConsumer). It's never remade, and runs never change it. `changed` names the packages
 *  synced, `used` the uses that grew (`workspace spec`; none of either when it was just made). `typescript` reads the
 *  code (default: the project's own, ≥ 7.1); `rolldown` slices the joins (default: the one beside util). */
export async function ensureBaseline(paths: SiloPaths, target: string = paths.root, typescript?: TypeScriptModules, rolldown?: Rolldown): Promise<{ "created": boolean; "baseline": Baseline; "changed": ReturnType<typeof syncPackages>["changed"]; "used": string[] }> {
	const none = { "added": [], "updated": [], "grew": [] };

	if (!fs.existsSync(paths.baseline)) {
		return { "created": true, "baseline": await establishBaseline(paths, target, typescript, rolldown), "changed": none, "used": [] };
	}

	const baseline = loadBaseline(paths);
	const before = JSON.stringify(baseline);
	const { packages, changed } = syncPackages(baseline.packages, await installedPackages(paths.root));
	const read = await consumerSurface(target, paths.root, typescript);

	await joinUses(read, baseline, paths.root, rolldown);

	const { consumer, grew } = syncConsumer(joinedBefore(baseline), read, new Set(changed.added));

	baseline.packages = Object.fromEntries(Object.entries(packages).toSorted(([one], [other]) => one.localeCompare(other)));
	baseline.consumer = consumer;
	baseline.join = JOIN;

	if (JSON.stringify(baseline) !== before) {
		await saveBaseline(paths, baseline);
	}

	return { "created": false, "baseline": baseline, "changed": changed, "used": grew };
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
		await write("node_modules/kit/package.json", JSON.stringify({ "name": "kit", "version": "3.0.0", "type": "module", "exports": "./index.js" }));
		await write("node_modules/kit/index.js", "export { save } from \"./save.js\";\nexport { ping } from \"./ping.js\";\n");
		await write("node_modules/kit/save.js", "import { writeFileSync } from \"node:fs\";\nexport const save = (p, d) => writeFileSync(p, d);\n");
		await write("node_modules/kit/ping.js", "export const ping = (u) => fetch(u);\n");
		await write("lib.js", "import { save } from \"kit\";\nsave(\"a\", \"b\");\n");

		// Each package by its own files: tool's exec isn't fetcher's, nor fetcher's net tool's.
		const packages = await installedPackages(root);

		assert.deepEqual(Object.keys(packages), ["@scope/quiet", "fetcher", "kit", "tool"]);
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
		// (read by the TypeScript ≥ 7.1 lib tests with, its dev dependency `typescript-7`)
		const typescript = await typescriptModules(import.meta.dirname, "typescript-7");
		const paths = siloPaths(root);

		await assert.rejects(ensureBaseline(paths), /TypeScript 7\.1 or later/u, "no TypeScript in the project, none passed");

		const first = await ensureBaseline(paths, root, typescript);

		assert.equal(first.created, true);
		assert.ok("tool" in first.baseline.packages);
		// The code's use of its dependencies, read by TypeScript, each package's with its join: app.js uses tool's spawn
		// (one CommonJS object: the whole package), lib.js kit's save — not its ping.
		assert.equal(first.baseline.join, 1);
		assert.deepEqual(first.baseline.consumer, { ".": {
			"kit": { "kind": "package", "version": "3.0.0", "members": ["save"], "dynamic": false, "caps": ["fs:write"] },
			"tool": { "kind": "package", "version": "1.0.0", "members": ["spawn"], "dynamic": false, "caps": ["exec"] }
		} });
		assert.deepEqual(first.baseline.packages["kit"]?.caps, ["fs:write", "net"]);
		fs.writeFileSync(paths.baseline, JSON.stringify({ ...first.baseline, "packages": { "tool": { "version": "0.9.0", "caps": [] } } }));

		const again = await ensureBaseline(paths, root, typescript);

		assert.equal(again.created, false);
		assert.deepEqual(again.changed, { "added": ["@scope/quiet", "fetcher", "kit"], "updated": [], "grew": ["tool"] });
		assert.deepEqual(loadBaseline(paths).packages["tool"], { "version": "1.0.0", "caps": ["exec"], "grew": { "exec": "1.0.0" } });
		assert.deepEqual(again.used, [], "the code's use unchanged: nothing grew there");

		const unchanged = fs.readFileSync(paths.baseline);

		assert.deepEqual((await ensureBaseline(paths, root, typescript)).changed, { "added": [], "updated": [], "grew": [] }, "nothing installed changed: nothing to do");
		assert.equal(fs.readFileSync(paths.baseline), unchanged, "nor written");

		// The code starts using kit's ping: its join grows by net, with ping as what brought it in.
		await write("lib.js", "import { save, ping } from \"kit\";\nsave(\"a\", await ping(\"https://example.com\"));\n");

		const used = await ensureBaseline(paths, root, typescript);

		assert.deepEqual(used.used, [". kit"]);
		assert.deepEqual(used.baseline.consumer["."]["kit"], { "kind": "package", "version": "3.0.0", "members": ["ping", "save"], "dynamic": false, "caps": ["fs:write", "net"], "grew": { "net": "ping" } });

		// A baseline without the join mark (an older one): its consumer is taken as read now — nothing grows from it.
		fs.writeFileSync(paths.baseline, JSON.stringify({ ...loadBaseline(paths), "consumer": { ".": { "kit": { "kind": "package", "version": "3.0.0", "members": ["save"], "dynamic": false, "caps": [] } } }, "join": undefined }));
		assert.deepEqual((await ensureBaseline(paths, root, typescript)).used, []);
		assert.equal(loadBaseline(paths).join, 1);

		await fs.rm(root, { "recursive": true, "force": true });
	})();
}
