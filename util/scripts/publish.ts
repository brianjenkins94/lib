import * as os from "node:os";
import * as path from "node:path";
import { log } from "@brianjenkins94/util/logger";
import { exec } from "@brianjenkins94/util/exec";
import { createGunzip, createGzip } from "node:zlib";
import { isCI } from "@brianjenkins94/util/env";
import { HelpRequested, juvy } from "@brianjenkins94/util/juvy";
import * as fs from "@brianjenkins94/util/fs";
import { pascalCaseToKebabCase } from "@brianjenkins94/util/text";
import tarStream from "tar-stream";
import * as vite from "vite";
import { build } from "./build";

// util-publish runs in whatever repo invokes it (silo, lib, …) — the root is the cwd, not util's dir.
const __root = process.cwd();

const distDirectory = path.join(__root, "docs");

// util-publish's inputs, resolved ONCE up front and read from `config` below: the `[workspaces...]` positional
// plus the two values that used to be plucked from `process.env` unchecked. `owner` has no default on purpose —
// the published name is `@<owner>/<pkg>`, and a missing var silently shipped `@undefined/util`. CI gets
// GITHUB_REPOSITORY_OWNER from Actions; a local run must set it (`GITHUB_REPOSITORY_OWNER=brianjenkins94`).
const config = juvy({
	"workspaces": { "format": Array, "default": [], "positional": "rest", "env": false, "doc": "Workspaces to build + publish (default: every git-tracked publishable workspace)." },
	"owner": { "format": String, "required": true, "env": "GITHUB_REPOSITORY_OWNER", "doc": "Scope of the published name, `@<owner>/<pkg>` ($GITHUB_REPOSITORY_OWNER — locally, e.g. GITHUB_REPOSITORY_OWNER=brianjenkins94)." },
	"npmToken": { "format": String, "default": "", "env": "NPM_TOKEN", "sensitive": true, "doc": "npm publish token ($NPM_TOKEN); empty → GitHub-Pages tarball only, no npm publish." }
});

try {
	await config.parse();
	config.validate();
} catch (error) {
	if (error instanceof HelpRequested) {
		process.stdout.write(error.message + "\n");
		process.exit(0);
	}

	// Bad or missing inputs abort BEFORE any build runs. A hard exit is safe here — nothing is in flight yet;
	// the `exitCode`-only rule at the bottom exists because tarball streams are.
	process.stderr.write((error instanceof Error ? error.message : String(error)) + "\nRun with --help for the inputs.\n");
	process.exit(1);
}

const owner: string = config.get("owner");
const npmToken: string = config.get("npmToken");

/**
 * Collect a pre-built package's shipped files (the directories in its package.json `files`),
 * reading each as a Buffer (binary-safe — monaco-vscode-api ships wasm/fonts) and skipping
 * sourcemaps. Used for components that build their own self-contained dist rather than being
 * built from source here. Keys are workspace-relative POSIX paths.
 */
async function collectBuiltFiles(workspaceRoot: string, patterns: string[]): Promise<Record<string, Buffer>> {
	const result: Record<string, Buffer> = {};

	for (const pattern of patterns) {
		for await (const entry of fs.glob(path.join(workspaceRoot, pattern, "**", "*"), { "exclude": ["**/*.map"], "withFileTypes": true })) {
			if (entry.isFile()) {
				const absolute = path.join(entry.parentPath, entry.name);

				result[path.relative(workspaceRoot, absolute).replace(/\\/gu, "/")] = await fs.readFile(absolute, { "encoding": null });
			}
		}
	}

	return result;
}

/**
 * Emit `.d.ts` for a source package so the tarball ships type declarations alongside the esbuild-transpiled
 * `.js` (which carries none). Runs `tsc --emitDeclarationOnly` into a temp dir via a throwaway tsconfig that
 * extends the repo's — inheriting `paths`, `lib`, `target` — then returns the declarations keyed
 * workspace-relative POSIX (`fs.d.ts`, `discovery/cassette.d.ts`) to fold into the file map. Type errors
 * don't block emit (tsc is best-effort). Alias imports like `@brianjenkins94/util/logger` survive verbatim:
 * in the published `@brianjenkins94/util` package they resolve as self-referential subpath imports, so no
 * rewriting is needed. `nestedDirs` (repo-relative) are excluded so a parent never ships a child's types.
 */
async function emitDeclarations(workspace: string, nestedDirs: string[]): Promise<Record<string, Buffer>> {
	const slug = workspace.replace(/[\\/]/gu, "-").replace(/^\.$/u, "root");
	const outDir = path.join(os.tmpdir(), `dts-${slug}-${process.pid}`);
	const configPath = path.join(__root, `.tsconfig.dts.${slug}.json`);

	await fs.writeFile(configPath, JSON.stringify({
		"extends": "./tsconfig.json",
		"compilerOptions": { "noEmit": false, "declaration": true, "emitDeclarationOnly": true, "skipLibCheck": true, "outDir": outDir, "rootDir": path.join(__root, workspace) },
		"include": [path.join(workspace, "**", "*.ts").replace(/\\/gu, "/")],
		"exclude": ["node_modules", "**/node_modules", ...nestedDirs.map((dir) => dir + "/**")]
	}));

	try {
		// tsc exits non-zero on type errors but still emits declarations — best-effort, so ignore both the exit
		// code and a spawn failure. exec auto-shells `npx` (a .cmd shim) on Windows.
		await exec("npx", ["tsc", "-p", configPath], { "cwd": __root }).catch(() => {});

		const declarations: Record<string, Buffer> = {};

		for await (const entry of fs.glob(path.join(outDir, "**", "*.d.ts"), { "withFileTypes": true })) {
			if (!entry.isFile()) { continue; }

			const absolute = path.join(entry.parentPath, entry.name);

			declarations[path.relative(outDir, absolute).replace(/\\/gu, "/")] = await fs.readFile(absolute, { "encoding": null });
		}

		return declarations;
	} finally {
		await fs.rm(outDir, { "recursive": true, "force": true });
		await fs.rm(configPath, { "force": true });
	}
}

const requested: string[] = config.get("workspaces");

const buildResults = Object.entries(await build(requested.length > 0 ? requested : undefined));
const workspaces = buildResults.filter(([key, value]) => value === 0).map(([key]) => key);

// Packages whose build failed — collected so the run fails loudly at the end (see the catches below)
// rather than silently shipping a stale tarball. A workspace whose own `build` script exited non-zero
// counts from the start: dropping it quietly is how a broken package once fell through to publishing
// the repo root instead.
const buildFailures: string[] = buildResults.filter(([key, value]) => value !== 0).map(([key]) => key);

for (const workspace of buildFailures) {
	console.error(`❌ build script failed for ${workspace}`);
}

// All git-tracked workspaces (incl. private) — used to keep a parent's source build from slurping a
// nested package's sources (e.g. silo's root tarball must NOT pull in examples/ci-demo or a private
// vscode-in-browser subproject). Each nested package publishes itself.
const allWorkspaces = (await fs.findWorkspaces()).map((workspace) => workspace.dir);

// Decide whether to publish the repo ROOT. A single-package repo — one whose only sub-package.jsons are
// private (e.g. silo, whose sole sub-package is the private examples/ci-demo) — publishes its root. A
// monorepo with publishable sub-workspaces (e.g. lib → util, packages/*) publishes those and never the
// root. Adding "." AFTER build() — never passing it in — avoids re-running a root `build` that calls build().
function isPublishable(workspace) {
	try {
		return JSON.parse(fs.readFileSync(path.join(__root, workspace, "package.json")))["private"] !== true;
	} catch {
		return false;
	}
}

// Decided over EVERY sub-workspace, not just the ones that built: a monorepo whose packages all failed to
// build must fail, not fall back to publishing its root.
if (!buildResults.some(([workspace]) => workspace !== "." && isPublishable(workspace)) && isPublishable(".")) {
	workspaces.push(".");
}

// TODO: Parallelize
for (const workspace of workspaces) {
	if (!fs.existsSync(path.join(workspace, "package.json"))) {
		continue;
	}

	const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json")));

	if (packageJson["private"] === true) {
		continue;   // never publish private packages (the monorepo root, example/fixture packages, …)
	}

	// One span per published workspace: times its build/version/tar work and nests the steps below.
	using span = log.span("publish", { "workspace": workspace });

	// Directories of workspaces nested UNDER this one — excluded from the source build so a parent
	// (especially the repo root `.`) never ships a nested package's files. Absolute, for the .mjs/.cjs
	// glob; relative form derived inline for the .ts glob.
	const nestedDirs = allWorkspaces.filter((dir) => (workspace === "." ? dir !== "." : dir !== workspace && dir.startsWith(workspace + "/")));
	const nestedAbs = nestedDirs.map((dir) => path.join(__root, dir));
	const isNested = (entry: string) => nestedDirs.some((dir) => entry.startsWith(dir + "/")) || nestedAbs.some((dir) => entry.startsWith(dir + path.sep));

	// A package that declares `files` (e.g. the monaco-vscode-api bundle) ships its own pre-built
	// output — `build()` above already produced it. Everything else is built from source here.
	const preBuilt = Array.isArray(packageJson["files"]);

	// Runnable CLIs get a shebang (Node strips it on import, so they stay importable too) and a bin entry.
	// Two sources: anything under scripts/ (convention → bin `${pkg}-${name}`), and any path a package
	// explicitly declares in its own `bin` field (preserved as-is — e.g. silo's root `cli.js`).
	const declaredBin = packageJson["bin"];
	const binTargets = new Set((typeof declaredBin === "string" ? [declaredBin] : Object.values(declaredBin ?? {})).map((target) => String(target).replace(/^\.\//u, "")));
	const isBin = (fileName: string) => /^scripts\/[^/]+\.js$/u.test(fileName) || binTargets.has(fileName);

	let files: Record<string, Buffer>;

	if (preBuilt) {
		files = await collectBuiltFiles(path.join(__root, workspace).replace(/\\/gu, "/"), packageJson["files"]);
	} else {
		const entryPoints = packageJson["exports"] ?? (await Array.fromAsync(fs.glob(path.join(workspace, "**", "*.ts"), { "exclude": (entry) => entry.includes("node_modules") || isNested(entry) }))).map((entry) => path.join(__root, entry).replace(/\\/gu, "/"));

		// Nothing to transpile and nothing pre-built: say so, instead of rolldown's opaque "must supply options.input".
		if (entryPoints.length === 0) {
			console.error(`❌ build failed for ${workspace}: no entry points (no \`exports\`, no .ts sources, no \`files\`) — mark it private or declare what it ships`);
			buildFailures.push(workspace);
			continue;
		}

		let result;

		try {
			result = await vite.build({
				"mode": "production",
				"root": path.join(__root, workspace).replace(/\\/gu, "/"),
				"define": {
					"process.env": "process.env"
				},
				"build": {
					"ssr": true,
					"target": "esnext",
					"rollupOptions": {
						"input": entryPoints,
						"external": (id) => !id.startsWith(".") && !path.isAbsolute(id),
						"preserveEntrySignatures": "strict",
						"output": {
							"preserveModules": true,
							"preserveModulesRoot": path.join(__root, workspace).replace(/\\/gu, "/"),
							"entryFileNames": "[name].js"
						}
					},
					"minify": false,
					"modulePreload": { "polyfill": false },
					"write": false
				}
			});
		} catch (error) {
			// Don't swallow a build failure silently — that ships a stale tarball while CI stays green.
			// Record it, keep going so other packages still build, then exit non-zero at the end.
			console.error(`❌ build failed for ${workspace}:`, error);
			buildFailures.push(workspace);
			continue;
		}

		const { output } = Array.isArray(result) ? result[0] : result;

		files = Object.fromEntries(output
			.filter(({ type }) => type === "chunk")
			.map(({ fileName, code }) => [fileName, Buffer.from(isBin(fileName) ? "#!/usr/bin/env node\n" + code : code)]));

		// vite only built the .ts entries; also ship hand-written .mjs/.cjs source verbatim — files node
		// loads directly at runtime (silo's `node --import` preload + the broker it injects, the Deno
		// backend, the cooldown installer), which genuinely can't be .ts. Keyed workspace-relative.
		// `withFileTypes` makes the exclude callback receive a Dirent, not a string — normalize to a path
		// first, or `.includes` throws (TypeError: entry.includes is not a function) and aborts the build.
		for await (const entry of fs.glob(path.join(__root, workspace, "**", "*.{mjs,cjs}"), { "exclude": (entry) => {
			const file = typeof entry === "string" ? entry : path.join(entry.parentPath, entry.name);

			return file.includes("node_modules") || isNested(file);
		}, "withFileTypes": true })) {
			if (!entry.isFile()) {
				continue;
			}

			const absolute = path.join(entry.parentPath, entry.name);

			files[path.relative(path.join(__root, workspace), absolute).replace(/\\/gu, "/")] = await fs.readFile(absolute, { "encoding": null });
		}

		// Ship `.d.ts` for the transpiled sources — the esbuild/vite output above carries no types.
		Object.assign(files, await emitDeclarations(workspace, nestedDirs));
	}

	const binFiles = Object.keys(files).filter(isBin);

	let archiveVersion;

	const tarFile = path.join(distDirectory, workspace + "@latest.tgz");

	let archiveFiles: Record<string, Buffer> | undefined;

	if (fs.existsSync(tarFile)) {
		archiveFiles = await new Promise(function(resolve, reject) {
			const extract = tarStream.extract();

			const input = fs.createReadStream(tarFile);

			const files: Record<string, Buffer> = {};

			extract.on("entry", function(header, stream, next) {
				const chunks = [];

				stream.on("data", function(chunk) {
					chunks.push(chunk);
				});

				stream.on("end", function() {
					if (path.resolve(path.dirname(tarFile), header.name).startsWith(path.dirname(tarFile))) {
						files[header.name.substring("package/".length)] = Buffer.concat(chunks);
					}

					next();
				});

				stream.resume();
			});

			extract.on("finish", function() {
				resolve(files);
			});

			input.pipe(createGunzip()).pipe(extract);
		});

		const packageJson = JSON.parse(archiveFiles["package.json"]?.toString() ?? "{}");

		archiveVersion = packageJson["version"];
		span.info("archiveVersion", { "version": archiveVersion });
	}

	// Drop `scripts` from the published archive — they're build/dev tooling, and a lifecycle
	// `preinstall`/`postinstall` would otherwise run on the consumer's install, referencing
	// files that aren't shipped. (Allowlist the published fields instead if more leaks show up.)
	const { "scripts": _scripts, ...publishable } = packageJson;

	const buildPackageJson = (version) => JSON.stringify(preBuilt ? {
		...publishable,
		"name": `@${owner}/${packageJson["name"]}`,
		"version": version
	} : {
		...publishable,
		"name": `@${owner}/${packageJson["name"]}`,
		"exports": Object.fromEntries(Object.keys(files).filter((key) => key !== "package.json" && !key.endsWith(".d.ts")).map((key) => {
			// Pair each entry with its emitted declaration (if any) so TypeScript consumers get types;
			// hand-written .mjs/.cjs have no sibling .d.ts and stay a bare target string.
			const dtsKey = key.replace(/\.[^.]+$/u, ".d.ts");
			const target = files[dtsKey] !== undefined ? { "types": "./" + dtsKey, "default": "./" + key } : "./" + key;
			const directory = path.dirname(key).replace(/\\/gu, "/");
			const baseName = path.basename(key, path.extname(key));

			// An `index` module is addressed by its directory (root index becomes the `.` main entry);
			// everything else by its own path-without-extension.
			if (baseName === "index") {
				return [directory === "." ? "." : "./" + directory, target];
			}

			return ["./" + path.join(directory, baseName).replace(/\\/gu, "/"), target];
		})),
		"files": Object.keys(files).filter((key) => key !== "package.json"),
		// bin: preserve a package's own `bin` (e.g. silo's root `cli.js` → `silo`), else derive
		// from scripts/* as `${pkg}-${name}` (e.g. util-build). The CLI name is kebab-cased so a
		// camelCase source file still yields a hyphenated binary (buildStatic.js → util-build-static),
		// keeping module identifiers camel while shell binaries read naturally. Targets are "./"-normalized.
		...(declaredBin
			? { "bin": typeof declaredBin === "string"
					? "./" + String(declaredBin).replace(/^\.\//u, "")
					: Object.fromEntries(Object.entries(declaredBin).map(([name, target]) => [name, "./" + String(target).replace(/^\.\//u, "")])) }
			: binFiles.length > 0
				? { "bin": Object.fromEntries(binFiles.map((key) => [`${packageJson["name"]}-${pascalCaseToKebabCase(path.basename(key, ".js"))}`, "./" + key])) }
				: {}),
		"version": version
	}, undefined, 2);

	// Build with the currently-published version so an unchanged package compares equal (no version churn).
	let version = archiveVersion ?? packageJson["version"] ?? "0.1.0";

	files["package.json"] = Buffer.from(buildPackageJson(version));

	// Build every run; publish only when the emitted artifact differs from the last published one.
	if (archiveFiles && Object.keys(files).length === Object.keys(archiveFiles).length && Object.entries(files).every(([key, value]) => archiveFiles[key] !== undefined && value.equals(archiveFiles[key]))) {
		span.info("No changes - skipping release");
		continue;
	}

	// Changed (or first publish): bump the version off the published one and rebuild package.json.
	if (archiveVersion) {
		const [major, minor] = archiveVersion.split(".");

		version = [major, parseInt(minor) + 1, 0].join(".");
		files["package.json"] = Buffer.from(buildPackageJson(version));
		span.info("Bumping version", { "version": version });
	}

	// Ensure a release exists for this package.
	const isDraft = async () => {
		span.info("Checking for release draft", { "release": workspace + "@" + version });
		const gh = await exec("gh", ["release", "view", workspace + "@" + version, "--json", "isDraft", "--jq", ".isDraft"]);

		span.info("gh release view", { "code": gh.exitCode, "output": gh.stdout });

		return gh.ok && gh.stdout === "true";
	};

	if (isCI && !(await isDraft())) {
		console.error(`❌ Skipping ${workspace}: no GitHub release exists`);
		continue;
	}
	// </>

	const pack = tarStream.pack();

	for (const [fileName, contents] of Object.entries(files)) {
		pack.entry({ "name": "package/" + fileName.replace(/\\/gu, "/") }, contents);
	}

	pack.finalize();

	const outputDirectory = path.join(distDirectory, path.dirname(workspace));

	await fs.mkdir(outputDirectory, { "recursive": true });

	const tarPath = path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz");
	const writeStream = fs.createWriteStream(tarPath);

	span.info("Writing tar", { "path": tarPath });

	writeStream.on("finish", async function() {
		if (isCI) {
			await fs.copyFile(tarPath, path.join(outputDirectory, path.basename(workspace) + "@latest.tgz"));
			span.info("Copied to latest");
		}

		// Also publish to the npm registry when a publishing token is present (so `npx @owner/pkg` works).
		// The GitHub-Pages tarball above is the default channel; npm is additive and opt-in via the token.
		// Auth is passed through the env so no .npmrc is required; the tarball's own publishConfig (access,
		// provenance) is honored.
		if (npmToken !== "") {
			// exec auto-shells `npm` (a .cmd shim) on Windows — the site that previously lacked shell:true.
			await exec("npm", ["publish", tarPath, "--access", "public"], {
				"stdio": "inherit",
				"env": { ...process.env, "npm_config_//registry.npmjs.org/:_authToken": npmToken }
			});
		}
	});

	pack.pipe(createGzip()).pipe(writeStream);
}

// Any build failure fails the run — but via `exitCode`, NOT `process.exit()`: the successful packages'
// tarball writes / npm-publishes are still in flight (fire-and-forget streams above), and a hard exit
// would truncate them. Setting the code lets the event loop drain (successes finish) then exits non-zero,
// which publish.sh captures and propagates AFTER promoting those successes.
if (buildFailures.length > 0) {
	console.error(`❌ ${buildFailures.length} package(s) failed to build: ${buildFailures.join(", ")}`);
	process.exitCode = 1;
}
