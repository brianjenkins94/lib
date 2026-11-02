// The setup action's install (action.yml): util/silo/install.ts's rule — nothing published in the last `--min-age`
// minutes, but each version a package.json pins exactly as it is, however young — with the project's package
// manager, from this action's own checkout (nothing is installed yet). What follows `--` goes to the package manager.
//
//   node install.mjs [--manager pnpm|npm] [--min-age <minutes>] [-- <the package manager's flags>]
import { spawnSync } from "node:child_process";
import { installCommand, packageManagerOf, workspacePins } from "../../../util/silo/install.ts";

const args = process.argv.slice(2);
const end = args.includes("--") ? args.indexOf("--") : args.length;

/** The value after `name` among this script's own arguments (before `--`), else `fallback`. */
function option(name, fallback) {
	const at = args.slice(0, end).indexOf(name);

	return at < 0 ? fallback : args[at + 1];
}

const root = process.cwd();
const manager = option("--manager", packageManagerOf(root));
const minutes = Number(option("--min-age", 7 * 24 * 60));

if (manager !== "npm" && manager !== "pnpm") {
	console.error(`install: ${manager} isn't supported — npm or pnpm`);
	process.exit(1);
}

if (!Number.isFinite(minutes) || minutes < 0) {
	console.error(`install: --min-age is minutes: ${option("--min-age")}`);
	process.exit(1);
}

const pins = workspacePins(root);
const command = [...installCommand(manager, [], minutes, pins), ...args.slice(end + 1)];

console.log(pins.length === 0 ? "No version pinned: everything waits its week." : `Pinned, taken however young: ${pins.map(({ name, version }) => `${name}@${version}`).join(", ")}`);
console.log(`${manager} ${command.join(" ")}`);

const installed = spawnSync(manager, command, { "stdio": "inherit", "shell": process.platform === "win32" });

process.exit(installed.status ?? 1);
