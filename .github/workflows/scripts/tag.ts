import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { compare, gh, parse } from "../../../util/scripts/release";

/**
 * Compute the next release tag `<package>@<version>` for one package in the CD matrix (replaces tag.sh).
 * Version resolution: the package.json version if set, else the version in the archived
 * `docs/<pkg>@latest.tgz`; jumped up to the highest existing release tag if that's higher; then a minor
 * bump if there was no explicit package.json change, and again if that exact tag is already PUBLISHED
 * (collision-avoidance). Emits ONLY `<package>@<version>` to stdout — the workflow captures it.
 */

const pkg = process.argv[2];

function incrementMinor(version: string): string {
	const [major, minor] = parse(version) ?? [0, 0, 0];

	return `${major}.${minor + 1}.0`;
}

// The version last shipped in the archived tarball (the floor); 0.0.0 if none.
let archiveVersion = "0.0.0";

if (existsSync(`docs/${pkg}@latest.tgz`)) {
	try {
		archiveVersion = (JSON.parse(execFileSync("tar", ["-xOzf", `docs/${pkg}@latest.tgz`, "package/package.json"], { "encoding": "utf8" })).version as string | undefined) ?? "0.0.0";
	} catch { /* keep 0.0.0 */ }
}

// package.json's version wins if set, else the archive version.
let version = (JSON.parse(readFileSync(`${pkg}/package.json`, "utf8")).version as string | undefined) || archiveVersion;

// If the highest existing release tag for this package is higher, jump to it.
const highest = (JSON.parse(gh(["release", "list", "--limit", "100", "--json", "tagName"])) as Array<{ "tagName": string }>)
	.filter((release) => release.tagName.startsWith(`${pkg}@`))
	.map((release) => parse(release.tagName.slice(`${pkg}@`.length)))
	.filter((parsed): parsed is [number, number, number] => parsed !== null)
	.sort(compare)
	.at(-1);

if (highest !== undefined && compare(highest, parse(version) ?? [0, 0, 0]) > 0) {
	version = highest.join(".");
}

// No explicit package.json bump beyond the archive → auto-increment minor.
if (version === archiveVersion) {
	version = incrementMinor(version);
}

// That exact version is already published (not a draft) → increment again to dodge the collision.
let isDraft = "";

try {
	isDraft = gh(["release", "view", `${pkg}@${version}`, "--json", "isDraft", "--jq", ".isDraft"]).trim();
} catch { /* no such release */ }

if (isDraft === "false") {
	version = incrementMinor(version);
}

console.log(`${pkg}@${version}`);
