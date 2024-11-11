import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

import { createReadLineStream } from "./util/stream";

// Monkey-patch `readline.d.ts`
declare module "readline" {
    interface Interface {
        input: fs.ReadStream;
    }
}

function createReadStream(filePath, cwd?) {
    const directory = path.dirname(filePath);
    const fileName = path.basename(filePath);
    filePath = cwd === undefined ? directory : path.join(path.dirname(cwd), directory);

    return createInterface({
        "input": path.join(filePath, fileName)
    });
}

const readStream = createReadLineStream("input.txt");

const writeStream = fs.createWriteStream("output.txt");

async function readLine(line, parentReadStream = readStream) {
    parentReadStream.pause();

    switch (true) {
        case /^@import ".*";$/.test(line): {
            await readFile(createReadStream(line.substring(line.indexOf("\"") + 1, line.length - 2), parentReadStream.input.path));
            break;
        }
        default: {
            writeStream.write(line + "\n");
        }
    }

    parentReadStream.resume();
}

function readFile(readStream) {
    readStream.on("line", function(line) {
        readLine(line, readStream);
    });

    return new Promise<void>(function(resolve, reject) {
        readStream.on("close", function() {
            resolve();
        });
    });
}

readStream.on("line", readLine);
