/**
 * silo install's rule — an install that takes nothing published in the last week, except a version asked for by name.
 * `latest`, a range or a tag resolves to the newest version at least `days` old, as npm's `--before` and pnpm's
 * `minimumReleaseAge` do, and so does every dependency they bring in; a dependency a package.json (any of a workspace's)
 * gives an exact version (`"1.2.3"`), or one asked for as `name@1.2.3`, is that version however young — said in so many
 * words, it's taken as said. Its own dependencies still wait their week.
 *
 * The exception is the package manager's own: pnpm's `minimumReleaseAgeExclude`, by name and version; npm's
 * `min-release-age-exclude`, by name only (npm 11.17+; an older npm gates the pin as it gates the rest) — so with npm,
 * a pinned package's other versions elsewhere in the tree aren't held back either.
 *
 * Only Node's own modules, so lib's setup action runs it from its checkout before anything is installed
 * (.github/actions/setup/install.mjs); silo's command line (`silo install`) runs it too, then syncs the baseline.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

/** A package at the exact version something asked for. */
export interface Pin { "name": string; "version": string }

const EXACT = /^=?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/u;

/** `spec` (a package.json's, for `name`) as an exact version from the registry — `1.2.3`, `=1.2.3`, an `npm:` alias's
 *  `npm:real@1.2.3` (the real package's) — or undefined: a range, a tag, `latest`, a URL, a path, git. */
export function exactPin(name: string, spec: string): Pin | undefined {
	const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/u.exec(spec.trim());
	const [real, wanted] = alias === null ? [name, spec.trim()] : [alias[1], alias[2]];
	const version = EXACT.exec(wanted)?.[1];

	return version === undefined ? undefined : { "name": real, "version": version };
}

/** What a manifest pins: its dependencies, devDependencies and optionalDependencies given an exact version (not its
 *  peers — whoever installs it decides those). */
export function pinsOf(manifest: Record<string, unknown>): Pin[] {
	const pins: Pin[] = [];

	for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
		for (const [name, spec] of Object.entries((manifest[field] ?? {}) as Record<string, unknown>)) {
			const pin = typeof spec === "string" ? exactPin(name, spec) : undefined;

			if (pin !== undefined) {
				pins.push(pin);
			}
		}
	}

	return pins;
}

/** A package asked for on the command line (`name`, `name@range`, `name@1.2.3`, `@scope/name@1.2.3`) as a pin, when it
 *  names an exact version. */
export function pinOfRequest(request: string): Pin | undefined {
	const at = request.lastIndexOf("@");

	return at <= 0 ? undefined : exactPin(request.slice(0, at), request.slice(at + 1));
}

/** The folders `pattern` (a workspace's `packages/*`, `apps/**`, `components/editor`) names under `root`. */
function expand(root: string, pattern: string): string[] {
	let found = [root];

	for (const segment of pattern.replace(/^\.\//u, "").replace(/\/+$/u, "").split("/")) {
		const next: string[] = [];

		for (const directory of found) {
			if (segment === "**") {
				const walk = (at: string): void => {
					next.push(at);

					for (const entry of readdirSync(at, { "withFileTypes": true })) {
						if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
							walk(path.join(at, entry.name));
						}
					}
				};

				walk(directory);
			} else if (segment.includes("*")) {
				const matches = new RegExp(`^${segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*")}$`, "u");

				for (const entry of existsSync(directory) ? readdirSync(directory, { "withFileTypes": true }) : []) {
					if (entry.isDirectory() && entry.name !== "node_modules" && matches.test(entry.name)) {
						next.push(path.join(directory, entry.name));
					}
				}
			} else {
				next.push(path.join(directory, segment));
			}
		}

		found = next;
	}

	return found;
}

/** The workspace's package patterns: pnpm-workspace.yaml's `packages`, else package.json's `workspaces` (none: the
 *  project alone). `!` patterns leave folders out. */
function workspacePatterns(root: string, manifest: Record<string, unknown>): string[] {
	const yaml = path.join(root, "pnpm-workspace.yaml");

	if (existsSync(yaml)) {
		const patterns: string[] = [];
		let inPackages = false;

		for (const line of readFileSync(yaml, "utf8").split(/\r?\n/u)) {
			if (/^\S/u.test(line)) {
				inPackages = /^packages\s*:/u.test(line);
			} else if (inPackages) {
				// (an item: `- packages/*`, quoted or not, a comment after it)
				const item = line.replace(/#.*$/u, "").trim();

				if (item.startsWith("-")) {
					patterns.push(item.slice(1).trim().replace(/^["']|["']$/gu, ""));
				}
			}
		}

		return patterns;
	}

	const { workspaces } = manifest;

	return Array.isArray(workspaces) ? workspaces as string[] : (workspaces as { "packages"?: string[] } | undefined)?.packages ?? [];
}

/** Every pin in the project at `root` and its workspace's packages: each name@version once. */
export function workspacePins(root: string): Pin[] {
	const read = (directory: string): Record<string, unknown> | undefined => {
		const file = path.join(directory, "package.json");

		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : undefined;
	};

	const manifest = read(root) ?? {};
	const patterns = workspacePatterns(root, manifest);
	const excluded = new Set(patterns.filter((pattern) => pattern.startsWith("!")).flatMap((pattern) => expand(root, pattern.slice(1))));
	const folders = [root, ...patterns.filter((pattern) => !pattern.startsWith("!")).flatMap((pattern) => expand(root, pattern))].filter((folder) => !excluded.has(folder));
	const pins = new Map<string, Pin>();

	for (const folder of new Set(folders)) {
		for (const pin of pinsOf(read(folder) ?? {})) {
			pins.set(`${pin.name}@${pin.version}`, pin);
		}
	}

	return [...pins.values()].toSorted((one, other) => `${one.name}@${one.version}`.localeCompare(`${other.name}@${other.version}`));
}

/** How a project installs, by its lockfile: npm's first (a project installed with npm here and pnpm in CI has both),
 *  then pnpm's, then yarn's; npm with none. */
export function packageManagerOf(root: string): "npm" | "pnpm" | "yarn" {
	if (existsSync(path.join(root, "package-lock.json"))) {
		return "npm";
	}

	if (existsSync(path.join(root, "pnpm-lock.yaml"))) {
		return "pnpm";
	}

	return existsSync(path.join(root, "yarn.lock")) ? "yarn" : "npm";
}

/**
 * `manager`'s arguments to install `packages` (none: the project's own) taking no version published in the last
 * `minutes`, but each of `pins` at its version: pnpm's `minimum-release-age` (minutes) and an exclusion per pin; npm's
 * `--before` (a tag past the date falls back to the latest version at or before it) and an exclusion per pinned name.
 */
export function installCommand(manager: "npm" | "pnpm", packages: string[], minutes: number, pins: Pin[], now = Date.now()): string[] {
	if (manager === "pnpm") {
		return [packages.length === 0 ? "install" : "add", ...packages, `--config.minimum-release-age=${Math.round(minutes)}`, ...pins.map(({ name, version }) => `--config.minimum-release-age-exclude=${name}@${version}`)];
	}

	return ["install", ...packages, `--before=${new Date(now - minutes * 60 * 1000).toISOString()}`, ...[...new Set(pins.map(({ name }) => name))].map((name) => `--min-release-age-exclude=${name}`)];
}

if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
	void (async function() {
		const assert = (await import("node:assert")).strict;
		const fs = await import("node:fs");
		const os = await import("node:os");

		// Exact versions are pins; ranges, tags, latest, URLs and paths aren't.
		assert.deepEqual(exactPin("a", "1.2.3"), { "name": "a", "version": "1.2.3" });
		assert.deepEqual(exactPin("a", "=1.2.3-beta.1"), { "name": "a", "version": "1.2.3-beta.1" });
		assert.deepEqual(exactPin("alias", "npm:@scope/real@2.0.0"), { "name": "@scope/real", "version": "2.0.0" });

		for (const spec of ["^1.2.3", "~1.2.3", "1.x", ">=1.2.3", "latest", "next", "*", "", "file:../x", "https://x/y.tgz", "github:a/b", "npm:real@^2"]) {
			assert.equal(exactPin("a", spec), undefined, spec);
		}

		assert.deepEqual(pinOfRequest("@scope/name@1.0.0"), { "name": "@scope/name", "version": "1.0.0" });
		assert.equal(pinOfRequest("@scope/name"), undefined);
		assert.equal(pinOfRequest("name@latest"), undefined);

		// A workspace's pins, from every package of it — not peers, and not a folder its patterns leave out.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "silo-install-"));
		const write = (file: string, json: unknown): void => {
			fs.mkdirSync(path.dirname(path.join(root, file)), { "recursive": true });
			fs.writeFileSync(path.join(root, file), JSON.stringify(json));
		};

		write("package.json", { "devDependencies": { "typescript": "7.1.0-beta", "tsx": "^4.0.0" } });
		fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - \"contrib\"\n  - '!packages/old'\nlinkWorkspacePackages: true\n");
		write("packages/a/package.json", { "dependencies": { "rolldown": "1.2.13", "vite": "latest" }, "peerDependencies": { "react": "18.3.1" } });
		write("packages/old/package.json", { "dependencies": { "left-pad": "1.0.0" } });
		write("contrib/package.json", { "optionalDependencies": { "fsevents": "2.3.3" }, "dependencies": { "rolldown": "1.2.13" } });

		assert.deepEqual(workspacePins(root), [{ "name": "fsevents", "version": "2.3.3" }, { "name": "rolldown", "version": "1.2.13" }, { "name": "typescript", "version": "7.1.0-beta" }]);
		fs.rmSync(root, { "recursive": true, "force": true });

		// The managers' arguments: the age as each takes it, an exclusion per pin (npm's by name, once).
		const pins = [{ "name": "rolldown", "version": "1.2.13" }, { "name": "rolldown", "version": "1.2.14" }];

		assert.deepEqual(installCommand("pnpm", [], 10080, pins), ["install", "--config.minimum-release-age=10080", "--config.minimum-release-age-exclude=rolldown@1.2.13", "--config.minimum-release-age-exclude=rolldown@1.2.14"]);
		assert.deepEqual(installCommand("pnpm", ["zod@4.1.0"], 10080, []), ["add", "zod@4.1.0", "--config.minimum-release-age=10080"]);
		assert.deepEqual(installCommand("npm", [], 7 * 24 * 60, pins, Date.parse("2026-11-08T00:00:00Z")), ["install", "--before=2026-11-01T00:00:00.000Z", "--min-release-age-exclude=rolldown"]);

		console.log("install: ok");
	})();
}
