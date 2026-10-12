import { strict as assert } from "node:assert";
import * as path from "node:path";
import * as url from "node:url";
import * as vm from "node:vm";

import { build } from "esbuild";

import * as env from "./env";

// util/env loads however it's loaded: as an ES module, as Node CommonJS, and bundled for a browser in either format — the
// editor's extensions bundle util as CommonJS for a realm with no `process` and stubbed `node:` built-ins.
const source = url.fileURLToPath(new URL("env.ts", import.meta.url));

/** env bundled as CommonJS for `platform`, run in a fresh realm made of `globals`; its exports. */
async function commonjs(platform: "browser" | "node", globals: Record<string, unknown>): Promise<typeof env> {
	const { outputFiles } = await build({ "entryPoints": [source], "bundle": true, "format": "cjs", "platform": platform, "external": ["node:*"], "write": false, "logLevel": "silent" });
	const module = { "exports": {} };

	vm.runInNewContext(outputFiles[0].text, { "module": module, "exports": module.exports, ...globals });

	return module.exports as typeof env;
}

// As an ES module in Node: util's root is the folder holding util/.
assert.equal(env.__root, path.join(path.dirname(source), ".."));
assert.equal(env.isBrowser, false);

// As CommonJS in a browser realm: no process, no file system, node: built-ins empty — it loads, and says so.
const browser = await commonjs("browser", { "require": () => ({}), "window": {}, "self": { addEventListener() {} } });

assert.equal(browser.isBrowser, true);
assert.equal(browser.__root, "/", "no file system: no root to speak of");
assert.equal(browser.isWindows, false);
assert.equal(browser.isEntry({ "url": "file:///x.js" }), false);

// As Node CommonJS: its own file is CommonJS's __filename — a bundle's.
const started = (entry: string): typeof process => ({ ...process, "argv": [process.argv[0], entry], "getBuiltinModule": process.getBuiltinModule.bind(process) }) as typeof process;
const node = await commonjs("node", { "require": (await import("node:module")).createRequire(source), "process": started(source), "__filename": source, URL });

assert.equal(node.isBrowser, false);
assert.equal(node.__root, path.join(path.dirname(source), ".."));
assert.equal(node.isEntry({ "url": "file:///x.js" }), false, "another module isn't the entry");

// import.meta empty or undefined, as a CommonJS bundle passes it: the module is the bundle, the entry when Node started it.
assert.equal(node.isEntry({}), true);
assert.equal(node.isEntry(undefined), true);

const other = await commonjs("node", { "require": (await import("node:module")).createRequire(source), "process": started(path.join(path.dirname(source), "array.ts")), "__filename": source, URL });

assert.equal(other.isEntry({}), false, "a bundle Node didn't start isn't the entry");
assert.equal(browser.isEntry(undefined), false, "in a browser, nothing is");

console.log("env: ok");
