import { strict as assert } from "node:assert";
import { command, invoke, subcommands } from "./cli";
import { juvy } from "./index";

// Parsing: flags, a short one, a positional rest.
const plain = await juvy({ "all": { "format": Boolean, "default": false, "short": "a" }, "files": { "format": Array, "default": [], "positional": "rest" } }).parse(["-a", "x.ts", "y.ts"]);

assert.equal(plain.get("all"), true);
assert.deepEqual(plain.get("files"), ["x.ts", "y.ts"]);

// stopEarly: what comes after the first positional is the program's, unparsed — `node --inspect app.ts --port 3`.
const node = () => juvy({ "inspect": { "format": Boolean, "default": false }, "eval": { "format": String, "default": "", "short": "e" }, "args": { "format": Array, "default": [], "positional": "rest" } }, { "stopEarly": true });

assert.deepEqual((await node().parse(["--inspect", "app.ts", "--port", "3"])).get("args"), ["app.ts", "--port", "3"]);
assert.equal((await node().parse(["-e", "console.log(1)", "first"])).get("eval"), "console.log(1)", "a string option's value isn't the first positional");
assert.deepEqual((await node().parse(["-e", "x", "first", "--flag"])).get("args"), ["first", "--flag"]);
await assert.rejects(node().parse(["--nope", "app.ts"]), /Unknown option '--nope'/u, "before the first positional, still strict");

// invoke: what run does, through an io instead of a process.
const io = () => {
	const written = { "out": "", "err": "" };

	return { written, "io": { "out": (text: string) => { written.out += text; }, "err": (text: string) => { written.err += text; } } };
};
const app = subcommands({ "name": "tool", "commands": [
	command({ "name": "greet", "description": "Say hello.", "config": juvy({ "name": { "format": String, "default": "world", "positional": true } }), "handler": (config) => `hello ${config.get("name")}` })
] });

{
	const { written, io: sink } = io();

	assert.deepEqual(await invoke(app, ["greet", "you"], sink), { "exitCode": 0, "value": "hello you" });
	assert.equal(written.out + written.err, "", "the handler's output is its own");
}

{
	const { written, io: sink } = io();

	assert.equal((await invoke(app, ["gret"], sink)).exitCode, 1);
	assert.match(written.err, /unknown tool command 'gret'\. Did you mean 'greet'\?/u);
}

{
	const { written, io: sink } = io();

	assert.equal((await invoke(app, ["greet", "--help"], sink)).exitCode, 0);
	assert.match(written.out, /Say hello\./u);
}

{
	const { written, io: sink } = io();

	assert.equal((await invoke(app, ["greet", "--loud"], sink)).exitCode, 1);
	assert.match(written.err, /Unknown option '--loud'/u);
}

// With stopEarly, a --help after the first positional is the program's.
{
	const { io: sink } = io();
	const runner = command({ "name": "run", "config": juvy({ "args": { "format": Array, "default": [], "positional": "rest" } }, { "stopEarly": true }), "handler": (config) => config.get("args") });

	assert.deepEqual(await invoke(runner, ["app.ts", "--help"], sink), { "exitCode": 0, "value": ["app.ts", "--help"] });
}
