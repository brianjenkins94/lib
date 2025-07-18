import * as fs from "../../util/fs";
import * as path from "path";
import { __root } from "../../util/env";
import { spawn } from "child_process";

for await (const file of fs.glob(path.join(__root, "util", "**", "*.ts"), {
    "exclude": function(fileName) {
        return /node_modules/ui.test(fileName)
    }
})) {
    console.log(">", ["npx", "tsx", file].join(" "))
    let process = spawn("npx", ["tsx", file], {
        "shell": true,
        //"stdio": "inherit"
    });

    await new Promise<void>(function recurse(resolve, reject) {
        const buffer = [];

        process.stderr.on("data", function(chunk) {
            buffer.push(chunk);
        });

        process.on("close", async function(code) {
            if (code === 0) {
                resolve();

                return;
            }

            const [packageName] = /(?<=').*(?=')/u.exec(Buffer.concat(buffer).toString())

            console.log(">", ["npx", "install", "--save-peer", packageName + "@latest"].join(" "))
            const subprocess = spawn("npm", ["install", "--save-peer", packageName + "@latest"], {
                "cwd": path.join(__root, "util"),
                "shell": true,
                "stdio": "inherit"
            });

            await new Promise(function(resolve, reject) {
                subprocess.on("close", resolve);
            });

            console.log(">", ["npx", "tsx", file].join(" "))
            process = spawn("npx", ["tsx", file], {
                "shell": true,
                //"stdio": "inherit"
            });

            recurse(resolve, reject);
        })
    });
}
