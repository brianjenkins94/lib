import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Smoke-test each freshly-published package against its LIVE GitHub Pages tarball: install it into a throwaway
 * directory, then import every non-"." export to prove the published entrypoints resolve and load.
 *
 * Install with pnpm, not npm: pnpm is what consumers actually use, its auto-install-peers pulls the optional
 * peers an export might load, and npm's arborist crashes ("Cannot read properties of null (reading 'matches')")
 * on the URL tarball under the runner's bundled npm. An isolated temp dir (not the repo checkout, which is a
 * pnpm workspace) keeps the install standalone; minimumReleaseAge=0 so the just-published tarball isn't held
 * back by the supply-chain cooldown.
 */

const packages = process.argv.slice(2);
const owner = process.env["GITHUB_REPOSITORY_OWNER"];
const repo = (process.env["GITHUB_REPOSITORY"] ?? "").split("/").slice(1).join("/");

for (const pkg of packages) {
	const scoped = `@${owner}/${pkg}`;
	const url = `https://${owner}.github.io/${repo}/${pkg}@latest.tgz`;

	const directory = mkdtempSync(path.join(tmpdir(), `smoke-${pkg.replace(/[\\/]/gu, "-")}-`));

	writeFileSync(path.join(directory, "package.json"), JSON.stringify({ "name": "smoke", "version": "0.0.0", "private": true }));
	execFileSync("pnpm", ["add", "--ignore-workspace", "--config.minimumReleaseAge=0", url], { "cwd": directory, "stdio": "inherit" });

	const exportsMap = JSON.parse(readFileSync(path.join(directory, "node_modules", scoped, "package.json"), "utf8"))["exports"] as Record<string, unknown>;
	const specifiers = Object.keys(exportsMap).filter((key) => key !== ".").map((key) => scoped + key.slice(1));

	// cwd = the install dir, so the bare specifiers resolve against its node_modules.
	for (const specifier of specifiers) {
		console.log("> import", specifier);
		execFileSync("node", ["--input-type=module", "--eval", `import ${JSON.stringify(specifier)};`], { "cwd": directory, "stdio": "inherit" });
	}
}
