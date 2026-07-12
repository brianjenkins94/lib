import { spawn } from "node:child_process";
import * as url from "node:url";
import { mapAsync } from "../array";
import { findWorkspaces, realpath } from "../fs";

// Release-age floor: never install a version published within the last N days (default 7), to dodge the
// window when a freshly-compromised release does the most damage. pnpm has this natively
// (minimumReleaseAge, in minutes); npm only has --before=<date> — which SILENTLY ignores anything that
// isn't a date, so the date is computed here, never a literal.
const MINIMUM_RELEASE_AGE_DAYS = Number(process.env["MINIMUM_RELEASE_AGE_DAYS"]) || 7;
const PNPM_MINIMUM_RELEASE_AGE = String(MINIMUM_RELEASE_AGE_DAYS * 24 * 60);
const NPM_BEFORE = new Date(Date.now() - MINIMUM_RELEASE_AGE_DAYS * 86_400_000).toISOString().split("T")[0];

/**
 * Install every git-tracked workspace (pnpm `--ignore-workspace`, falling back to npm), so each
 * sub-package's own dependencies and install lifecycle run. Used as the repo's `postinstall`. Private
 * workspaces are skipped — they self-install (see `findWorkspaces()`).
 */
export async function postinstall(workspaces?: string[]) {
	workspaces ??= (await findWorkspaces()).filter((workspace) => !workspace.private).map((workspace) => workspace.dir);

	return mapAsync(workspaces, function(workspace) {
		return new Promise(function(resolve, reject) {
			const subprocess = spawn("pnpm", ["--ignore-workspace", "install", "--config.minimumReleaseAge=" + PNPM_MINIMUM_RELEASE_AGE], {
				"cwd": workspace,
				"shell": true
				//"stdio": "inherit"
			});

			subprocess.on("close", function(code) {
				if (code !== 0) {
					// FROM: https://github.com/vercel/turborepo/blob/1ae620cdf454d0258a162a96976e3064433391a2/packages/turbo/bin/turbo#L29
					const subprocess = spawn("npm", ["install", "--before=" + NPM_BEFORE, "--loglevel=error", "--prefer-offline", "--no-audit", "--progress=false"], {
						"cwd": workspace,
						"shell": true
						//"stdio": "inherit"
					});

					subprocess.on("close", function(code) {
						resolve(code);
					});
				} else {
					resolve(code);
				}
			});
		});
	});
}

if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(await realpath(process.argv[1])).toString()) {
	await postinstall();
}
