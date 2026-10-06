import { strict as assert } from "node:assert";
import { argumentSchema, checkPolicy, effectiveDisposition, globToPattern, parsePolicy, problemOf, ruleFor, ruleMatches, TARGETS, toSchema, TYPES, withoutRule, withRule, type Policy, type Rule } from "./policy";

// Globs.
assert.equal(new RegExp(globToPattern("/workspace/**"), "u").test("/workspace/a/b.txt"), true);
assert.equal(new RegExp(globToPattern("/workspace/*.txt"), "u").test("/workspace/a/b.txt"), false);
assert.equal(new RegExp(globToPattern("/workspace/**/b.txt"), "u").test("/workspace/b.txt"), true);
assert.equal(new RegExp(globToPattern("https://api.example.com/v?/*"), "u").test("https://api.example.com/v1/users"), true);
assert.equal(new RegExp(globToPattern("a.(b)+[c]-d"), "u").test("a.(b)+[c]-d"), true);

// Rows: all / any / none, nested.
const writes: Rule = { "when": { "logicalType_id": "all", "predicates": [
	{ "target_id": "capability", "operator_id": "is", "argument": "fs:write" },
	{ "logicalType_id": "any", "predicates": [
		{ "target_id": "resource", "operator_id": "matches", "argument": "/workspace/**" },
		{ "target_id": "resource", "operator_id": "is_any_of", "argument": ["/tmp/a", "/tmp/b"] }
	] },
	{ "logicalType_id": "none", "predicates": [{ "target_id": "resource", "operator_id": "contains", "argument": ".git/" }] }
] }, "then": [{ "action_id": "allow" }] };

assert.equal(ruleMatches(writes, { "capability": "fs:write", "resource": "/workspace/src/a.ts" }), true);
assert.equal(ruleMatches(writes, { "capability": "fs:write", "resource": "/tmp/b" }), true);
assert.equal(ruleMatches(writes, { "capability": "fs:write", "resource": "/workspace/.git/HEAD" }), false);
assert.equal(ruleMatches(writes, { "capability": "fs:read", "resource": "/workspace/src/a.ts" }), false);
assert.equal(ruleMatches(writes, { "capability": "fs:write" }), false); // a target that isn't there doesn't match
assert.equal(ruleMatches({ "when": { "logicalType_id": "any", "predicates": [] }, "then": [{ "action_id": "stop" }] }, {}), false);
assert.equal(ruleMatches({ "when": { "logicalType_id": "all", "predicates": [] }, "then": [{ "action_id": "stop" }] }, {}), true);
assert.equal((toSchema(writes) as Record<string, unknown>)["$schema"], "https://json-schema.org/draft/2020-12/schema");

// First match wins; `ask` is review; a rule without a decision doesn't decide a call; no rule: dangerous → review.
const argv: Rule = { "when": { "logicalType_id": "all", "predicates": [
	{ "target_id": "program", "operator_id": "matches", "argument": "**/tax.js" },
	{ "target_id": "process.argv", "operator_id": "includes", "argument": "--live" }
] }, "then": [{ "action_id": "give", "argument": ["CA", "SPRING10"] }] };
const policy: Policy = { "version": 1, "rules": [
	argv,
	{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "net" }, { "target_id": "resource", "operator_id": "starts_with", "argument": "https://api.example.com/" }] }, "then": [{ "action_id": "allow" }] },
	{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "net" }, { "target_id": "resource", "operator_id": "does_not_match", "argument": "https://*.example.com/**" }] }, "then": [{ "action_id": "ask" }] },
	{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "net" }] }, "then": [{ "action_id": "deny" }] }
] };

assert.equal(effectiveDisposition(policy, "net", "https://api.example.com/v1", true), "allow");
assert.equal(effectiveDisposition(policy, "net", "https://elsewhere.org/", false), "review");
assert.equal(effectiveDisposition(policy, "net", "https://cdn.example.com/x", false), "deny");
assert.equal(effectiveDisposition(policy, "exec", "ls", true), "review");
assert.equal(effectiveDisposition(policy, "fs:read", "/a", false), "allow");
assert.equal(ruleFor(policy, { "program": "/workspace/tax.js", "process": { "argv": ["node", "tax.js", "--live"] } }), argv);
assert.equal(ruleFor(policy, { "program": "/workspace/tax.js", "process": { "argv": ["node", "tax.js"] } }), undefined);
assert.equal(ruleFor(policy, { "program": "/workspace/tax.js", "process": { "argv": ["--live"] } }, ["allow", "deny"]), undefined);

// A rule that can't be matched matches nothing, and says why — an unknown operator, a keyword ajv doesn't know.
const unknown: Rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "resource", "operator_id": "resembles", "argument": "x" }] }, "then": [{ "action_id": "allow" }] };
const misspelt: Rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "resource", "operator_id": "schema", "argument": { "minLenght": 1 } }] }, "then": [{ "action_id": "allow" }] };

assert.equal(ruleMatches(unknown, { "resource": "x" }), false);
assert.match(problemOf(unknown)!, /resembles/u);
assert.equal(ruleMatches(misspelt, { "resource": "x" }), false);
assert.match(problemOf(misspelt)!, /minLenght/u);
assert.equal(problemOf(writes), undefined);
assert.equal(effectiveDisposition({ "version": 1, "rules": [unknown] }, "net", "x", false), "allow");

// The escape hatch takes any JSON Schema.
assert.equal(ruleMatches({ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "resource", "operator_id": "schema", "argument": { "type": "string", "minLength": 2, "maxLength": 3 } }] }, "then": [{ "action_id": "deny" }] }, { "resource": "ab" }), true);

// withRule: a decision at a call is its own rule, first; set again in place; `added` kept across a flip.
let decided: Policy = { "version": 1, "rules": [argv] };

decided = withRule(decided, "net", "https://b.example.com", "allow", "2026-10-06T00:00:00.000Z");
decided = withRule(decided, "net", "https://a.example.com", "deny");
decided = withRule(decided, "net", "https://b.example.com", "deny", "2026-10-07T00:00:00.000Z");
assert.equal(decided.rules.length, 3);
assert.equal(decided.rules[2], argv);
assert.deepEqual(decided.rules[1].then, [{ "action_id": "deny" }]);
assert.equal(decided.rules[1].added, "2026-10-06T00:00:00.000Z");
assert.equal(effectiveDisposition(decided, "net", "https://b.example.com", false), "deny");
assert.equal(effectiveDisposition(decided, "net", "https://b.example.com/x", true), "review"); // exactly this resource
decided = withoutRule(decided, "net", "https://b.example.com");
assert.equal(effectiveDisposition(decided, "net", "https://b.example.com", true), "review");
assert.deepEqual(checkPolicy(decided), []);

// The file's schema: every rule above is valid; malformed ones are said where.
assert.deepEqual(checkPolicy(policy), []);
assert.notDeepEqual(checkPolicy({ "rules": [{ "capability": "net", "resource": "x", "disposition": "allow" }] }), []);
assert.notDeepEqual(checkPolicy({ "rules": [{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "a", "operator_id": "is_any_of", "argument": "x" }] }, "then": [{ "action_id": "allow" }] }] }), []);
assert.notDeepEqual(checkPolicy({ "rules": [{ "when": { "logicalType_id": "all", "predicates": [] }, "then": [{ "action_id": "allow", "argument": 1 }] }] }), []);
assert.notDeepEqual(checkPolicy({ "rules": [{ "when": { "logicalType_id": "all", "predicates": [] }, "then": [{ "action_id": "give" }] }] }), []);
assert.match(checkPolicy({ "rules": [{ "when": { "logicalType_id": "most", "predicates": [] }, "then": [{ "action_id": "stop" }] }] }).join("\n"), /\/rules\/0\/when/u);

// Files read as before.
assert.deepEqual(parsePolicy("not json"), { "version": 1, "rules": [] });
assert.deepEqual(parsePolicy(JSON.stringify(policy)), policy);

// The catalog: a row's argument follows its target.
assert.deepEqual(argumentSchema("resource", "is"), { "type": "string" });
assert.deepEqual(argumentSchema("capability", "is_any_of"), { "type": "array", "items": TARGETS.capability.schema });
assert.deepEqual(argumentSchema("process.argv", "includes"), { "type": "string" });
assert.deepEqual(argumentSchema("resource", "matches"), { "type": "string", "format": "glob" });
assert.equal(argumentSchema("somewhere", "is"), true);
assert.equal(argumentSchema("resource", "resembles"), undefined);

for (const [id, { type_id }] of Object.entries(TARGETS)) {
	assert.ok(TYPES[type_id] !== undefined, `${id}'s type has operators`);
}
