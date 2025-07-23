import { __root, isCI } from "../util/env";
import { esbuild } from "../util/esbuild"
import { build } from "./build";
import { glob } from "../util/fs";
import * as path from "path";
import * as fs from "../util/fs";
import { createGunzip, createGzip } from "zlib";
import tarStream from "tar-stream";
import { spawn } from "child_process";
//import * as JSON from "../util/json";

const distDirectory = path.join(__root, "docs");

const workspaces = Object.entries(await build(process.argv.length > 2 ? process.argv.slice(2) : undefined)).filter(([key, value]) => value === 0).map(([key]) => key);

// TODO: Parallelize
for (const workspace of workspaces) {
    if (!fs.existsSync(path.join(workspace, "package.json"))) {
        continue;
    }

    const packageJson = JSON.parse(await fs.readFile(path.join(workspace, "package.json")));

    const entryPoints = packageJson["exports"] ?? (await Array.fromAsync(glob(path.join(workspace, "**", "*.ts"), { "exclude": ["**/node_modules/*"] }))).map((path) => path.replace(/\\/gu, "/"));

    let result;

    try {
        result = await esbuild({
            "bundle": false,
            "entryPoints": entryPoints,
            "format": "esm",
            "outdir": "/",
            "platform": "node",
            "absWorkingDir": path.join(__root, workspace).replace(/\\/gu, "/")
        });
    } catch (error) {
        continue;
    }

    const files = Object.fromEntries(result.outputFiles.map(({ "path": filePath, text }) => [filePath.substring("/".length).replace(/\\/gu, "/"), text]));

    let archiveVersion;

    const tarFile = path.join(distDirectory, workspace + "@latest.tgz")

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
    }

    let version = packageJson["version"] ?? "0.1.0"

    if (version === archiveVersion) {
        const [major, minor] = archiveVersion.split('.');

        version = [major, parseInt(minor) + 1, 0].join('.');
    }

    // Ensure a release exists for this package.
    const isDraft = () => new Promise(function(resolve, reject) {
        const gh = spawn("gh", ["release", "view", workspace + "@" + version, "--json", "isDraft", "--jq", ".isDraft"]);

        const chunks = [];

        gh.stdout.on("data", function(chunk) {
            chunks.push(chunk);
        });

        gh.on("close", function(code) {
            resolve(code === 0 && Buffer.concat(chunks).toString().trim() === "true");
        });
    });

    if (isCI && !(await isDraft())) {
        console.error(`❌ Skipping ${workspace}: no GitHub release exists`);

        continue;
    }
    // </>

    files["package.json"] = JSON.stringify({
        ...packageJson,
        "exports": Object.fromEntries(Object.keys(files).map((key) => [key, key])),
        "files": Object.keys(files),
        "version": version
    }, undefined, 2)

    // Compare files
    if (Object.keys(files).length === Object.keys(archiveFiles).length && Object.entries(files).every(([key, value]) => archiveFiles[key] === value)) {
        continue;
    }

    const pack = tarStream.pack();

    for (const [fileName, contents] of Object.entries(files)) {
        pack.entry({ "name": fileName.replace(/\\/gu, "/") }, contents);
    }

    pack.finalize();

    const outputDirectory = path.join(distDirectory, path.dirname(workspace))

    await fs.mkdir(outputDirectory, { "recursive": true })

    const output = fs.createWriteStream(path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz"));

    if (isCI) {
        output.on("finish", async function() {
            await fs.copyFile(path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz"), path.join(outputDirectory, path.basename(workspace) + "@latest.tgz"))
        });
    }

    pack.pipe(createGzip()).pipe(output);
}
