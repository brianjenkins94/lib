import { __root } from "../util/env";
import { esbuild } from "../util/esbuild"
import { build } from "./build";
import { glob } from "../util/fs";
import * as path from "path";
import * as fs from "../util/fs";
import { createGunzip, createGzip } from "zlib";
import tarStream from "tar-stream";

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

    const files = Object.fromEntries(result.outputFiles.map(({ "path": filePath, text }) => [path.relative(__root, filePath).replace(/\\/gu, "/"), text]));

    let version = "0.1.0";

    const tarFile = path.join(distDirectory, workspace + "@latest.tgz")

    if (fs.existsSync(tarFile)) {
        const extract = tarStream.extract();

        const input = fs.createReadStream(tarFile);

        input.pipe(createGunzip()).pipe(extract);

        extract.on("entry", function(header, stream, next) {
            //const chunks = [];

            stream.on("data", function(chunk) {
                //chunks.push(chunk);
            });

            stream.on("end", function() {
                next();
            });

            stream.resume();
        });
    }

    files["package.json"] = JSON.stringify({
        ...packageJson,
        "version": version,
        "files": files,
        "exports": []
    })

    const pack = tarStream.pack();

    for (const [fileName, contents] of Object.entries(files)) {
        pack.entry({ "name": fileName }, contents);
    }

    pack.finalize();

    const outputDirectory = path.join(distDirectory, path.dirname(workspace))

    const output = fs.createWriteStream(path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz"));

    pack.pipe(createGzip()).pipe(output);

    output.on("finish", async function() {
        await fs.copyFile(path.join(outputDirectory, path.basename(workspace) + "@" + version + ".tgz"), path.join(outputDirectory, path.basename(workspace) + "@latest.tgz"))
    });
}
