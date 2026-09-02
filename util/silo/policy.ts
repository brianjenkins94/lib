/**
 * silo — the policy layer (pure, zero-dep). Two distinct policies, both extracted from the `silo` prototype:
 *   • CAPABILITY policy (was `policy/capability-policy.ts`) — which capabilities are dangerous enough to gate
 *     on. Governs what code can DO.
 *   • IMPORT policy (was `policy/import-policy.ts`) — a denylist of module specifiers (use my fs wrapper, not
 *     node:fs; never left-pad). Governs what a module may DEPEND ON. `extractImports` is a parser-free import
 *     lister (complements `./detect` `surfaceOfSource`, which is AST-based).
 */

// ── Capability policy ────────────────────────────────────────────────────────────────────────────────

/** Capabilities that make a file worth reviewing — the population the trust ratchet measures. */
export const DANGEROUS = new Set(["exec", "eval", "net", "fs:write"]);

/** `?` (unanalyzable) IS dangerous — "unknown is untrusted" is silo's whole thesis. */
export const TREAT_UNKNOWN_AS_DANGEROUS = true;

export function isDangerous(cap: string): boolean {
	return DANGEROUS.has(cap) || (TREAT_UNKNOWN_AS_DANGEROUS && cap === "?");
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
