import { strict as assert } from "node:assert";
import { parseRuns, queryRuns, type RunEnvelope } from "./evidence";

const run = (id: string, endedAt: string, entry: string, effects?: RunEnvelope["effects"]): RunEnvelope => ({ "type": "run", "id": id, "title": `node ${entry}`, "entry": entry, "cwd": "", "startedAt": endedAt, "endedAt": endedAt, "exit": 0, "user": "ada", "environment": { "runtime": "tsval", "name": "default" }, "files": { [entry]: "0".repeat(40), "lib.js": "1".repeat(40) }, ...effects === undefined ? {} : { "effects": effects } });
const runs = parseRuns([
	run("a", "2026-10-01T00:00:00.000Z", "app.js", [{ "capability": "fs:read", "resource": "/workspace/rates.json", "how": "made", "calls": 2 }, { "capability": "net", "resource": "api.example.com", "how": "denied", "calls": 1 }]),
	run("b", "2026-10-03T00:00:00.000Z", "app.js", [{ "capability": "fs:read", "resource": "/workspace/rates.json", "how": "made", "calls": 1 }, { "capability": "fs:write", "resource": "/workspace/out.txt", "how": "skipped", "calls": 4 }]),
	run("c", "2026-10-02T00:00:00.000Z", "tool.js")
].map((each) => JSON.stringify(each)).join("\n"));

// Everything, newest first; the effects added up across runs.
const all = queryRuns(runs);

assert.deepEqual(all.runs.map((each) => each.id), ["b", "c", "a"]);
assert.equal(all.total, 3);
assert.deepEqual(all.effects[0], { "capability": "fs:read", "resource": "/workspace/rates.json", "how": "made", "calls": 3, "runs": 2, "first": "2026-10-01T00:00:00.000Z", "last": "2026-10-03T00:00:00.000Z" });

// By file: an entry, or any file a run ran.
assert.deepEqual(queryRuns(runs, { "file": "tool.js" }).runs.map((each) => each.id), ["c"]);
assert.equal(queryRuns(runs, { "file": "lib.js" }).total, 3);

// By effect: `fs` is fs:read and fs:write; a resource by what it contains; only runs with such an effect, only those effects.
const writes = queryRuns(runs, { "capability": "fs", "how": "skipped" });

assert.deepEqual(writes.runs.map((each) => each.id), ["b"]);
assert.deepEqual(writes.effects.map((each) => each.resource), ["/workspace/out.txt"]);
assert.deepEqual(queryRuns(runs, { "resource": "example.com" }).runs.map((each) => each.id), ["a"]);
assert.equal(queryRuns(runs, { "capability": "fs:rea" }).total, 0, "a capability is matched whole, or as a family");

// Since, and a limit (the rollup is over every run that matched).
assert.deepEqual(queryRuns(runs, { "since": "2026-10-02T00:00:00.000Z" }).runs.map((each) => each.id), ["b", "c"]);

const newest = queryRuns(runs, { "limit": 1 });

assert.deepEqual([newest.total, newest.runs.length, newest.effects.find((each) => each.capability === "net")?.runs], [3, 1, 1]);

console.log("evidence: ok");
