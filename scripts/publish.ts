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

    const files = Object.fromEntries(result.outputFiles.map(({ "path": filePath, text }) => ["./" + path.relative(workspace, filePath).replace(/\\/gu, "/"), text]));

    let version = "0.1.0";

    const tarFile = path.join(distDirectory, workspace + "@latest.tgz")

    let existingFiles;

    if (fs.existsSync(tarFile)) {
        existingFiles = await new Promise(function(resolve, reject) {
            const extract = tarStream.extract();

            const input = fs.createReadStream(tarFile);

            const files = {};

            extract.on("entry", function(header, stream, next) {
                const chunks = [];

                stream.on("data", function(chunk) {
                    chunks.push(chunk);
                });

                stream.on("end", function() {
                    files["./" + header.name] = Buffer.concat(chunks).toString();

                    next();
                });

                stream.resume();
            });

            extract.on("finish", function() {
                resolve(files);
            });

            input.pipe(createGunzip()).pipe(extract);
        });

        const packageJson = JSON.parse(existingFiles["./package.json"] ?? "{}")

        if (packageJson["version"] !== undefined) {
            version = packageJson["version"] ?? version;
        }
    }

    // Ensure a release exists for this package.
    const draftExists: boolean | Record<string, string> = !isCI || await new Promise(function(resolve, reject) {
        const gh = spawn("gh", ["release", "list", "--json", "name,isDraft", "--jq", `.[] | select(.isDraft) | .name`]);

        const chunks = [];

        gh.stdout.on("data", function(chunk) {
            chunks.push(chunk);
        });

        gh.on("close", function(code) {
            const output = Buffer.concat(chunks).toString().trim();

            resolve(code === 0 && output.includes(workspace + "@" + version) || {
                "expected": workspace + "@" + version,
                "actual": output
            });
        });
    });

    if (typeof draftExists === "object") {
        if (draftExists["expected"].split(".").map(Number).reduce((result, a, index) => result || a - draftExists["actual"].split(".").map(Number)[index], 0) > 0) {
            const code = await new Promise(function(resolve, reject) {
                const gh = spawn("gh", ["release", "edit", workspace + "@" + version, "--title", workspace + "@" + draftExists["expected"]]);

                gh.on("close", function(code) {
                    resolve(code);
                });
            });

            if (code !== 0) {
                console.error(`❌ Skipping ${workspace}: expected: ${draftExists["existing"]}, actual: ${draftExists["actual"]}`);

                continue;
            }

            version = draftExists["actual"];
        } else {
            console.error(`❌ Skipping ${workspace}: no GitHub release exists`);

            continue;
        }
    }
    // </>

    files["./package.json"] = JSON.stringify({
        ...packageJson,
        "version": version,
        "files": Object.keys(files),
        "exports": Object.fromEntries(Object.keys(files).map((key) => [key, key]))
    }, undefined, 2)

    const pack = tarStream.pack();

    for (const [fileName, contents] of Object.entries(files)) {
        pack.entry({ "name": path.join("package", fileName).replace(/\\/gu, "/") }, contents);
    }

    pack.finalize();

    const outputDirectory = path.join(distDirectory, path.dirname(workspace))

    await fs.mkdir(outputDirectory, { "recursive": true })

    const output = fs.createWriteStream(path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz"));

    if (!isCI) {
        output.on("finish", async function() {
            await fs.copyFile(path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz"), path.join(outputDirectory, path.basename(workspace) + "@latest.tgz"))
        });
    }

    pack.pipe(createGzip()).pipe(output);
}
