import * as path from "node:path";
import * as url from "node:url";
import { isCI, isEntry } from "@brianjenkins94/util/env";

import { exec, fire } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";

/**
 * Cut or promote a GitHub release, in one of two modes — the `util-release` bin picks between them by what it's
 * given (see the run-guard); no config file needed:
 *
 *   • MANIFEST mode (a single-package repo like partner-api-docs / sms-reference-app — run at the repo root
 *     with no workspace globs): the TAG is `vX.Y.Z` and `package.json.version` is the identity + promotion
 *     control — package.json.version > highest published `v*` release → `promote` (publish at that version),
 *     otherwise → `draft` (roll the single accumulating draft at `<published>+1` minor). Optional dated ASSET
 *     syncing (below) is content-aware: an artifact byte-identical to the one already on the release keeps its
 *     name, so a new date is stamped ONLY on a real content change. This is {@link release}.
 *
 *   • CONTENT mode (a monorepo like editor / lib — run with workspace globs, or inside one workspace): the TAG
 *     is `<workspace>@X.Y.Z` (the identity util-publish looks up) and the version rolls whenever the built
 *     artifact CHANGES. {@link releaseWorkspace} keeps one accumulating DRAFT per workspace at the next version
 *     — computed IDENTICALLY to util-publish (bump the minor off the archived `docs/<ws>@latest.tgz`, primed
 *     here from Pages, else `package.json.version` on the first ever release) — and never promotes: util-publish
 *     attaches the freshly-built tarball to that draft only when its bytes differ from `@latest`, and a human
 *     promotes the draft when ready.
 *
 * `gh` is shelled (auth via `GH_TOKEN` in the environment). Consumed as `@brianjenkins94/util/scripts/release`.
 */

export interface Release { "tagName": string; "isDraft": boolean }
interface Asset { "name": string }

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

/** Parse `X.Y.Z` into a `[major, minor, patch]` tuple, or null if it isn't plain semver. */
export function parse(version: string): [number, number, number] | null {
	const match = SEMVER.exec(version);

	return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare two `[major, minor, patch]` tuples: negative if a < b, positive if a > b, 0 if equal. */
export function compare(a: [number, number, number], b: [number, number, number]): number {
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) { return a[index] - b[index]; }
	}

	return 0;
}

/** The whole release control surface: next VERSION + MODE from package.json vs the published releases. */
export function decideVersion(pkgVersion: string, releases: Release[]): { "version": string; "mode": "draft" | "promote" } {
	const published = releases
		.filter((release) => !release.isDraft && release.tagName.startsWith("v"))
		.map((release) => parse(release.tagName.slice(1)))
		.filter((parsed): parsed is [number, number, number] => parsed !== null)
		.sort(compare)
		.at(-1) ?? [0, 0, 0];

	const pkg = parse(pkgVersion) ?? [0, 0, 0];

	if (compare(pkg, published) > 0) {
		return { "version": pkgVersion, "mode": "promote" };
	}

	return { "version": `${published[0]}.${published[1] + 1}.0`, "mode": "draft" };
}

/** Shell `gh` and return stdout; throws if it fails. Auth comes from `GH_TOKEN` in the environment. */
export async function gh(args: string[]): Promise<string> {
	const result = await exec("gh", args);

	if (!result.ok) { throw new Error(`gh ${args.join(" ")} failed: ${result.stderr}`); }

	return result.stdout;
}

/** All releases (draft + published), newest API order, as `{ tagName, isDraft }`. */
export async function listReleases(limit = 200): Promise<Release[]> {
	return JSON.parse(await gh(["release", "list", "--limit", String(limit), "--json", "tagName,isDraft"])) as Release[];
}

/** The tag GitHub marks `isLatest` (newest published, non-draft, non-prerelease), or "" when there is none yet. */
export async function latestRelease(): Promise<string> {
	return (await gh(["release", "list", "--json", "tagName,isLatest", "--jq", "[.[] | select(.isLatest)][0].tagName // empty"])).trim();
}

/** The repo's git top-level, or cwd if not in a git tree (so a stray checkout still degrades sensibly). */
async function gitTopLevel(): Promise<string> {
	const result = await exec("git", ["rev-parse", "--show-toplevel"]);

	return result.ok ? result.stdout.trim() : process.cwd();
}

/** `X.Y.Z` → `X.(Y+1).0`; a non-semver input falls back to `0.1.0` (matching util-publish's floor). */
function bumpMinor(version: string): string {
	const parsed = parse(version);

	return parsed === null ? "0.1.0" : `${parsed[0]}.${parsed[1] + 1}.0`;
}

/**
 * The version last shipped in `docs/<ws>@latest.tgz` (untar just its package.json), or undefined when no
 * such archive exists yet. This is the SAME floor util-publish reads, so the two agree on the next version.
 */
async function archivedVersion(tgz: string): Promise<string | undefined> {
	if (!fs.existsSync(tgz)) { return undefined; }

	const result = await exec("tar", ["-xOzf", tgz, "package/package.json"]);

	if (!result.ok) { return undefined; }

	try {
		return (JSON.parse(result.stdout) as { "version"?: string }).version;
	} catch {
		return undefined;
	}
}

const releaseExists = (tag: string): Promise<boolean> => fire("gh", ["release", "view", tag]);

/** Ensure a DRAFT release exists at `tag`, creating it if missing; NEVER flips an existing (maybe promoted) one. */
async function ensureDraft(tag: string): Promise<void> {
	if (await releaseExists(tag)) { return; }

	await gh(["release", "create", tag, "--draft", "--title", tag, "--notes", `Release ${tag}`]);
}

/**
 * Download the currently-published `docs/<ws>@latest.tgz` from Pages into place, so both this script and
 * util-publish read the SAME version floor (util-publish doesn't fetch it — a prior step must). No-op off CI
 * or when the repo coordinates aren't in the environment; a 404 (nothing published yet) is left as absent.
 */
async function primeArchive(gitRoot: string, workspace: string): Promise<void> {
	const owner = process.env["GITHUB_REPOSITORY_OWNER"];
	const repo = process.env["GITHUB_REPOSITORY"]?.split("/")[1];

	if (owner === undefined || repo === undefined) { return; }

	const response = await fetch(`https://${owner}.github.io/${repo}/${workspace}@latest.tgz`);

	if (!response.ok) { return; }

	const destination = path.join(gitRoot, "docs", `${workspace}@latest.tgz`);
	await fs.mkdir(path.dirname(destination), { "recursive": true });
	await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

/**
 * CONTENT mode for ONE workspace: keep a rolling DRAFT at the next `<workspace>@<version>`, computed exactly
 * as util-publish will (bump the minor off the archived `docs/<ws>@latest.tgz`, else `package.json.version`
 * on the first release). `prime` fetches that archive from Pages first (CI). Never promotes — util-publish
 * attaches the built tarball to the draft on a real content change, and a human promotes it.
 */
export async function releaseWorkspace(workspace: string, options: { "gitRoot"?: string; "prime"?: boolean } = {}): Promise<{ "tag": string; "version": string }> {
	const gitRoot = options.gitRoot ?? await gitTopLevel();

	if (options.prime === true) { await primeArchive(gitRoot, workspace); }

	const archive = await archivedVersion(path.join(gitRoot, "docs", `${workspace}@latest.tgz`));
	const pkgVersion = (JSON.parse(fs.readFileSync(path.join(gitRoot, workspace, "package.json"))) as { "version"?: string }).version;
	const version = archive !== undefined ? bumpMinor(archive) : (pkgVersion ?? "0.1.0");
	const tag = `${workspace}@${version}`;
	console.log(`release ${tag} (draft)`);

	await ensureDraft(tag);

	return { tag, version };
}

/** Create `tag` as a draft, or flip an existing release's draft state to match `mode` (idempotent). */
export async function ensureReleaseTag(tag: string, mode: "draft" | "promote"): Promise<void> {
	if (await releaseExists(tag)) {
		await gh(["release", "edit", tag, `--draft=${String(mode === "draft")}`]);
	} else if (mode === "draft") {
		await gh(["release", "create", tag, "--draft", "--title", tag, "--notes", `Release ${tag}`]);
	} else {
		await gh(["release", "create", tag, "--title", tag, "--notes", `Release ${tag}`]);
	}
}

const sameFile = (a: string, b: string): Promise<boolean> => fire("cmp", ["-s", a, b]);

export interface DatedAsset {
	/** Built artifact to upload. */
	"built": string;
	/** Asset base name (no extension), e.g. `partstech`. */
	"base": string;
	/** Asset extension (no dot), e.g. `yaml`. */
	"ext": string;
}

/**
 * Sync ONE release asset with content-aware date-stamping. A DRAFT keeps the canonical `<base>.<ext>`;
 * a PROMOTE stamps `<base>.<date>.<ext>`. Either way the artifact is re-uploaded ONLY on a real byte
 * change — an unchanged, already-dated published asset keeps its date across re-runs (never re-stamped
 * "just because"). `date` defaults to today (UTC); `tmp` is a scratch dir for downloads/compares.
 */
export async function syncDatedAsset(options: DatedAsset & { "tag": string; "mode": "draft" | "promote"; "date"?: string; "tmp"?: string }): Promise<void> {
	const { built, base, ext, tag, mode } = options;
	const date = options.date ?? new Date().toISOString().slice(0, 10);
	const tmp = options.tmp ?? path.join(process.cwd(), ".release-tmp");
	await fs.mkdir(tmp, { "recursive": true });

	const { assets } = JSON.parse(await gh(["release", "view", tag, "--json", "assets"])) as { "assets": Asset[] };
	const canonical = `${base}.${ext}`;
	const datedPattern = new RegExp(`^${base}\\.[0-9-]+\\.${ext}$`, "u");
	const existingCanonical = assets.find((asset) => asset.name === canonical)?.name;
	const existingDated = assets.find((asset) => datedPattern.test(asset.name))?.name;

	async function upload(name: string): Promise<void> {
		await gh(["release", "upload", tag, path.join(tmp, name), "--clobber"]);
		console.log(`  ${base}: uploaded ${name}`);
	}

	if (mode === "draft") {
		// Drop any stale dated asset (e.g. from a prior always-dated build) and keep the canonical name.
		if (existingDated !== undefined) { await gh(["release", "delete-asset", tag, existingDated, "--yes"]); }

		if (existingCanonical !== undefined) {
			await gh(["release", "download", tag, "--pattern", canonical, "--dir", tmp, "--clobber"]);

			if (await sameFile(built, path.join(tmp, canonical))) {
				console.log(`  ${base}: unchanged — keeping ${canonical}`);

				return;
			}

			await gh(["release", "delete-asset", tag, canonical, "--yes"]);
		}

		await fs.copyFile(built, path.join(tmp, canonical));
		await upload(canonical);

		return;
	}

	// promote: dated name. Drop any leftover canonical asset from the draft phase; keep an unchanged
	// existing dated asset (don't re-date on a re-run); otherwise stamp today.
	if (existingCanonical !== undefined) { await gh(["release", "delete-asset", tag, existingCanonical, "--yes"]); }

	if (existingDated !== undefined) {
		await gh(["release", "download", tag, "--pattern", existingDated, "--dir", tmp, "--clobber"]);

		if (await sameFile(built, path.join(tmp, existingDated))) {
			console.log(`  ${base}: unchanged — keeping ${existingDated}`);

			return;
		}

		await gh(["release", "delete-asset", tag, existingDated, "--yes"]);
	}

	await fs.copyFile(built, path.join(tmp, `${base}.${date}.${ext}`));
	await upload(`${base}.${date}.${ext}`);
}

export interface ReleaseOptions {
	/** package.json path (relative to cwd) whose `version` is the control surface. Default `package.json`
	 *  — e.g. sms-reference-app passes `app/package.json` (the product lives under app/). */
	"versionFrom"?: string;
	/** Optional dated release assets to sync. Paths are relative to cwd. Omit for a tag-only release. */
	"assets"?: DatedAsset[];
}

/**
 * The full flow: read the version, decide draft/promote vs the published releases, ensure the tag, then
 * sync any dated assets. Returns the decided `{ tag, version, mode }`.
 */
export async function release(options: ReleaseOptions = {}): Promise<{ "tag": string; "version": string; "mode": "draft" | "promote" }> {
	const root = process.cwd();
	const pkgVersion = (JSON.parse(fs.readFileSync(path.join(root, options.versionFrom ?? "package.json"))) as { "version"?: string }).version ?? "0.0.0";

	const { version, mode } = decideVersion(pkgVersion, await listReleases());
	const tag = `v${version}`;
	console.log(`release ${tag} (${mode})`);

	await ensureReleaseTag(tag, mode);

	if (options.assets !== undefined && options.assets.length > 0) {
		const tmp = path.join(root, ".release-tmp");
		await fs.rm(tmp, { "recursive": true, "force": true });
		const date = new Date().toISOString().slice(0, 10);

		for (const asset of options.assets) {
			await syncDatedAsset({ ...asset, "built": path.join(root, asset.built), tag, mode, date, tmp });
		}

		await fs.rm(tmp, { "recursive": true, "force": true });
	}

	return { tag, version, mode };
}

// Run directly (the `util-release` bin). Mode by what it's given, no flag:
//   • `--latest`                    → print the latest published `v*` tag (for a workflow to capture).
//   • workspace globs (args, or the WS_GLOBS env — comma/space separated, e.g. `packages/* components/*`),
//     or being run from inside a workspace sub-directory → CONTENT mode: a rolling draft per matching
//     non-private workspace (globs scope to one level, so an app's bundled sub-packages are left out).
//   • otherwise (repo root, no globs) → MANIFEST mode: load `release.config.{ts,js}` if present (default
//     export is ReleaseOptions, or a function returning them), else a tag-only `v<version>` release.
if (isEntry(import.meta) && process.argv.includes("--latest")) {
	console.log(await latestRelease());
} else if (isEntry(import.meta)) {
	const gitRoot = await gitTopLevel();
	const cwdWorkspace = path.relative(gitRoot, process.cwd()).split(path.sep).join("/");
	const globs = [...process.argv.slice(2), process.env["WS_GLOBS"] ?? ""].flatMap((argument) => argument.split(/[,\s]+/u)).filter(Boolean);

	if (cwdWorkspace !== "" && cwdWorkspace !== ".") {
		await releaseWorkspace(cwdWorkspace, { gitRoot, "prime": isCI });
	} else if (globs.length > 0) {
		for (const workspace of await fs.matchWorkspaces(globs, gitRoot)) {
			await releaseWorkspace(workspace.dir, { gitRoot, "prime": isCI });
		}
	} else {
		const configPath = ["release.config.ts", "release.config.js"].map((name) => path.resolve(process.cwd(), name)).find((file) => fs.existsSync(file));
		const config = configPath === undefined ? {} : (await import(url.pathToFileURL(configPath).toString())).default as ReleaseOptions | (() => ReleaseOptions | Promise<ReleaseOptions>);

		await release(typeof config === "function" ? await config() : config);
	}
}
