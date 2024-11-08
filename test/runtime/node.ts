import { promises as fs } from "fs";
import * as path from "path";
import { __root } from "../../util/env";
import { spawn } from "child_process";

for await (const file of fs.glob(path.join(__root, "util", "**", "*.ts"), {
    "exclude": function(fileName) {
        return /node_modules/ui.test(fileName)
    }
})) {
    console.log(">", ["npx", "tsx", file].join(" "))
    let subprocess = spawn("npx", ["tsx", file], {
        "shell": true,
        //"stdio": "inherit"
    });

    await new Promise<void>(function recurse(resolve, reject) {
        const buffer = [];

        subprocess.stderr.on("data", function(chunk) {
            buffer.push(chunk);
        });

        subprocess.on("close", async function(code) {
            if (code === 0) {
                resolve();

                return;
            }

            const [packageName] = /(?<=').*(?=')/u.exec(Buffer.concat(buffer).toString())

            console.log(">", ["npx", "install", packageName].join(" "))
            const subsubprocess = spawn("npm", ["install", packageName], {
                "cwd": path.join(__root, "util"),
                "shell": true,
                "stdio": "inherit"
            });

            await new Promise(function(resolve, reject) {
                subsubprocess.on("close", resolve);
            });

            const subbuffer = [];

            console.log(">", ["npx", "tsx", file].join(" "))
            subprocess = spawn("npx", ["tsx", file], {
                "shell": true,
                //"stdio": "inherit"
            });

            recurse(resolve, reject);
        })
    });
}
