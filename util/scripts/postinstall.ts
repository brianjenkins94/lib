import { isEntry } from "@brianjenkins94/util/env";
import { mapAsync } from "@brianjenkins94/util/array";
import { exec } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";

// Release-age floor: never install a version published within the last N days (default 7), to dodge the
// window when a freshly-compromised release does the most damage. pnpm has this natively
// (minimumReleaseAge, in minutes); npm only has --before=<date> — which SILENTLY ignores anything that
// isn't a date, so the date is computed here, never a literal.
const MINIMUM_RELEASE_AGE_DAYS = Number(process.env["MINIMUM_RELEASE_AGE_DAYS"]) || 7;
const PNPM_MINIMUM_RELEASE_AGE = String(MINIMUM_RELEASE_AGE_DAYS * 24 * 60);
const NPM_BEFORE = new Date(Date.now() - MINIMUM_RELEASE_AGE_DAYS * 86_400_000).toISOString().split("T")[0];

/**
 * Install every git-tracked workspace (pnpm `--ignore-workspace`, falling back to npm), so each
 * sub-package's own dependencies and install lifecycle run. Used as the repo's `postinstall`. `private`
 * gates PUBLISHING only (util-publish honours it) — it never gates installing: a private, deployable app
 * (e.g. a Pages workbench) still needs its deps installed to build, so private workspaces are installed too.
 */
export async function postinstall(workspaces?: string[]) {
	// In a pnpm workspace the top-level install already installed every member and ran their lifecycle
	// scripts, so there's nothing to do here — and doing it anyway (a per-package `--ignore-workspace`
	// install) would re-fire heavy preinstalls and break the sibling ("*") resolution the workspace provides.
	// A `pnpm-workspace.yaml` with a `packages:` key is the tell (an ephemeral CI one included; a
	// strictDepBuilds-only file has no `packages:`).
	if (fs.existsSync("pnpm-workspace.yaml") && (/^packages:/mu).test(await fs.readFile("pnpm-workspace.yaml"))) {
		return [];
	}

	workspaces ??= (await fs.findWorkspaces()).map((workspace) => workspace.dir);

	// exec auto-shells pnpm/npm (.cmd shims) on Windows; the pnpm→npm fallback is just "try pnpm, else npm".
	return mapAsync(workspaces, async function(workspace: string) {
		const pnpm = await exec("pnpm", ["--ignore-workspace", "install", "--config.minimumReleaseAge=" + PNPM_MINIMUM_RELEASE_AGE], { "cwd": workspace });

		if (pnpm.ok) { return pnpm.exitCode; }

		// FROM: https://github.com/vercel/turborepo/blob/1ae620cdf454d0258a162a96976e3064433391a2/packages/turbo/bin/turbo#L29
		return (await exec("npm", ["install", "--before=" + NPM_BEFORE, "--loglevel=error", "--prefer-offline", "--no-audit", "--progress=false"], { "cwd": workspace })).exitCode;
	});
}

if (isEntry(import.meta)) {
	await postinstall();
}
