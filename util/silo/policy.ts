/**
 * silo — the policy layer (pure; ajv its one dependency). Two distinct policies, both extracted from the `silo` prototype:
 *   • CAPABILITY policy (was `policy/capability-policy.ts`) — which capabilities are dangerous enough to gate
 *     on. Governs what code can DO.
 *   • IMPORT policy (was `policy/import-policy.ts`) — a denylist of module specifiers (use my fs wrapper, not
 *     node:fs; never left-pad). Governs what a module may DEPEND ON. `extractImports` is a parser-free import
 *     lister (complements `./detect` `surfaceOfSource`, which is AST-based).
 */

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

// ── Capability policy ────────────────────────────────────────────────────────────────────────────────

/** Capabilities that make a file worth reviewing — the population the trust ratchet measures. `net.ws`/
 *  `net.webrtc` are the browser-preview socket axes: the service-worker net gate can't see them, so a preview
 *  reaching an arbitrary WebSocket/WebRTC endpoint must prompt rather than silently default-allow. */
export const DANGEROUS = new Set(["exec", "eval", "net", "net.ws", "net.webrtc", "fs:write"]);

/** `?` (unanalyzable) IS dangerous — "unknown is untrusted" is silo's whole thesis. */
export const TREAT_UNKNOWN_AS_DANGEROUS = true;

export function isDangerous(cap: string): boolean {
	return DANGEROUS.has(cap) || (TREAT_UNKNOWN_AS_DANGEROUS && cap === "?");
}

// ── Capability-policy RULES (the `.silo/policy.json` engine) ───────────────────────────────────────────
// The rule model over a policy FILE — the base `policy.json` contract plus per-user overrides. No vscode, no node, no
// oxc, so the exact same rules govern the panel's display, the runtime enforcer (the almostnode/SW interceptors'
// decision endpoint), and a pre-armed debugger.
//
// A rule is `{ when, then }`: WHEN the program reaches something (a call, an input, a line) whose facts — the SUBJECT,
// e.g. `{ capability: "fs:write", resource: "/workspace/out.txt" }` — match its rows, THEN do its actions (allow, deny,
// ask; give a value; stop). `when` is stored as rows in ui-predicate's shape (github.com/FGRibreau/ui-predicate, kept
// JSON-compatible): a compound `{ logicalType_id, predicates }` of comparisons `{ target_id, operator_id, argument }`,
// so a rule round-trips with a predicate editor exactly and keeps what was meant (`matches /workspace/**` stays a glob).
// Each row COMPILES to JSON Schema (an operator says what it compiles to), and a rule matches when its subject is valid
// against the compiled schema, by ajv. POLICY_SCHEMA is the file's own JSON Schema, for editors to check and complete
// policy files by hand.

/** A stored decision. `review` is never stored — it's the computed default for an undecided dangerous call. */
export type Disposition = "allow" | "deny";
/** The effective disposition shown in the UI (stored decision, or the computed default). */
export type Effective = Disposition | "review";

/** A JSON Schema (draft 2020-12): an object schema, or `true` / `false`. */
export type Schema = boolean | Record<string, unknown>;

/** What a rule's rows are matched against: the facts where the program is — `capability` and `resource` at a call. */
export type Subject = Record<string, unknown>;

/** One row: a target (a key of the subject; dots reach into it), an operator, and the operator's argument. */
export interface Comparison {
	"target_id": string;
	"operator_id": string;
	"argument"?: unknown;
}

/** How rows combine: every one, any one, or none of them (the predicate editor's all / any / none). */
export type LogicalType = "all" | "any" | "none";

/** Rows combined, and nestable. */
export interface Compound {
	"logicalType_id": LogicalType;
	"predicates": Predicate[];
}

export type Predicate = Comparison | Compound;

/** What to do when a rule matches, with the action's argument (`give`'s value). */
export interface Action {
	"action_id": string;
	"argument"?: unknown;
}

export interface Rule {
	"when": Compound;
	"then": Action[];
	/** ISO timestamp of when this decision was FIRST authorized (a user "Allow always"/"Deny always"). Immutable
	 *  across later disposition flips — it answers "which capabilities did I grant during window X" for a
	 *  retroactive compromise audit. Absent on hand-authored base rules; stamped on silo-written overrides. */
	"added"?: string;
}

export interface Policy {
	"version": number;
	"rules": Rule[];
}

export const EMPTY_POLICY: Policy = { "version": 1, "rules": [] };

const isCompound = (predicate: Predicate): predicate is Compound => "predicates" in predicate;

// ── The catalog: operators and actions ──

const SYNTAX = /[\\^$.*+?()[\]{}|]/gu;
const escape = (text: string): string => text.replace(SYNTAX, "\\$&");

/** A glob as an anchored regular expression: `*` is anything but `/`, `**` anything at all (and with a `/` after it,
 *  any directories, none included), `?` one character but `/`. */
export function globToPattern(glob: string): string {
	let pattern = "";

	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];

		if (char === "*" && glob[index + 1] === "*") {
			const directories = glob[index + 2] === "/";

			pattern += directories ? "(?:.*/)?" : ".*";
			index += directories ? 2 : 1;
		} else if (char === "*") {
			pattern += "[^/]*";
		} else if (char === "?") {
			pattern += "[^/]";
		} else {
			pattern += escape(char);
		}
	}

	return `^${pattern}$`;
}

export interface Operator {
	"label": string;
	/** The schema of the argument it takes, given its target's — what its input is drawn from (`is` takes a value of
	 *  the target's own, `is any of` a list of them, `matches` a glob). */
	"argument": (target: Schema) => Schema;
	/** What a row with it compiles to: the schema its target's value must be valid against. */
	"compile": (argument: unknown) => Schema;
}

const itemsOf = (schema: Schema): Schema => (typeof schema === "object" && schema["items"] !== undefined ? schema["items"] as Schema : true);
const TEXT: Schema = { "type": "string" };
const GLOB: Schema = { "type": "string", "format": "glob" };

/** Every row's operator — "is" and "contains" are on strings, "includes" on arrays; a target's type offers its own. */
export const OPERATORS: Record<string, Operator> = {
	"is": { "label": "is", "argument": (target) => target, "compile": (argument) => ({ "const": argument }) },
	"is_not": { "label": "is not", "argument": (target) => target, "compile": (argument) => ({ "not": { "const": argument } }) },
	"is_any_of": { "label": "is any of", "argument": (target) => ({ "type": "array", "items": target }), "compile": (argument) => ({ "enum": argument }) },
	"starts_with": { "label": "starts with", "argument": () => TEXT, "compile": (argument) => ({ "type": "string", "pattern": `^${escape(argument as string)}` }) },
	"contains": { "label": "contains", "argument": () => TEXT, "compile": (argument) => ({ "type": "string", "pattern": escape(argument as string) }) },
	"matches": { "label": "matches", "argument": () => GLOB, "compile": (argument) => ({ "type": "string", "pattern": globToPattern(argument as string) }) },
	"does_not_match": { "label": "does not match", "argument": () => GLOB, "compile": (argument) => ({ "not": { "type": "string", "pattern": globToPattern(argument as string) } }) },
	"includes": { "label": "includes", "argument": itemsOf, "compile": (argument) => ({ "type": "array", "contains": { "const": argument } }) },
	// The escape hatch: a row whose argument IS the schema, for what the catalog doesn't offer.
	"schema": { "label": "is valid against", "argument": () => ({ "type": ["object", "boolean"] }), "compile": (argument) => argument as Schema }
};

/** Which operators each type of target offers (ui-predicate's types). */
export const TYPES: Record<string, string[]> = {
	"string": ["is", "is_not", "is_any_of", "starts_with", "contains", "matches", "does_not_match", "schema"],
	"array": ["is", "includes", "schema"]
};

export interface Target {
	"label": string;
	"type_id": string;
	/** The schema of the value it is — what `is` takes, and where its examples are. */
	"schema": Schema;
	"description"?: string;
}

/** What a rule can be about: the facts where the program is (ui-predicate's targets) — at a call, its capability and
 *  the resource it reaches; at a run, the program and its arguments. A subject is an object of these. */
export const TARGETS: Record<string, Target> = {
	"capability": { "label": "capability", "type_id": "string", "schema": { "type": "string", "examples": ["fs:read", "fs:write", "net", "net.ws", "exec", "eval", "env"] }, "description": "What a call can do" },
	"resource": { "label": "resource", "type_id": "string", "schema": { "type": "string" }, "description": "What it reaches: a path, a URL, a command" },
	"program": { "label": "program", "type_id": "string", "schema": { "type": "string" }, "description": "The file run, from the workspace root" },
	"process.argv": { "label": "process.argv", "type_id": "array", "schema": { "type": "array", "items": { "type": "string" } }, "description": "The program's arguments" }
};

/** The schema of a row's argument: its operator's, given its target's (a target not in the catalog: any value). */
export function argumentSchema(target_id: string, operator_id: string): Schema | undefined {
	return OPERATORS[operator_id]?.argument(TARGETS[target_id]?.schema ?? true);
}

export interface ActionType {
	"label": string;
	/** The schema of the argument it takes; absent: none. */
	"argument"?: Schema;
}

/** Every rule's action. `allow` / `deny` / `ask` decide a call; `give` answers a read with a value (process.argv's, a
 *  call's result); `set` a variable's; `stop` pauses there. */
export const ACTIONS: Record<string, ActionType> = {
	"allow": { "label": "allow" },
	"deny": { "label": "deny" },
	"ask": { "label": "ask" },
	"give": { "label": "give", "argument": true },
	"set": { "label": "set", "argument": true },
	"stop": { "label": "stop" }
};

// ── Compiling and matching ──

/** One row as a schema of the subject: its target present, and its value valid against what the operator compiles to. */
function compileComparison({ target_id, operator_id, argument }: Comparison): Schema {
	const operator = OPERATORS[operator_id];

	if (operator === undefined) {
		throw new Error(`Unknown operator "${operator_id}"`);
	}

	return target_id.split(".").reduceRight<Schema>((inner, key) => ({ "type": "object", "properties": { [key]: inner }, "required": [key] }), operator.compile(argument));
}

/** Rows as one JSON Schema of the subject. */
export function compileWhen(when: Predicate): Schema {
	if (!isCompound(when)) {
		return compileComparison(when);
	}

	const each = when.predicates.map(compileWhen);

	switch (when.logicalType_id) {
		case "all":
			return each.length === 0 ? true : { "allOf": each };
		case "any":
			return each.length === 0 ? false : { "anyOf": each };
		case "none":
			return each.length === 0 ? true : { "not": { "anyOf": each } };
		default:
			throw new Error(`Unknown logical type "${String(when.logicalType_id)}"`);
	}
}

/** A rule's rows as a standalone JSON Schema — to hand to another tool. */
export function toSchema(rule: Rule): Schema {
	const schema = compileWhen(rule.when);

	return typeof schema === "boolean" ? schema : { "$schema": "https://json-schema.org/draft/2020-12/schema", ...schema };
}

// Strict: a keyword ajv doesn't know is an error, not ignored, so a hand-written schema row is never half-checked.
// `glob` and `date-time` are annotations here.
const ajv = new Ajv2020({ "strictTypes": false });

ajv.addFormat("glob", true);
ajv.addFormat("date-time", true);

/** Each rule's compiled rows, once: the validator, or why they don't compile. */
const compiled = new WeakMap<Rule, ValidateFunction | Error>();

function validatorOf(rule: Rule): ValidateFunction | Error {
	let validator = compiled.get(rule);

	if (validator === undefined) {
		try {
			validator = ajv.compile(compileWhen(rule.when));
		} catch (error) {
			validator = error instanceof Error ? error : new Error(String(error));
		}

		compiled.set(rule, validator);
	}

	return validator;
}

/** Whether a rule's rows match the subject. A rule that doesn't compile (an unknown operator, a schema ajv rejects)
 *  matches nothing — so it can't grant anything; `problemOf` says why. */
export function ruleMatches(rule: Rule, subject: Subject): boolean {
	const validator = validatorOf(rule);

	return !(validator instanceof Error) && validator(subject);
}

/** Why a rule can't be matched (it matches nothing), or undefined. */
export function problemOf(rule: Rule): string | undefined {
	const validator = validatorOf(rule);

	return validator instanceof Error ? validator.message : undefined;
}

/** Parse a policy file's text (`policy.json` or a `<user>.policy.json`), tolerating malformed input (→ empty policy). */
export function parsePolicy(text: string): Policy {
	try {
		const parsed = JSON.parse(text) as Partial<Policy>;

		return { "version": parsed.version ?? 1, "rules": Array.isArray(parsed.rules) ? parsed.rules : [] };
	} catch {
		return { ...EMPTY_POLICY };
	}
}

/** The first rule that matches the subject and has one of `actions` (any action, without), or undefined. */
export function ruleFor(policy: Policy, subject: Subject, actions?: string[]): Rule | undefined {
	return policy.rules.find((rule) => (actions === undefined || rule.then.some(({ action_id }) => actions.includes(action_id))) && ruleMatches(rule, subject));
}

const DECISIONS = ["allow", "deny", "ask"];

/** The effective disposition for a call: the first rule deciding it wins (`ask` → review); otherwise dangerous →
 *  review, safe → allow. */
export function effectiveDisposition(policy: Policy, capability: string, resource: string, dangerous: boolean): Effective {
	const rule = ruleFor(policy, { "capability": capability, "resource": resource }, DECISIONS);

	if (rule !== undefined) {
		const decision = rule.then.find(({ action_id }) => DECISIONS.includes(action_id)).action_id;

		return decision === "ask" ? "review" : decision as Disposition;
	}

	return dangerous ? "review" : "allow";
}

/** The rows a decision made at a call is about: this capability, this resource. */
const callWhen = (capability: string, resource: string): Compound => ({ "logicalType_id": "all", "predicates": [
	{ "target_id": "capability", "operator_id": "is", "argument": capability },
	{ "target_id": "resource", "operator_id": "is", "argument": resource }
] });

const isCall = (capability: string, resource: string) => (rule: Rule): boolean => JSON.stringify(rule.when) === JSON.stringify(callWhen(capability, resource));

/** Return a copy of `policy` with the decision for (capability, resource) set to `disposition` (replacing any made
 *  there before). `added` (an ISO stamp, passed by the caller that owns the clock) records first-authorization: it's
 *  set on a brand-new rule and PRESERVED from the existing rule across a later disposition flip, so it always means
 *  "when I first decided this", not "when I last touched it". A new decision comes first, ahead of broader rules. */
export function withRule(policy: Policy, capability: string, resource: string, disposition: Disposition, added?: string): Policy {
	const index = policy.rules.findIndex(isCall(capability, resource));
	const stamp = policy.rules[index]?.added ?? added;
	const rule: Rule = { "when": callWhen(capability, resource), "then": [{ "action_id": disposition }], ...stamp === undefined ? {} : { "added": stamp } };
	const rules = [...policy.rules];

	if (index === -1) {
		rules.unshift(rule);
	} else {
		rules[index] = rule;
	}

	return { "version": policy.version, "rules": rules };
}

/** Return a copy of `policy` with the decision for (capability, resource) removed (→ back to the computed default). */
export function withoutRule(policy: Policy, capability: string, resource: string): Policy {
	return { "version": policy.version, "rules": policy.rules.filter((rule) => !isCall(capability, resource)(rule)) };
}

// ── The file's schema ──

/** A policy file's JSON Schema — for an editor to check and complete `.silo/policy.json` and `.silo/<you>.policy.json`.
 *  Each operator's and action's argument is checked against its own schema. */
export const POLICY_SCHEMA = {
	"$schema": "https://json-schema.org/draft/2020-12/schema",
	"title": "silo policy",
	"type": "object",
	"properties": {
		"version": { "type": "integer" },
		"rules": { "type": "array", "items": { "$ref": "#/$defs/rule" } }
	},
	"required": ["rules"],
	"$defs": {
		"rule": {
			"type": "object",
			"properties": {
				"when": { "$ref": "#/$defs/compound" },
				"then": { "type": "array", "items": { "$ref": "#/$defs/action" }, "minItems": 1 },
				"added": { "type": "string", "format": "date-time", "description": "When this was first decided." }
			},
			"required": ["when", "then"],
			"additionalProperties": false
		},
		"predicate": { "oneOf": [{ "$ref": "#/$defs/comparison" }, { "$ref": "#/$defs/compound" }] },
		"compound": {
			"type": "object",
			"properties": {
				"logicalType_id": { "enum": ["all", "any", "none"] },
				"predicates": { "type": "array", "items": { "$ref": "#/$defs/predicate" } }
			},
			"required": ["logicalType_id", "predicates"],
			"additionalProperties": false
		},
		"comparison": {
			"type": "object",
			"properties": {
				"target_id": { "type": "string" },
				"operator_id": { "enum": Object.keys(OPERATORS) },
				"argument": true
			},
			"required": ["target_id", "operator_id"],
			"additionalProperties": false,
			"allOf": Object.entries(OPERATORS).map(([id, { argument }]) => ({ "if": { "properties": { "operator_id": { "const": id } } }, "then": { "properties": { "argument": argument(true) }, "required": ["argument"] } }))
		},
		"action": {
			"type": "object",
			"properties": {
				"action_id": { "enum": Object.keys(ACTIONS) },
				"argument": true
			},
			"required": ["action_id"],
			"additionalProperties": false,
			"allOf": Object.entries(ACTIONS).map(([id, { argument }]) => ({ "if": { "properties": { "action_id": { "const": id } } }, "then": argument === undefined ? { "not": { "required": ["argument"] } } : { "properties": { "argument": argument }, "required": ["argument"] } }))
		}
	}
};

const validatePolicyFile = ajv.compile(POLICY_SCHEMA);

/** What's wrong with a policy file's contents against POLICY_SCHEMA, each with where it is; empty when nothing is. */
export function checkPolicy(value: unknown): string[] {
	return validatePolicyFile(value) ? [] : (validatePolicyFile.errors ?? []).map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? ""}`.trim());
}

// ── Import policy ────────────────────────────────────────────────────────────────────────────────────

export interface ImportPolicy {
	"prohibited": Record<string, { "use"?: string; "reason"?: string }>;
}

export interface Violation { "specifier": string; "use"?: string; "reason"?: string }

/** Every module specifier the source imports — static, dynamic, side-effect, and require(). Parser-free
 *  (regex) so it works on any source without an AST; `./detect` `surfaceOfSource` is the AST-based analog. */
export function extractImports(src: string): string[] {
	const out = new Set<string>();
	const add = (re: RegExp) => { for (const m of src.matchAll(re)) { out.add(m[1]); } };

	add(/import\s[^"';]*?from\s*["']([^"']+)["']/gu);   // import … from "x"
	add(/import\s*["']([^"']+)["']/gu);                   // import "x" (side-effect)
	add(/import\s*\(\s*["']([^"']+)["']\s*\)/gu);         // import("x")
	add(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu);      // require("x")

	return [...out];
}

export function checkImports(imports: string[], policy: ImportPolicy): Violation[] {
	return imports.filter((i) => i in policy.prohibited).map((i) => ({ "specifier": i, ...policy.prohibited[i] }));
}
