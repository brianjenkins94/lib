import { isEntry } from "@brianjenkins94/util/env";
import { mapAsync } from "@brianjenkins94/util/array";
import { exec } from "@brianjenkins94/util/exec";
import * as fs from "@brianjenkins94/util/fs";

/**
 * Build every git-tracked workspace by running its own `build` script, in dependency waves:
 * `components/` (leaf deps — vendored/UI packages others consume, some emitting a dist that apps read at
 * build time) build to completion first, then `packages/`, then everything else. Private workspaces build too:
 * `private` means "not published to the registry" (util-publish honours
 * it), NOT "not built" — a private, deployable app (e.g. a Pages workbench) still needs building.
 * Returns a `{ workspace: exitCode }` map.
 */
export async function build(workspaces?: string[]) {
	workspaces ??= (await fs.findWorkspaces()).map((workspace) => workspace.dir);

	// exec auto-shells `pnpm` (a .cmd shim) on Windows and — unlike the old hand-rolled Promise — rejects if
	// pnpm can't be spawned at all, instead of hanging forever.
	//
	// NOT `--ignore-workspace`: in a workspace (incl. an ephemeral CI one) that flag makes pnpm treat the package
	// as standalone, and since its deps reference workspace siblings pnpm then does a FULL reinstall (re-running
	// every preinstall, e.g. a heavy clone) on each call. Plain `pnpm run` executes the script against the
	// existing install — and is a no-op difference for a non-workspace repo, where there's no workspace to ignore.
	async function buildOne(workspace: string): Promise<[string, number]> {
		const result = await exec("pnpm", ["run", "--if-present", "build"], { "cwd": workspace });

		// Surface WHY a build failed. exec captures the output, so without echoing it a failure is just a bare
		// exit code with no diagnostic — which is how a broken build once slipped through as a "green" CI.
		if (!result.ok) {
			process.stderr.write(`\n❌ ${workspace} build failed (exit ${result.exitCode})\n${result.stdout}\n${result.stderr}\n`);
		}

		return [workspace, result.exitCode];
	}

	const prefixOf = (workspace: string) => workspace.split("/")[0];
	const components = workspaces.filter((workspace) => prefixOf(workspace) === "components");
	const packages = workspaces.filter((workspace) => prefixOf(workspace) === "packages");
	const rest = workspaces.filter((workspace) => prefixOf(workspace) !== "components" && prefixOf(workspace) !== "packages");

	// Sequential across waves (a later wave reads earlier waves' built dist), parallel within each wave.
	const componentResults = await mapAsync(components, buildOne);
	const packageResults = await mapAsync(packages, buildOne);
	const restResults = await mapAsync(rest, buildOne);

	return Object.fromEntries([...componentResults, ...packageResults, ...restResults]);
}

if (isEntry(import.meta)) {
	await build();
}
