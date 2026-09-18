/**
 * Portable capability GATE FLOW — the runtime-agnostic broker, hoisted from the `silo` prototype's
 * enforce/capability-broker.mjs. The prototype broker baked in Node's TTY prompt, spawnSync JUDICIAL, and
 * env allowlists; this is the SAME flow with those three baked-ins pulled out into pluggable seams, so any
 * runtime binds it: the almostnode shims, a service worker's fetch handler, the tsval debugger.
 *
 * The one brain (decide.mjs: redline + judicial) still owns the redline vocabulary; this owns only the
 * ORDER of consultation and the grant/deny control flow:
 *
 *   1. BERNARD redline → break-glass (human-only) or fail CLOSED. Outranks everything; never persisted.
 *   2. grant store → already approved ⇒ pass (TOFU: no re-prompt).
 *   3. decider ("call out to something": a VS Code popup, an external program, an AI) → allow | deny.
 *   4. abstain/null ⇒ deny (fail closed).
 *
 * Pure: no node, no vscode, no process/tty. Transport lives behind `decide`; persistence behind `store`.
 * A Node backend's `decide` can wrap `judicial` from decide.mjs; a browser backend's is an elicitation
 * round-trip — same request/verdict contract either way.
 */
import { redline } from "./decide.mjs";

/** Thrown when a capability is denied — the boundary turns this into the shim's error / a blocked Response. */
export class CapabilityDenied extends Error {
	constructor(scope, reason) {
		super("DENIED " + scope + " — " + reason);
		this.name = "CapabilityDenied";
		this.scope = scope;
	}
}

/**
 * Decide one capability request in silo's fixed order (see the module header). Resolves when the call may
 * proceed; throws `CapabilityDenied` otherwise. Every binding calls exactly this, so the order can't drift.
 */
export async function gate(request, options) {
	const scope = request.scope;

	if (redline(scope)) {
		if (options.breakGlass !== undefined && await options.breakGlass(request)) {
			return; // authorized once by an attentive human; never persisted
		}

		throw new CapabilityDenied(scope, "BERNARD redline");
	}

	if (options.store.has(scope)) {
		return;
	}

	const verdict = await options.decide(request);

	if (verdict !== null && verdict !== undefined && verdict.behavior === "allow") {
		await options.store.grant(verdict.scope ?? scope, verdict.persist === true);

		return;
	}

	throw new CapabilityDenied(scope, (verdict !== null && verdict !== undefined && verdict.message) || "denied");
}
