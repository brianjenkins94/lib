import { execFileSync, spawnSync } from "node:child_process";
import { gh } from "../../../util/scripts/release";

/**
 * Promote the draft releases the release job created to published, after (re)building + npm-publishing via
 * `pnpm run publish` (replaces publish.sh). Deliberately does NOT stop on a single package's failure: it
 * captures the publish exit, promotes every package that produced a fresh `docs/<pkg>@latest.tgz`, then
 * propagates a build/publish failure at the very END — so a crash turns the run red without blocking the
 * successes (cd.yml keeps upload + deploy on `if: !cancelled()` so those still ship).
 */

const packages = process.argv.slice(2);

// Build + write tarballs + npm-publish. Capture the exit; don't throw yet (promote the successes first).
const publishStatus = spawnSync("pnpm", ["run", "publish"], { "stdio": "inherit" }).status ?? 1;

let successes = 0;

for (const pkg of packages) {
	let version = "";

	try {
		version = (JSON.parse(execFileSync("tar", ["-xOzf", `docs/${pkg}@latest.tgz`, "package/package.json"], { "encoding": "utf8" })).version as string | undefined) ?? "";
	} catch { /* tarball missing / unbuilt */ }

	const tag = `${pkg}@${version}`;

	if (version === "") {
		console.log(`❌ Could not determine TAG_NAME for ${pkg} (docs/${pkg}@latest.tgz missing or has no version)`);

		continue;
	}

	console.log(`📦 Releasing ${tag}`);

	try {
		gh(["release", "view", tag]);
		gh(["release", "edit", tag, "--draft=false"]);
		console.log(`✅ Release ${tag} marked as published`);
		successes += 1;
	} catch {
		console.log(`⚠️  No draft release found for ${tag} — skipping`);
	}
}

if (successes === 0) {
	console.log("❌ No packages were successfully published");
	process.exit(1);
}

if (publishStatus !== 0) {
	console.log(`❌ pnpm run publish reported build/publish failures (exit ${publishStatus})`);
	process.exit(publishStatus);
}
