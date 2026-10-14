/**
 * silo — the policy layer (pure; ajv its one dependency). Two distinct policies, both extracted from the `silo` prototype:
 *   • CAPABILITY policy (was `policy/capability-policy.ts`) — which capabilities are dangerous enough to gate
 *     on. Governs what code can DO.
 *   • IMPORT policy (was `policy/import-policy.ts`) — a denylist of module specifiers (use my fs wrapper, not
 *     node:fs; never left-pad). Governs what a module may DEPEND ON. `extractImports` is a parser-free import
 *     lister (complements `./oxc` `surfaceOfSource`, which is AST-based).
 */

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { isEntry } from "@brianjenkins94/util/env";

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
// skip, ask; give a value; stop). `when` is stored as rows in ui-predicate's shape (github.com/FGRibreau/ui-predicate, kept
// JSON-compatible): a compound `{ logicalType_id, predicates }` of comparisons `{ target_id, operator_id, argument }`,
// so a rule round-trips with a predicate editor exactly and keeps what was meant (`matches /workspace/**` stays a glob).
// Each row COMPILES to JSON Schema (an operator says what it compiles to), and a rule matches when its subject is valid
// against the compiled schema, by ajv. POLICY_SCHEMA is the file's own JSON Schema, for editors to check and complete
// policy files by hand.

/** A stored decision. `skip`: the call isn't made, and the program goes on as if it had done nothing — a debugger's
 *  stand-in answers it (an enforcer with no stand-in to give treats it as `deny`: it isn't made either way). `review`
 *  is never stored — it's the computed default for an undecided dangerous call. */
export type Disposition = "allow" | "deny" | "skip";
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

/** What to do when a rule matches: the action, what it acts on (`give` process.argv), and its argument (what it gives). */
export interface Action {
	"action_id": string;
	"target_id"?: string;
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
	"any": ["is", "is_not", "schema"],
	"string": ["is", "is_not", "is_any_of", "starts_with", "contains", "matches", "does_not_match", "schema"],
	"number": ["is", "is_not", "is_any_of", "schema"],
	"boolean": ["is", "is_not"],
	"array": ["is", "includes", "schema"],
	// A place in the code: one statement, by its span reference (annotations.ts) — the same place, or not.
	"span": ["is"]
};

export interface Target {
	"label": string;
	"type_id": string;
	/** The schema of the value it is — what `is` takes, and where its examples are. */
	"schema": Schema;
	/** What `give` takes for it, when not a list of its values, each a run's (process.argv's): a call's result is one. */
	"given"?: Schema;
	"description"?: string;
}

/** What a rule can be about: the facts where the program is (ui-predicate's targets) — at a call, its capability and
 *  the resource it reaches; at a run, the program and its arguments. A subject is an object of these. */
export const TARGETS: Record<string, Target> = {
	"capability": { "label": "capability", "type_id": "string", "schema": { "type": "string", "examples": ["fs:read", "fs:write", "net", "net.ws", "exec", "eval", "env"] }, "description": "What a call can do" },
	"resource": { "label": "resource", "type_id": "string", "schema": { "type": "string" }, "description": "What it reaches: a path, a URL, a command" },
	"program": { "label": "program", "type_id": "string", "schema": { "type": "string" }, "description": "The file run, from the workspace root" },
	// A package whose code runs: an org's contract trusts one (allow: its calls aren't asked about) or bans one (deny: it
	// doesn't run at all) — packageDisposition — and a call's rows can name the package making it.
	"package": { "label": "package", "type_id": "string", "schema": { "type": "string", "examples": ["lodash", "@scope/name"] }, "description": "The package whose code runs, by name" },
	"version": { "label": "version", "type_id": "string", "schema": { "type": "string" }, "description": "That package's version" },
	// `command-line`: written as you'd type them after `node file.js` (an annotation, for an editor's input).
	"process.argv": { "label": "process.argv", "type_id": "array", "schema": { "type": "array", "items": { "type": "string" }, "format": "command-line" }, "description": "The program's arguments" },
	// `span`: a span reference (annotations.ts SpanRef) — found again through edits, as an authored annotation is. At a
	// stop, the subject's `at` is the reference of a rule placed there; a variable in scope is `variables.<name>` (named
	// per stop, so its host adds it to the catalog).
	"at": { "label": "at", "type_id": "span", "schema": { "type": "object", "format": "span" }, "description": "Where in the code: a statement, followed through edits" },
	// What a call returns, given instead of the call (RULES.md, slice 2): a fetch's body (JSON, or text), a read's
	// contents, a command's output.
	"result": { "label": "result", "type_id": "any", "schema": true, "given": true, "description": "What the call returns: a fetch's body, a read's contents, a command's output" }
};

/** The places a rule is about: each `at is <span reference>` among its rows. */
export function placesOf(rule: Rule): unknown[] {
	const places: unknown[] = [];
	const walk = (predicate: Predicate): void => {
		if ("predicates" in predicate) {
			predicate.predicates.forEach(walk);
		} else if (predicate.target_id === "at" && predicate.operator_id === "is") {
			places.push(predicate.argument);
		}
	};

	walk(rule.when);

	return places;
}

/** The schema of a row's argument: its operator's, given its target's (a target not in the catalog: any value). */
export function argumentSchema(target_id: string, operator_id: string): Schema | undefined {
	return OPERATORS[operator_id]?.argument(TARGETS[target_id]?.schema ?? true);
}

export interface ActionType {
	"label": string;
	/** The targets it can act on; absent: it takes none. (`set`'s — a variable at a stop — are named per stop, so its
	 *  host adds them.) */
	"targets"?: string[];
	/** The schema of the argument it takes, given its target's; absent: none. */
	"argument"?: (target: Schema) => Schema;
}

/** Every rule's action. `allow` / `deny` / `skip` / `ask` decide a call; `give` answers what the program reads —
 *  process.argv — with values of its own, each a run of its own (one value, one run); `set` a variable; `stop` pauses
 *  there. */
export const ACTIONS: Record<string, ActionType> = {
	"allow": { "label": "allow" },
	"deny": { "label": "deny" },
	"skip": { "label": "skip" },
	"ask": { "label": "ask" },
	"give": { "label": "give", "targets": ["process.argv", "result"], "argument": (target) => ({ "type": "array", "items": target, "minItems": 1 }) },
	"set": { "label": "set", "targets": [], "argument": (target) => target },
	"stop": { "label": "stop" }
};

/** The schema of an action's argument, given what it acts on (a target not in the catalog: any value); undefined: it
 *  takes none. */
export function actionSchema(action_id: string, target_id?: string): Schema | undefined {
	const target = TARGETS[target_id ?? ""];

	return action_id === "give" && target?.given !== undefined ? target.given : ACTIONS[action_id]?.argument?.(target?.schema ?? true);
}

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

/** Parse a policy file's text (`policy.json`, or a person's `policy/<user>.json`), tolerating malformed input (→ empty policy). */
export function parsePolicy(text: string): Policy {
	try {
		const parsed = JSON.parse(text) as Partial<Policy>;

		return { "version": parsed.version ?? 1, "rules": Array.isArray(parsed.rules) ? parsed.rules : [] };
	} catch {
		return { ...EMPTY_POLICY };
	}
}

/** What the first rule matching the subject gives `target_id` (process.argv): its values, each a run's — with the rule. */
export function given(policy: Policy, subject: Subject, target_id: string): { "rule": Rule; "values": unknown[] } | undefined {
	for (const rule of policy.rules) {
		const give = rule.then.find((action) => action.action_id === "give" && action.target_id === target_id);

		if (give !== undefined && Array.isArray(give.argument) && ruleMatches(rule, subject)) {
			return { "rule": rule, "values": give.argument };
		}
	}

	return undefined;
}

/** What the first rule matching a call gives as its result (instead of the call): the value, with the rule. */
export function givenResult(policy: Policy, subject: Subject): { "rule": Rule; "value": unknown } | undefined {
	for (const rule of policy.rules) {
		const give = rule.then.find((action) => action.action_id === "give" && action.target_id === "result");

		if (give !== undefined && ruleMatches(rule, subject)) {
			return { "rule": rule, "value": give.argument };
		}
	}

	return undefined;
}

/** The first rule that matches the subject and has one of `actions` (any action, without), or undefined. */
export function ruleFor(policy: Policy, subject: Subject, actions?: string[]): Rule | undefined {
	return policy.rules.find((rule) => (actions === undefined || rule.then.some(({ action_id }) => actions.includes(action_id))) && ruleMatches(rule, subject));
}

const DECISIONS = ["allow", "deny", "skip", "ask"];

/** The effective disposition for a call: the first rule deciding it wins (`ask` → review); otherwise dangerous →
 *  review, safe → allow. `about`: more of what the call is — the package making it (`package`, `version`), so a rule
 *  can be about one package's calls. */
export function effectiveDisposition(policy: Policy, capability: string, resource: string, dangerous: boolean, about: Subject = {}): Effective {
	const rule = ruleFor(policy, { ...about, "capability": capability, "resource": resource }, DECISIONS);

	if (rule !== undefined) {
		const decision = rule.then.find(({ action_id }) => DECISIONS.includes(action_id)).action_id;

		return decision === "ask" ? "review" : decision as Disposition;
	}

	return dangerous ? "review" : "allow";
}

/** What the policy says of a package as a whole — rules about it, not about a call of it: `deny` (it doesn't run at all —
 *  a package an org knows is bad), `allow` (it's trusted: its calls aren't asked about), or undefined (its calls are
 *  decided as they're made). A deny wins over an allow, wherever each is: one person's rule doesn't lift an org's ban. */
export function packageDisposition(policy: Policy, pkg: { "name": string; "version"?: string }): "allow" | "deny" | undefined {
	const subject = { "package": pkg.name, ...pkg.version === undefined ? {} : { "version": pkg.version } };
	// (only rules that name a package: one whose rows are all `none of …` would match any subject that lacks them)
	const names = (predicate: Predicate): boolean => ("predicates" in predicate ? predicate.predicates.some(names) : predicate.target_id === "package");
	const deciding = policy.rules.filter((rule) => names(rule.when) && rule.then.some(({ action_id }) => action_id === "allow" || action_id === "deny") && ruleMatches(rule, subject));

	if (deciding.some((rule) => rule.then.some(({ action_id }) => action_id === "deny"))) {
		return "deny";
	}

	return deciding.length > 0 ? "allow" : undefined;
}

/** The rows a decision made at a call is about: this capability, this resource — and, `about`, more of it (the program
 *  making it, say: an MCP tool's grant is that tool's). */
const callWhen = (capability: string, resource: string, about: Record<string, string> = {}): Compound => ({ "logicalType_id": "all", "predicates": [
	{ "target_id": "capability", "operator_id": "is", "argument": capability },
	{ "target_id": "resource", "operator_id": "is", "argument": resource },
	...Object.entries(about).map(([target_id, argument]) => ({ "target_id": target_id, "operator_id": "is", "argument": argument }))
] });

const isCall = (capability: string, resource: string, about: Record<string, string> = {}) => (rule: Rule): boolean => JSON.stringify(rule.when) === JSON.stringify(callWhen(capability, resource, about));

/** Return a copy of `policy` with the decision for (capability, resource — `about`, more of the call) set to
 *  `disposition` (replacing any made there before). `added` (an ISO stamp, passed by the caller that owns the clock) records first-authorization: it's
 *  set on a brand-new rule and PRESERVED from the existing rule across a later disposition flip, so it always means
 *  "when I first decided this", not "when I last touched it". A new decision comes first, ahead of broader rules. */
export function withRule(policy: Policy, capability: string, resource: string, disposition: Disposition, added?: string, about: Record<string, string> = {}): Policy {
	const index = policy.rules.findIndex(isCall(capability, resource, about));
	const stamp = policy.rules[index]?.added ?? added;
	const rule: Rule = { "when": callWhen(capability, resource, about), "then": [{ "action_id": disposition }], ...stamp === undefined ? {} : { "added": stamp } };
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

/** A policy file's JSON Schema — for an editor to check and complete `.silo/policy.json` and `.silo/policy/<you>.json`.
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
				"target_id": { "type": "string" },
				"argument": true
			},
			"required": ["action_id"],
			"additionalProperties": false,
			"allOf": Object.entries(ACTIONS).map(([id, { targets, argument }]) => ({ "if": { "properties": { "action_id": { "const": id } } }, "then": { "allOf": [
				targets === undefined ? { "not": { "required": ["target_id"] } } : { "required": ["target_id"] },
				argument === undefined ? { "not": { "required": ["argument"] } } : { "properties": { "argument": id === "give" ? true : argument(true) }, "required": ["argument"] }
			] } }))
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
 *  (regex) so it works on any source without an AST; `./oxc` `surfaceOfSource` is the AST-based analog. */
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

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

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

		// A package as a whole: an org bans one (any version, or one), trusts another; a deny wins over an allow; a rule about
		// calls, or one only of `none of …` rows, isn't about a package.
		const packageRule = (rows: Predicate[], action: string): Rule => ({ "when": { "logicalType_id": "all", "predicates": rows }, "then": [{ "action_id": action }] });
		const org: Policy = { "version": 1, "rules": [
			packageRule([{ "target_id": "package", "operator_id": "is", "argument": "lodash" }], "allow"),
			packageRule([{ "target_id": "package", "operator_id": "is", "argument": "evil" }], "deny"),
			packageRule([{ "target_id": "package", "operator_id": "is", "argument": "ua-parser-js" }, { "target_id": "version", "operator_id": "is", "argument": "0.7.29" }], "deny"),
			packageRule([{ "target_id": "package", "operator_id": "is", "argument": "evil" }], "allow"),
			packageRule([{ "target_id": "capability", "operator_id": "is", "argument": "net" }], "allow"),
			{ "when": { "logicalType_id": "none", "predicates": [{ "target_id": "resource", "operator_id": "contains", "argument": ".git/" }] }, "then": [{ "action_id": "allow" }] }
		] };

		assert.equal(packageDisposition(org, { "name": "lodash", "version": "4.17.21" }), "allow");
		assert.equal(packageDisposition(org, { "name": "evil" }), "deny", "a deny wins, wherever the allow is");
		assert.equal(packageDisposition(org, { "name": "ua-parser-js", "version": "0.7.29" }), "deny");
		assert.equal(packageDisposition(org, { "name": "ua-parser-js", "version": "0.7.30" }), undefined);
		assert.equal(packageDisposition(org, { "name": "other", "version": "1.0.0" }), undefined, "rules about calls aren't about a package");
		assert.equal(effectiveDisposition({ "version": 1, "rules": [packageRule([{ "target_id": "package", "operator_id": "is", "argument": "axios" }, { "target_id": "capability", "operator_id": "is", "argument": "net" }], "allow")] }, "net", "https://x", true, { "package": "axios" }), "allow", "a rule about one package's calls");
		assert.equal(effectiveDisposition({ "version": 1, "rules": [packageRule([{ "target_id": "package", "operator_id": "is", "argument": "axios" }, { "target_id": "capability", "operator_id": "is", "argument": "net" }], "allow")] }, "net", "https://x", true), "review", "and not anyone else's");
		assert.equal(ruleMatches({ "when": { "logicalType_id": "any", "predicates": [] }, "then": [{ "action_id": "stop" }] }, {}), false);
		assert.equal(ruleMatches({ "when": { "logicalType_id": "all", "predicates": [] }, "then": [{ "action_id": "stop" }] }, {}), true);
		assert.equal((toSchema(writes) as Record<string, unknown>)["$schema"], "https://json-schema.org/draft/2020-12/schema");

		// First match wins; `ask` is review; a rule without a decision doesn't decide a call; no rule: dangerous → review.
		const argv: Rule = { "when": { "logicalType_id": "all", "predicates": [
			{ "target_id": "program", "operator_id": "matches", "argument": "**/tax.js" },
			{ "target_id": "process.argv", "operator_id": "includes", "argument": "--live" }
		] }, "then": [{ "action_id": "give", "target_id": "process.argv", "argument": [["CA", "SPRING10"]] }] };
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

		// Skip: a decision like the others — stored as its own action, it's what the call gets, ahead of a broader allow; and the
		// policy file's schema takes it.
		decided = withRule(withRule(decided, "fs:write", "/workspace/**", "allow"), "fs:write", "/workspace/out.txt", "skip");
		assert.equal(effectiveDisposition(decided, "fs:write", "/workspace/out.txt", true), "skip");
		assert.deepEqual(decided.rules[0].then, [{ "action_id": "skip" }]);
		assert.deepEqual(checkPolicy(decided), []);
		assert.equal(effectiveDisposition({ "version": 1, "rules": [{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "exec" }] }, "then": [{ "action_id": "skip" }] }] }, "exec", "rm -rf /", true), "skip", "every exec, skipped by one rule");

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

		// give: what the program reads, with values of its own — each a run's.
		const mocked: Rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": "tax.js" }] }, "then": [{ "action_id": "give", "target_id": "process.argv", "argument": [["CA", "SPRING10"], ["FR"]] }] };
		const withMock: Policy = { "version": 1, "rules": [mocked, ...policy.rules] };

		assert.deepEqual(given(withMock, { "program": "tax.js" }, "process.argv"), { "rule": mocked, "values": [["CA", "SPRING10"], ["FR"]] });
		assert.equal(given(withMock, { "program": "other.js" }, "process.argv"), undefined);
		assert.equal(given(withMock, { "program": "tax.js" }, "fetch"), undefined);
		assert.deepEqual(actionSchema("give", "process.argv"), { "type": "array", "items": TARGETS["process.argv"].schema, "minItems": 1 });
		assert.equal(actionSchema("allow"), undefined);
		assert.deepEqual(checkPolicy(withMock), []);
		assert.notDeepEqual(checkPolicy({ "rules": [{ ...mocked, "then": [{ "action_id": "give", "argument": [["x"]] }] }] }), [], "give names its target");
		assert.notDeepEqual(checkPolicy({ "rules": [{ ...mocked, "then": [{ "action_id": "allow", "target_id": "process.argv" }] }] }), [], "allow takes none");

		// A place in the code: at is a span reference; a variable in scope as variables.<name>.
		const place = { "span": "9f3a", "key": "bablr1", "file": "/workspace/tax.js", "shape": { "type": "VariableDeclaration", "atoms": ["const", "rate", "=", "0"] }, "context": {} };
		const setRate: Rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": "tax.js" }, { "target_id": "at", "operator_id": "is", "argument": place }, { "target_id": "variables.country", "operator_id": "is", "argument": "FR" }] }, "then": [{ "action_id": "set", "target_id": "variables.rate", "argument": 0.25 }] };

		assert.deepEqual(placesOf(setRate), [place]);
		assert.equal(ruleMatches(setRate, { "program": "tax.js", "at": structuredClone(place), "variables": { "country": "FR", "rate": 0.2 } }), true);
		assert.equal(ruleMatches(setRate, { "program": "tax.js", "at": { ...place, "span": "other" }, "variables": { "country": "FR" } }), false);
		assert.equal(ruleMatches(setRate, { "program": "tax.js", "at": place, "variables": { "country": "US" } }), false);
		assert.deepEqual(argumentSchema("at", "is"), { "type": "object", "format": "span" });
		assert.deepEqual(checkPolicy({ "rules": [setRate] }), []);

		// A call's result, given instead of the call: one value, not a list of runs.
		const fakeRates: Rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "net" }, { "target_id": "resource", "operator_id": "matches", "argument": "https://api.example.com/**" }] }, "then": [{ "action_id": "give", "target_id": "result", "argument": { "CA": 0.13 } }] };

		assert.deepEqual(givenResult({ "version": 1, "rules": [fakeRates] }, { "capability": "net", "resource": "https://api.example.com/rates" }), { "rule": fakeRates, "value": { "CA": 0.13 } });
		assert.equal(givenResult({ "version": 1, "rules": [fakeRates] }, { "capability": "net", "resource": "https://elsewhere.org/" }), undefined);
		assert.equal(actionSchema("give", "result"), true);
		assert.deepEqual(checkPolicy({ "rules": [fakeRates] }), []);
		assert.equal(effectiveDisposition({ "version": 1, "rules": [fakeRates] }, "net", "https://api.example.com/rates", true), "review", "giving a result decides nothing for a real call");
	})();
}
