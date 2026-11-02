import { isEntry } from "@brianjenkins94/util/env";
import { mapAsync } from "@brianjenkins94/util/array";
import { exec } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";
import { installCommand, workspacePins } from "@brianjenkins94/util/silo/install";

// Release-age floor: never install a version published within the last N days (default 7), to dodge the
// window when a freshly-compromised release does the most damage — but a version a workspace's package.json
// pins exactly, however young (silo install's rule, util/silo/install: pnpm's minimumReleaseAge, npm's --before).
const MINIMUM_RELEASE_AGE_MINUTES = (Number(process.env["MINIMUM_RELEASE_AGE_DAYS"]) || 7) * 24 * 60;

/**
 * Install every git-tracked workspace (npm, falling back to pnpm `--ignore-workspace`), so each
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

	// npm first: it SYMLINKS a `file:` sibling (install-links=false, passed so no user config flips it), so an edit
	// to a sibling reaches its dependents at once — pnpm, installing one package on its own, copies it into its
	// store, where it goes stale until the next install. exec auto-shells npm/pnpm (.cmd shims) on Windows; the
	// fallback is just "try npm, else pnpm".
	return mapAsync(workspaces, async function(workspace: string) {
		const pins = workspacePins(workspace);
		// FROM: https://github.com/vercel/turborepo/blob/1ae620cdf454d0258a162a96976e3064433391a2/packages/turbo/bin/turbo#L29
		// (not its --prefer-offline: npm then trusts its cache unrevalidated — a stale packument fails --before on a
		// version it hasn't heard of (ETARGET), and a mutable `@latest.tgz` URL installs whatever it cached last)
		const npm = await exec("npm", [...installCommand("npm", [], MINIMUM_RELEASE_AGE_MINUTES, pins), "--install-links=false", "--loglevel=error", "--no-audit", "--progress=false"], { "cwd": workspace });

		if (npm.ok) {
			return npm.exitCode;
		}

		return (await exec("pnpm", ["--ignore-workspace", ...installCommand("pnpm", [], MINIMUM_RELEASE_AGE_MINUTES, pins)], { "cwd": workspace })).exitCode;
	});
}

if (isEntry(import.meta)) {
	await postinstall();
}
