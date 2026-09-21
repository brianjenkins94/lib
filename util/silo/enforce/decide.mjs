/**
 * Shared DECISION CORE for every enforcement backend (the in-process broker, the --import preload,
 * the Deno permission-broker, and — via ./broker — the browser/almostnode bindings). One brain so the
 * redline list + JUDICIAL contract can't drift.
 *
 *   redline(scope)  — is this scope on BERNARD's catastrophic list? (conservative; over-flag = safe)
 *   judicial(req)   — the JUDICIAL decider: null (unset/"ask" → caller's fallback) | { behavior, scope?, message? }
 *
 * bernard's human break-glass challenge + the allowlist *source* stay per-backend (each owns its TTY
 * and its grant store). Kept PORTABLE: no static node import and every `process` access is guarded, so
 * this loads unchanged in the browser / a service worker (where `redline` still runs; `judicial` sees no
 * JUDICIAL env → returns null → the caller's own decider decides). The command-judge branch uses
 * getBuiltinModule (sync, Node-only, and bypasses the box's node:child_process rewrite — same reason the
 * old createRequire did).
 */

// Guarded so module load never throws off-Node (no `process`); an empty env means no BERNARD extras and
// an unset JUDICIAL, i.e. "ask" — exactly the browser default (fall through to the injected decider).
const ENV = (typeof process !== "undefined" && process.env) ? process.env : {};

// SECRETS — redlined on READ as well as write. The old list guarded only `fs:write`, which is backwards:
// writing to ~/.ssh is vandalism; READING it is theft, and reading is the actual exfiltration vector.
//
// This is also why it's a REDLINE and not an allowlist prompt. "Allow read of ~/.ssh/id_rsa?" is exactly
// the prompt a tired human waves through at 6pm — so the things that matter most must not be promptable.
// Redlined scopes go to the break-glass challenge, never to the routine grant path.
const SECRET = String.raw`(?:\.(?:ssh|aws|gnupg|kube|docker|netrc|npmrc|git-credentials)\b`
	+ String.raw`|\.env(?:\.[\w-]+)?$`
	+ String.raw`|\.config/(?:gh|gcloud|doctl)\b`
	+ String.raw`|Library/Keychains/`
	+ String.raw`|id_(?:rsa|dsa|ecdsa|ed25519)\b`
	+ String.raw`|[^/]+\.(?:pem|key|p12|pfx|keystore)$)`;

const REDLINE = [
	new RegExp(String.raw`^fs:(read|write):.*/${SECRET}`),            // credentials & private keys — READ included
	/^fs:write:.*\/\.git\//,                                          // git internals
	/^fs:write:\/(etc|bin|sbin|usr|boot|dev|System|Library)\//,       // system dirs
	/^exec:.*(dd|mkfs|fdisk|shutdown|reboot|halt|sh|bash|zsh|curl|wget|nc|ncat|rm)(\.\w+)?$/, // dangerous bins
	/^net:\*/,                                                        // indeterminate host
	/^net\.(ws|webrtc):\*/,                                           // indeterminate WebSocket/WebRTC endpoint
	/^eval\b/,                                                        // dynamic code
	// The deployment's own policy seam — comma-separated regexes, appended to the defaults.
	...(ENV.BERNARD ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(s))
];

export const redline = (scope) => REDLINE.some((re) => re.test(scope));

export function judicial(req) {
	const J = ENV.JUDICIAL;

	if (!J || J === "ask") { return null; }                              // caller falls back (its own decider / deny)
	if (J === "allow") { return { "behavior": "allow" }; }
	if (J === "deny") { return { "behavior": "deny", "message": "JUDICIAL=deny" }; }
	try {
		// getBuiltinModule: sync, Node-only, and bypasses the box's node:child_process rewrite so a judge can't be
		// gated by the very policy it enforces. Absent (non-Node) → throws → fail closed below.
		const { spawnSync } = globalThis.process.getBuiltinModule("node:child_process");
		const r = spawnSync(J, { "input": JSON.stringify(req), "encoding": "utf8", "shell": true });
		const v = JSON.parse((r.stdout || "").trim().split("\n").pop() || "{}");

		return v.behavior ? v : { "behavior": "deny", "message": "JUDICIAL: no verdict" };
	} catch (e) {
		return { "behavior": "deny", "message": "JUDICIAL error (fail closed): " + e.message };
	}
}
