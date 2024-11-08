import { walk } from "jsr:@std/fs/walk";
import * as path from "jsr:@std/path/posix";
import { __root } from "../../util/env.ts";

for await (const { "path": file } of walk(path.join(__root, "util"), { "includeDirs": false, "skip": [/node_modules/ui] })) {
    console.log(">", ["deno", "--allow-all", "--unstable-sloppy-imports", file].join(" "))
    const subprocess = new Deno.Command("deno", {
        "args": ["--allow-all", "--unstable-sloppy-imports", file],
        "stdin": "piped",
        "stdout": "piped",
    }).spawn();

    const result = await subprocess.output();

    console.log(new TextDecoder().decode(result.stdout));
}
