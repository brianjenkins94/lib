import * as path from "node:path";
import * as url from "node:url";
import { isEntry } from "@brianjenkins94/util/env";

import { exec, fire } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";

/**
 * Cut or promote GitHub releases — one model for every repo, single-package or monorepo:
 *
 *   • Each released package is its own SERIES: the repo root is tagged `vX.Y.Z`, any other workspace
 *     `<workspace>@X.Y.Z`. Its `package.json.version` is the promotion control ({@link decideVersion}): above the
 *     series' highest published release → `promote` (publish at that version); otherwise → `draft`, the ONE
 *     accumulating draft at `<published>+1` minor, which holds still until a human bumps the version.
 *   • The release is carried out AFTER the build ({@link syncRelease}): ensure the draft, sync its dated ASSETS
 *     (content-aware — a byte-identical artifact keeps its name, so a new date is stamped ONLY on a real change),
 *     and publish a promote last, so a release never goes out without its assets.
 *
 * A repo that builds its own artifacts runs the `util-release` bin (with a `release.config.{ts,js}`), or calls
 * {@link decide} + {@link syncRelease}, after building them — partner-api-docs, sms-reference-app. A monorepo's
 * workspaces are released by util-publish, which builds each tarball and syncs it the same way.
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

/**
 * The whole release control surface: next VERSION + MODE from package.json vs the published releases whose tag
 * is `<prefix><version>` — `v` for a single-package repo, `<workspace>@` for one workspace of a monorepo.
 */
export function decideVersion(pkgVersion: string, releases: Release[], prefix = "v"): { "version": string; "mode": "draft" | "promote" } {
	const published = releases
		.filter((release) => !release.isDraft && release.tagName.startsWith(prefix))
		.map((release) => parse(release.tagName.slice(prefix.length)))
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
	/** The package being released, relative to `root`. Default `.` — the repo root, tagged `vX.Y.Z`; any other
	 *  workspace is its own series, tagged `<workspace>@X.Y.Z`. */
	"workspace"?: string;
	/** package.json path (relative to `root`) whose `version` is the control surface. Default
	 *  `<workspace>/package.json` — e.g. sms-reference-app passes `app/package.json` (the product lives under app/). */
	"versionFrom"?: string;
	/** Optional dated release assets for the bin to sync. Paths are relative to `root`. Omit for a tag-only release. */
	"assets"?: DatedAsset[];
	/** The directory the paths above resolve against. Default cwd. */
	"root"?: string;
}

/** One run's release: the tag + version it releases at, and whether it stays a draft or publishes. */
export interface Decision {
	"tag": string;
	"version": string;
	"mode": "draft" | "promote";
	/** The series' tag prefix — `v`, or `<workspace>@`. */
	"prefix": string;
	/** Every release in the repo, as listed when deciding. */
	"releases": Release[];
}

/** The series' highest PUBLISHED release tag as of `decision` (before its own promote), or undefined before any. */
export function latestPublished(decision: Decision): string | undefined {
	const published = decision.releases
		.filter((release) => !release.isDraft && release.tagName.startsWith(decision.prefix) && parse(release.tagName.slice(decision.prefix.length)) !== null)
		.sort((left, right) => compare(parse(left.tagName.slice(decision.prefix.length)) ?? [0, 0, 0], parse(right.tagName.slice(decision.prefix.length)) ?? [0, 0, 0]));

	return published.at(-1)?.tagName;
}

/** The tag prefix of `workspace`'s release series: `v` for the repo root, `<workspace>@` for any other. */
export function tagPrefix(workspace: string): string {
	return workspace === "." ? "v" : `${workspace}@`;
}

/** Decide this run's release for one package: {@link decideVersion} over its own series. */
export async function decide(options: ReleaseOptions = {}): Promise<Decision> {
	const root = options.root ?? process.cwd();
	const workspace = options.workspace ?? ".";
	const pkgVersion = (JSON.parse(fs.readFileSync(path.join(root, options.versionFrom ?? path.join(workspace, "package.json")))) as { "version"?: string }).version ?? "0.0.0";
	const prefix = tagPrefix(workspace);
	const releases = await listReleases(1000);
	const { version, mode } = decideVersion(pkgVersion, releases, prefix);

	return { "tag": prefix + version, "version": version, "mode": mode, "prefix": prefix, "releases": releases };
}

/**
 * Carry out a {@link decide}d release, AFTER the build: ensure the draft exists at its tag, delete leftover
 * drafts of the series BELOW it (a skipped version bump strands one; a draft above it is someone's plan, and
 * is kept), sync the dated `assets` (absolute `built` paths) onto it, and — on a promote — publish it last.
 */
export async function syncRelease(decision: Decision, assets: DatedAsset[] = []): Promise<void> {
	const { tag, mode, prefix, releases } = decision;
	const current = parse(decision.version) ?? [0, 0, 0];
	console.log(`release ${tag} (${mode})`);

	if (!releases.some((release) => release.tagName === tag)) {
		await gh(["release", "create", tag, "--draft", "--title", tag, "--notes", `Release ${tag}`]);
	}

	// A stale draft is one of THIS series (so not e.g. a `vscode@…` tag under the root's `v` prefix) below the
	// current one.
	const isStale = (release: Release): boolean => {
		const version = release.isDraft && release.tagName.startsWith(prefix) ? parse(release.tagName.slice(prefix.length)) : null;

		return version !== null && compare(version, current) < 0;
	};

	for (const stale of releases.filter(isStale)) {
		await gh(["release", "delete", stale.tagName, "--yes"]);
		console.log(`  deleted stale draft ${stale.tagName}`);
	}

	if (assets.length > 0) {
		const tmp = await fs.mkdtemp(path.join(fs.tmpdir(), "util-release-"));
		const date = new Date().toISOString().slice(0, 10);

		try {
			for (const asset of assets) {
				await syncDatedAsset({ ...asset, "tag": tag, "mode": mode, "date": date, "tmp": tmp });
			}
		} finally {
			await fs.rm(tmp, { "recursive": true, "force": true });
		}
	}

	if (mode === "promote") {
		await gh(["release", "edit", tag, "--draft=false"]);
		console.log(`  published ${tag}`);
	}
}

// Run directly (the `util-release` bin): `--latest` prints the latest published release tag (for a workflow to
// capture); otherwise release the repo root per `release.config.{ts,js}` if present (default export is
// ReleaseOptions, or a function returning them), else a tag-only `v<version>` release. A monorepo's workspaces
// are released by util-publish, which builds their tarballs.
if (isEntry(import.meta) && process.argv.includes("--latest")) {
	console.log(await latestRelease());
} else if (isEntry(import.meta)) {
	const configPath = ["release.config.ts", "release.config.js"].map((name) => path.resolve(process.cwd(), name)).find((file) => fs.existsSync(file));
	const loaded = configPath === undefined ? {} : (await import(url.pathToFileURL(configPath).toString())).default as ReleaseOptions | (() => ReleaseOptions | Promise<ReleaseOptions>);
	const config = typeof loaded === "function" ? await loaded() : loaded;
	const root = config.root ?? process.cwd();

	await syncRelease(await decide(config), (config.assets ?? []).map((asset) => ({ ...asset, "built": path.join(root, asset.built) })));
}
