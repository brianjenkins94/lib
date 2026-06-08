import * as vite from "vite";
import { __root, isCI } from "../util/env";
import { build } from "./build";
import { glob } from "../util/fs";
import * as path from "path";
import * as fs from "../util/fs";
import { createGunzip, createGzip } from "zlib";
import tarStream from "tar-stream";
import { spawn } from "child_process";
//import * as JSON from "../util/json";

const distDirectory = path.join(__root, "docs");

// Highest-versioned draft GitHub release for a workspace, e.g. "0.4.0", or undefined if none.
const latestDraftVersion = (workspace) => new Promise<string | undefined>(function(resolve, reject) {
    const gh = spawn("gh", ["release", "list", "--limit", "100", "--json", "tagName,isDraft", "--jq",
        `[.[] | select(.isDraft and (.tagName | startswith("${workspace}@"))) | .tagName | sub("${workspace}@"; "") | split(".") | map(tonumber)] | sort | last | if . == null then "" else map(tostring) | join(".") end`]);

    const chunks = [];

    gh.stdout.on("data", function(chunk) {
        chunks.push(chunk);
    });

    gh.on("close", function() {
        const output = Buffer.concat(chunks).toString().trim();

        resolve(output === "" ? undefined : output);
    });
});

const workspaces = Object.entries(await build(process.argv.length > 2 ? process.argv.slice(2) : undefined)).filter(([key, value]) => value === 0).map(([key]) => key);

// TODO: Parallelize
for (const workspace of workspaces) {
    if (!fs.existsSync(path.join(workspace, "package.json"))) {
        continue;
    }

    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json")));

    const entryPoints = packageJson["exports"] ?? (await Array.fromAsync(glob(path.join(workspace, "**", "*.ts"), { "exclude": ["**/node_modules/*"] }))).map((entry) => path.join(__root, entry).replace(/\\/gu, "/"));

    let result;

    try {
        result = await vite.build({
            "mode": "production",
            "root": path.join(__root, workspace).replace(/\\/gu, "/"),
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
    const files = Object.fromEntries(output.filter(({ type }) => type === "chunk").map(({ fileName, code }) => [fileName, code]));

    let archiveVersion;

    const tarFile = path.join(distDirectory, workspace + "@latest.tgz")

    // The gitignored docs/*.tgz aren't checked out, and the github-pages build artifact
    // they're otherwise restored from only has 1-day retention. The live Pages site is the
    // durable copy of the last publish, so pull the previous archive from there for change
    // detection when it isn't already present.
    if (!fs.existsSync(tarFile)) {
        const [, repository] = (process.env["GITHUB_REPOSITORY"] ?? "/").split("/");
        const url = `https://${process.env["GITHUB_REPOSITORY_OWNER"]}.github.io/${repository}/${workspace}@latest.tgz`;

        const response = await fetch(url);

        if (response.ok) {
            await fs.mkdir(path.dirname(tarFile), { "recursive": true });
            await fs.writeFile(tarFile, Buffer.from(await response.arrayBuffer()));
            console.log("Fetched prior archive for", workspace, "from", url);
        } else {
            console.log("No prior archive for", workspace, "at", url, "(", response.status, ")");
        }
    }

    let archiveFiles;

    if (fs.existsSync(tarFile)) {
        archiveFiles = await new Promise(function(resolve, reject) {
            const extract = tarStream.extract();

            const input = fs.createReadStream(tarFile);

            const files = {};

            extract.on("entry", function(header, stream, next) {
                const chunks = [];

                stream.on("data", function(chunk) {
                    chunks.push(chunk);
                });

                stream.on("end", function() {
                    if (path.resolve(path.dirname(tarFile), header.name).startsWith(path.dirname(tarFile))) {
                        files[header.name.substring("package/".length)] = Buffer.concat(chunks).toString();
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

        const packageJson = JSON.parse(archiveFiles["package.json"] ?? "{}")
        archiveVersion = packageJson["version"];
        console.log("archiveVersion for", workspace, ":", archiveVersion);
    }

    const buildPackageJson = (version) => JSON.stringify({
        ...packageJson,
        "name": `@${process.env["GITHUB_REPOSITORY_OWNER"]}/${packageJson["name"]}`,
        "exports": Object.fromEntries(Object.keys(files).filter((key) => key !== "package.json").map((key) => ["./" + path.join(path.dirname(key), path.basename(key, path.extname(key))).replace(/\\/gu, "/"), "./" + key])),
        "files": Object.keys(files).filter((key) => key !== "package.json"),
        "version": version
    }, undefined, 2);

    // Build with the currently-published version so an unchanged package compares equal (no version churn).
    let version = archiveVersion ?? packageJson["version"] ?? "0.1.0";
    files["package.json"] = buildPackageJson(version);

    // Build every run; publish only when the emitted artifact differs from the last published one.
    if (archiveFiles && Object.keys(files).length === Object.keys(archiveFiles).length && Object.entries(files).every(([key, value]) => archiveFiles[key] === value)) {
        console.log("No changes for", workspace, "- skipping release");
        continue;
    }

    // The `release` job (tag.sh) already chose the target version and created a draft
    // release for it. Discover and use that version rather than re-deriving it here, so
    // both jobs agree (publish.sh un-drafts `workspace@version`).
    const draftVersion = await latestDraftVersion(workspace);

    if (!draftVersion) {
        console.error(`❌ Skipping ${workspace}: no draft release exists`);
        continue;
    }

    version = draftVersion;
    files["package.json"] = buildPackageJson(version);
    console.log("Publishing", workspace, "at draft version", version);

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
