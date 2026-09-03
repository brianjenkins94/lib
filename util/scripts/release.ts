import * as path from "node:path";
import * as url from "node:url";
import { isEntry } from "@brianjenkins94/util/env";

import { exec, fire } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";

/**
 * Cut or promote a semver GitHub release from `package.json.version`, the way partner-api-docs and
 * sms-reference-app both do it (this replaces their duplicated `release.ts`). The TAG (`vX.Y.Z`) is
 * the identity + promotion control:
 *   package.json.version > highest published release → `promote` (publish at that version)
 *   otherwise → `draft` (roll the single accumulating draft at `<published>+1` minor)
 * `gh` is shelled (auth via `GH_TOKEN` in the environment). Optional dated ASSET syncing (below) is
 * deterministic-content aware: an artifact byte-identical to the one already on the release keeps its
 * name, so a new date is stamped ONLY on a real content change. Consumed as
 * `@brianjenkins94/util/scripts/release`, or run as the `util-release` bin (see the run-guard).
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

const releaseExists = (tag: string): Promise<boolean> => fire("gh", ["release", "view", tag]);

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

// Run directly (the `util-release` bin): `--latest` prints the latest published tag (for a workflow to
// capture); otherwise load `release.config.{ts,js}` from cwd if present (its default export is
// ReleaseOptions, or a function returning them), else run tag-only against `package.json`.
if (isEntry(import.meta) && process.argv.includes("--latest")) {
	console.log(await latestRelease());
} else if (isEntry(import.meta)) {
	const configPath = ["release.config.ts", "release.config.js"].map((name) => path.resolve(process.cwd(), name)).find((file) => fs.existsSync(file));
	const config = configPath === undefined ? {} : (await import(url.pathToFileURL(configPath).toString())).default as ReleaseOptions | (() => ReleaseOptions | Promise<ReleaseOptions>);

	await release(typeof config === "function" ? await config() : config);
}
