import { strict as assert } from "node:assert";
import { annotationsPath, evidencePathFor, GITIGNORE, observedCapabilitiesPath, POLICY_GLOB, registryPath, runsPath, userPolicyPath, withLines } from "./layout";

// (Not a self-test in layout.ts: the editor's extensions bundle that module, and a self-test's util/env doesn't load
// there.)

// Each person's files are their own, a folder per kind; machine-only files under local/.
assert.equal(userPolicyPath("Ada L"), ".silo/policy/ada-l.json");
assert.equal(observedCapabilitiesPath(""), ".silo/capabilities/local.json", "no usable name: `local`");
assert.equal(runsPath("ada"), ".silo/runs/ada.jsonl");
assert.equal(runsPath("ada", "local"), ".silo/local/runs/ada.jsonl");
assert.equal(evidencePathFor("ada", "laptop.tsval.chromium-140.macos", "src/a.ts"), ".silo/evidence/ada/laptop.tsval.chromium-140.macos/src/a.ts.jsonl");
assert.equal(annotationsPath("Notes", "ada", "src/a.ts"), ".silo/notes/ada/src/a.ts.jsonl");
assert.equal(registryPath(), ".silo/local/registry.json");
assert.equal(POLICY_GLOB, "**/.silo/{policy.json,policy/*.json}");
assert.ok(GITIGNORE.split("\n").filter(Boolean).every((line) => line === "local/"), "local/ is all .gitignore names");

// Seeding keeps a person's lines and adds only what's missing.
assert.equal(withLines("", GITIGNORE), "local/\n");
assert.equal(withLines("node_modules", GITIGNORE), "node_modules\nlocal/\n");
assert.equal(withLines("local/\n*.log\n", GITIGNORE), undefined, "nothing missing: nothing to write");

console.log("layout: ok");
