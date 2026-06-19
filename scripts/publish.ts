import * as vite from "vite";
import { __root, isCI } from "../util/env";
import { build } from "../util/scripts/build";
import { glob } from "../util/fs";
import * as path from "path";
import * as fs from "../util/fs";
import { createGunzip, createGzip } from "zlib";
import tarStream from "tar-stream";
import { spawn } from "child_process";
//import * as JSON from "../util/json";

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

// TODO: Parallelize
for (const workspace of workspaces) {
    if (!fs.existsSync(path.join(workspace, "package.json"))) {
        continue;
    }

    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json")));

    // A package that declares `files` (e.g. the monaco-vscode-api bundle) ships its own pre-built
    // output — `build()` above already produced it. Everything else is built from source here.
    const preBuilt = Array.isArray(packageJson["files"]);

    // Files directly under scripts/ are runnable CLIs: they get a shebang (Node strips it on
    // import, so they stay importable too) and a bin entry (see buildPackageJson).
    const isBin = (fileName: string) => /^scripts\/[^/]+\.js$/u.test(fileName);

    let files: Record<string, Buffer>;

    if (preBuilt) {
        files = await collectBuiltFiles(path.join(__root, workspace).replace(/\\/gu, "/"), packageJson["files"]);
    } else {
        const entryPoints = packageJson["exports"] ?? (await Array.fromAsync(glob(path.join(workspace, "**", "*.ts"), { "exclude": ["**/node_modules/*"] }))).map((entry) => path.join(__root, entry).replace(/\\/gu, "/"));

        let result;

        try {
            result = await vite.build({
                "mode": "production",
                "root": path.join(__root, workspace).replace(/\\/gu, "/"),
                "define": {
                    "process.env.NODE_ENV": "process.env.NODE_ENV"
                },
                "build": {
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
                "exports": Object.fromEntries(Object.keys(files).filter((key) => key !== "package.json").map((key) => ["./" + path.join(path.dirname(key), path.basename(key, path.extname(key))).replace(/\\/gu, "/"), "./" + key])),
                "files": Object.keys(files).filter((key) => key !== "package.json"),
                ...(binFiles.length > 0 ? { "bin": Object.fromEntries(binFiles.map((key) => [`${packageJson["name"]}-${path.basename(key, ".js")}`, "./" + key])) } : {}),
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

    const writeStream = fs.createWriteStream(path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz"));
    console.log("Writing tar to:", path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz"));

    if (isCI) {
        writeStream.on("finish", async function() {
            await fs.copyFile(path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz"), path.join(outputDirectory, path.basename(workspace) + "@latest.tgz"))
            console.log("Copied to latest for", workspace);
        });
    }

    pack.pipe(createGzip()).pipe(writeStream);
}
