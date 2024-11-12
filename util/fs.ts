import type { Abortable } from "node:events";
import * as fs from "node:fs";
import { OpenMode } from "node:fs";

export { createReadStream, createWriteStream, existsSync, writeFileSync } from "node:fs";
export { copyFile, cp, rename, rm, mkdir, readdir, stat, unlink, writeFile, appendFile, glob } from "node:fs/promises";

interface ReadFileOptions {
    encoding?: BufferEncoding;
    flag?: OpenMode | undefined;
}

export function readFile(path, options: Omit<ReadFileOptions, "encoding"> & { encoding?: Exclude<BufferEncoding, "utf8" | "utf-8"> } & Abortable = {}) {
    return fs.promises.readFile(path, { "encoding": "utf8", ...options });
}

interface ReadFileSyncOptions {
    encoding?: BufferEncoding;
    flag?: string | undefined;
}

export function readFileSync(path, options: Omit<ReadFileSyncOptions, "encoding"> & { encoding?: Exclude<BufferEncoding, "utf8" | "utf-8"> } = {}) {
    return fs.readFileSync(path, { "encoding": "utf8", ...options });
}
