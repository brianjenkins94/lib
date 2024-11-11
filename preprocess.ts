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

const readStream = createReadLineStream(fs.createReadStream("testdir/input.txt"));

const writeStream = fs.createWriteStream("testdir/output.txt");

async function readLine(line, parentReadStream = readStream) {
    parentReadStream.pause();

    switch (true) {
        case /^@import ".*";$/.test(line): {
            await readFile(createReadLineStream(fs.createReadStream(line.substring(line.indexOf("\"") + 1, line.length - 2))));
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
