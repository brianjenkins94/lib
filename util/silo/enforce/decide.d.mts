/** Types for the pure decision core (decide.mjs) — see that file for behavior. */

/** Is this scope on BERNARD's catastrophic redline list? (conservative; over-flag = safe). */
export function redline(scope: string): boolean;

/** The JUDICIAL decider: null (unset/"ask" → caller's fallback) or a verdict. Fails closed. */
export function judicial(req: unknown): { "behavior": "allow" | "deny"; "scope"?: string; "message"?: string } | null;
