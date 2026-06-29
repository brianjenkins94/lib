import * as vite from "vite";
import { isCI } from "../env";
import { build } from "./build";
import { glob, findWorkspaces } from "../fs";
import * as path from "path";
import * as fs from "../fs";
import { createGunzip, createGzip } from "zlib";
import tarStream from "tar-stream";
import { spawn } from "child_process";

// util-publish runs in whatever repo invokes it (silo, lib, …) — the root is the cwd, not util's dir.
const __root = process.cwd();

const distDirectory = path.join(__root, "docs");

/**
 * Collect a pre-built package's shipped files (the directories in its package.json `files`),
 * reading each as a Buffer (binary-safe — monaco-vscode-api ships wasm/fonts) and skipping
 * sourcemaps. Used for components that build their own self-contained dist rather than being
 * built from source here. Keys are workspace-relative POSIX paths.
 */
async function collectBuiltFiles(workspaceRoot: string, patterns: string[]): Promise<Record<string, Buffer>> {
    const result: Record<string, Buffer> = {};

    for (const pattern of patterns) {
        for await (const entry of glob(path.join(workspaceRoot, pattern, "**", "*"), { "exclude": ["**/*.map"], "withFileTypes": true })) {
            if (entry.isFile()) {
                const absolute = path.join(entry.parentPath, entry.name);

                result[path.relative(workspaceRoot, absolute).replace(/\\/gu, "/")] = await fs.readFile(absolute, { "encoding": null });
            }
        }
    }

    return result;
}

const workspaces = Object.entries(await build(process.argv.length > 2 ? process.argv.slice(2) : undefined)).filter(([key, value]) => value === 0).map(([key]) => key);

// All git-tracked workspaces (incl. private) — used to keep a parent's source build from slurping a
// nested package's sources (e.g. silo's root tarball must NOT pull in examples/ci-demo or a private
// vscode-in-browser subproject). Each nested package publishes itself.
const allWorkspaces = (await findWorkspaces()).map((workspace) => workspace.dir);

// Decide whether to publish the repo ROOT. A single-package repo — one whose only sub-package.jsons are
// private (e.g. silo, whose sole sub-package is the private examples/ci-demo) — publishes its root. A
// monorepo with publishable sub-workspaces (e.g. lib → util, packages/*) publishes those and never the
// root. Adding "." AFTER build() — never passing it in — avoids re-running a root `build` that calls build().
const isPublishable = (workspace) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(__root, workspace, "package.json")))["private"] !== true;
    } catch {
        return false;
    }
};

if (!workspaces.some((workspace) => workspace !== "." && isPublishable(workspace)) && isPublishable(".")) {
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

    // Directories of workspaces nested UNDER this one — excluded from the source build so a parent
    // (especially the repo root `.`) never ships a nested package's files. Absolute, for the .mjs/.cjs
    // glob; relative form derived inline for the .ts glob.
    const nestedDirs = allWorkspaces.filter((dir) => workspace === "." ? dir !== "." : dir !== workspace && dir.startsWith(workspace + "/"));
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
        const entryPoints = packageJson["exports"] ?? (await Array.fromAsync(glob(path.join(workspace, "**", "*.ts"), { "exclude": (entry) => entry.includes("node_modules") || isNested(entry) }))).map((entry) => path.join(__root, entry).replace(/\\/gu, "/"));

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
            continue;
        }

        const { output } = Array.isArray(result) ? result[0] : result as any;

        files = Object.fromEntries(output
            .filter(({ type }) => type === "chunk")
            .map(({ fileName, code }) => [fileName, Buffer.from(isBin(fileName) ? "#!/usr/bin/env node\n" + code : code)]));

        // vite only built the .ts entries; also ship hand-written .mjs/.cjs source verbatim — files node
        // loads directly at runtime (silo's `node --import` preload + the broker it injects, the Deno
        // backend, the cooldown installer), which genuinely can't be .ts. Keyed workspace-relative.
        for await (const entry of glob(path.join(__root, workspace, "**", "*.{mjs,cjs}"), { "exclude": (entry) => entry.includes("node_modules") || isNested(typeof entry === "string" ? entry : path.join(entry.parentPath, entry.name)), "withFileTypes": true })) {
            if (!entry.isFile()) {
                continue;
            }

            const absolute = path.join(entry.parentPath, entry.name);

            files[path.relative(path.join(__root, workspace), absolute).replace(/\\/gu, "/")] = await fs.readFile(absolute, { "encoding": null });
        }
    }

    const binFiles = Object.keys(files).filter(isBin);

    let archiveVersion;

    const tarFile = path.join(distDirectory, workspace + "@latest.tgz")

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

        const packageJson = JSON.parse(archiveFiles["package.json"]?.toString() ?? "{}")
        archiveVersion = packageJson["version"];
        console.log("archiveVersion for", workspace, ":", archiveVersion);
    }

    // Drop `scripts` from the published archive — they're build/dev tooling, and a lifecycle
    // `preinstall`/`postinstall` would otherwise run on the consumer's install, referencing
    // files that aren't shipped. (Allowlist the published fields instead if more leaks show up.)
    const { "scripts": _scripts, ...publishable } = packageJson;

    const buildPackageJson = (version) => JSON.stringify(
        preBuilt
            // Pre-built package: keep its own exports/files; only rewrite name + version.
            ? {
                ...publishable,
                "name": `@${process.env["GITHUB_REPOSITORY_OWNER"]}/${packageJson["name"]}`,
                "version": version
            }
            // Source package: derive exports/files/bin from the emitted modules.
            : {
                ...publishable,
                "name": `@${process.env["GITHUB_REPOSITORY_OWNER"]}/${packageJson["name"]}`,
                "exports": Object.fromEntries(Object.keys(files).filter((key) => key !== "package.json").map((key) => {
                    const target = "./" + key;
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
                // from scripts/* as `${pkg}-${name}` (e.g. util-build). Targets are "./"-normalized.
                ...(declaredBin
                    ? { "bin": typeof declaredBin === "string"
                        ? "./" + String(declaredBin).replace(/^\.\//u, "")
                        : Object.fromEntries(Object.entries(declaredBin).map(([name, target]) => [name, "./" + String(target).replace(/^\.\//u, "")])) }
                    : binFiles.length > 0
                        ? { "bin": Object.fromEntries(binFiles.map((key) => [`${packageJson["name"]}-${path.basename(key, ".js")}`, "./" + key])) }
                        : {}),
                "version": version
            }, undefined, 2);

    // Build with the currently-published version so an unchanged package compares equal (no version churn).
    let version = archiveVersion ?? packageJson["version"] ?? "0.1.0";
    files["package.json"] = Buffer.from(buildPackageJson(version));

    // Build every run; publish only when the emitted artifact differs from the last published one.
    if (archiveFiles && Object.keys(files).length === Object.keys(archiveFiles).length && Object.entries(files).every(([key, value]) => archiveFiles![key] !== undefined && value.equals(archiveFiles![key]))) {
        console.log("No changes for", workspace, "- skipping release");
        continue;
    }

    // Changed (or first publish): bump the version off the published one and rebuild package.json.
    if (archiveVersion) {
        const [major, minor] = archiveVersion.split('.');

        version = [major, parseInt(minor) + 1, 0].join('.');
        files["package.json"] = Buffer.from(buildPackageJson(version));
        console.log("Bumping version for", workspace, ":", version);
    }

    // Ensure a release exists for this package.
    const isDraft = () => new Promise(function(resolve, reject) {
        console.log("Checking if release draft exists for", workspace + "@" + version);
        const gh = spawn("gh", ["release", "view", workspace + "@" + version, "--json", "isDraft", "--jq", ".isDraft"]);

        const chunks = [];

        gh.stdout.on("data", function(chunk) {
            chunks.push(chunk);
        });

        gh.on("close", function(code) {
            console.log("gh release view exit code for", workspace, ":", code, "output:", Buffer.concat(chunks).toString());
            resolve(code === 0 && Buffer.concat(chunks).toString().trim() === "true");
        });
    });

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

    const outputDirectory = path.join(distDirectory, path.dirname(workspace))

    await fs.mkdir(outputDirectory, { "recursive": true })

    const tarPath = path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz");
    const writeStream = fs.createWriteStream(tarPath);
    console.log("Writing tar to:", tarPath);

    writeStream.on("finish", async function() {
        if (isCI) {
            await fs.copyFile(tarPath, path.join(outputDirectory, path.basename(workspace) + "@latest.tgz"))
            console.log("Copied to latest for", workspace);
        }

        // Also publish to the npm registry when a publishing token is present (so `npx @owner/pkg` works).
        // The GitHub-Pages tarball above is the default channel; npm is additive and opt-in via the token.
        // Auth is passed through the env so no .npmrc is required; the tarball's own publishConfig (access,
        // provenance) is honored.
        if (process.env["NPM_TOKEN"]) {
            await new Promise(function(resolve) {
                spawn("npm", ["publish", tarPath, "--access", "public"], {
                    "stdio": "inherit",
                    "env": { ...process.env, "npm_config_//registry.npmjs.org/:_authToken": process.env["NPM_TOKEN"] }
                }).on("close", resolve);
            });
        }
    });

    pack.pipe(createGzip()).pipe(writeStream);
}
