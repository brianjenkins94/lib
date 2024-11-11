import * as path from "path";
import { __root } from "../util/env.ts";
import * as fs from "../util/fs";
import { spawn } from "child_process";
import { series } from "../util/array"
import { Buffer } from "node:buffer";

// Visit each workspace and install its dependencies

const gitLs = spawn("git", ["ls-files", "\"**/package.json\""], {
    "shell": true,
})

const workspaces = await new Promise(function(resolve, reject) {
    const buffer = []

    gitLs.stdout.on("data", function(chunk) {
        buffer.push(chunk)
    })

    gitLs.on("close", function() {
        resolve(Buffer.concat(buffer).toString("utf8").trim().split("\n"));
    })
})

await Promise.all(workspaces.map(function(workspace) {
    return series([
        new Promise<void>(function(resolve, reject) {
            const subprocess = spawn("npm", ["run", "preinstall"], {
                "cwd": workspace,
                "shell": true,
                "stdio": "inherit"
            });

            subprocess.on("close", function() {
                subprocess.unref()

                resolve();
            })
        }),
        new Promise<void>(function(resolve, reject) {
            // FROM: https://github.com/vercel/turborepo/blob/1ae620cdf454d0258a162a96976e3064433391a2/packages/turbo/bin/turbo#L29
            const subprocess = spawn("npm", ["install", "--loglevel=error", "--prefer-offline", "--no-audit", "--progress=false"], {
                "cwd": workspace,
                "shell": true,
                "stdio": "inherit"
            });

            subprocess.on("close", function() {
                subprocess.unref()

                resolve();
            })
        })
    ])
}))
