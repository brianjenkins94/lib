/**
 * silo — the policy layer (pure, zero-dep). Two distinct policies, both extracted from the `silo` prototype:
 *   • CAPABILITY policy (was `policy/capability-policy.ts`) — which capabilities are dangerous enough to gate
 *     on. Governs what code can DO.
 *   • IMPORT policy (was `policy/import-policy.ts`) — a denylist of module specifiers (use my fs wrapper, not
 *     node:fs; never left-pad). Governs what a module may DEPEND ON. `extractImports` is a parser-free import
 *     lister (complements `./detect` `surfaceOfSource`, which is AST-based).
 */

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
// The pure rule model over a policy FILE — the base `policy.json` contract plus per-user overrides. No vscode,
// no node, no oxc, so the exact same rules govern the panel's display, the runtime enforcer (the almostnode/SW
// interceptors' decision endpoint), and a pre-armed debugger.

/** A stored decision. `review` is never stored — it's the computed default for an undecided dangerous call. */
export type Disposition = "allow" | "deny";
/** The effective disposition shown in the UI (stored decision, or the computed default). */
export type Effective = Disposition | "review";

export interface Rule {
	"capability": string;
	"resource": string;
	"disposition": Disposition;
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

/** Parse a policy file's text (`policy.json` or a `<user>.policy.json`), tolerating malformed input (→ empty policy). */
export function parsePolicy(text: string): Policy {
	try {
		const parsed = JSON.parse(text) as Partial<Policy>;

		return { "version": parsed.version ?? 1, "rules": Array.isArray(parsed.rules) ? parsed.rules : [] };
	} catch {
		return { ...EMPTY_POLICY };
	}
}

/**
 * Whether a rule's resource matches an actual resource seen at a call. Exact match, OR the actual resource STARTS
 * WITH the rule's (so a `net` rule for `https://api.example.com` covers all its paths, and an `fs:write` rule for
 * `/tmp/` covers everything under it). The panel keys rules on exact observed resources; the runtime sees concrete
 * ones — prefix matching bridges the two without a full glob engine (that's a later refinement).
 */
export function matchesResource(ruleResource: string, actual: string): boolean {
	return actual === ruleResource || (ruleResource !== "" && actual.startsWith(ruleResource));
}

/** The first rule governing (capability, resource), or undefined. */
export function findRule(policy: Policy, capability: string, resource: string): Rule | undefined {
	return policy.rules.find((rule) => rule.capability === capability && matchesResource(rule.resource, resource));
}

/** The effective disposition for a call: an explicit rule wins; otherwise dangerous → review, safe → allow. */
export function effectiveDisposition(policy: Policy, capability: string, resource: string, dangerous: boolean): Effective {
	const rule = findRule(policy, capability, resource);

	if (rule !== undefined) {
		return rule.disposition;
	}

	return dangerous ? "review" : "allow";
}

/** Return a copy of `policy` with the (capability, resource) rule set to `disposition` (replacing any existing).
 *  `added` (an ISO stamp, passed by the caller that owns the clock) records first-authorization: it's set on a
 *  brand-new rule and PRESERVED from the existing rule across a later disposition flip, so it always means "when
 *  I first decided this", not "when I last touched it". */
export function withRule(policy: Policy, capability: string, resource: string, disposition: Disposition, added?: string): Policy {
	const existing = policy.rules.find((rule) => rule.capability === capability && rule.resource === resource);
	const rules = policy.rules.filter((rule) => !(rule.capability === capability && rule.resource === resource));
	const rule: Rule = { "capability": capability, "resource": resource, "disposition": disposition };
	const stamp = existing?.added ?? added;

	if (stamp !== undefined) {
		rule.added = stamp;
	}

	rules.push(rule);
	rules.sort((a, b) => (a.capability + a.resource).localeCompare(b.capability + b.resource));

	return { "version": policy.version, "rules": rules };
}

/** Return a copy of `policy` with any (capability, resource) rule removed (→ back to the computed default). */
export function withoutRule(policy: Policy, capability: string, resource: string): Policy {
	return { "version": policy.version, "rules": policy.rules.filter((rule) => !(rule.capability === capability && rule.resource === resource)) };
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
