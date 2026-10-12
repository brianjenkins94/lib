import { strict as assert } from "node:assert";
import * as path from "node:path";
import * as url from "node:url";
import * as vm from "node:vm";

import * as fs from "@brianjenkins94/util/fs";
import { build } from "esbuild";

import * as env from "./env";

// util/env loads as an ES module and as CommonJS: bundled as CommonJS (as the editor's extensions bundle util),
// `import.meta` is empty.
const source = ["env.ts", "env.js"].map((name) => url.fileURLToPath(new URL(name, import.meta.url))).find((file) => fs.existsSync(file))!; // source, or published

/** env bundled as CommonJS, run in a fresh realm made of `globals`; its exports. */
async function commonjs(globals: Record<string, unknown>): Promise<typeof env> {
	const { outputFiles } = await build({ "entryPoints": [source], "bundle": true, "format": "cjs", "platform": "node", "external": ["node:*"], "write": false, "logLevel": "silent" });
	const module = { "exports": {} };

	vm.runInNewContext(outputFiles[0].text, { "module": module, "exports": module.exports, ...globals });

	return module.exports as typeof env;
}

// As an ES module in Node: util's root is the folder holding util/.
assert.equal(env.__root, path.join(path.dirname(source), ".."));
assert.equal(env.isBrowser, false);

// As Node CommonJS: its own file is CommonJS's __filename — a bundle's.
const started = (entry: string): typeof process => ({ ...process, "argv": [process.argv[0], entry], "getBuiltinModule": process.getBuiltinModule.bind(process) }) as typeof process;
const node = await commonjs({ "require": (await import("node:module")).createRequire(source), "process": started(source), "__filename": source, URL });

assert.equal(node.isBrowser, false);
assert.equal(node.__root, path.join(path.dirname(source), ".."));
assert.equal(node.isEntry({ "url": "file:///x.js" }), false, "another module isn't the entry");

// import.meta empty or undefined, as a CommonJS bundle passes it: the module is the bundle, the entry when Node started it.
assert.equal(node.isEntry({}), true);
assert.equal(node.isEntry(undefined), true);

const other = await commonjs({ "require": (await import("node:module")).createRequire(source), "process": started(path.join(path.dirname(source), "array.ts")), "__filename": source, URL });

assert.equal(other.isEntry({}), false, "a bundle Node didn't start isn't the entry");

console.log("env: ok");
