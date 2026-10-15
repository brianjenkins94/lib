/**
 * DPoP (RFC 9449) for a server: the proof a client sends with each request, checked against the request it came with;
 * the thumbprint (RFC 7638) of the key that signed it; stateless server nonces; and access tokens bound to that key
 * (RFC 9068's `at+jwt`, with `cnf.jkt`).
 *
 * It keeps nothing. Whether a proof's `jti` has been seen before is the caller's to answer (`seen`, from whatever store
 * it has), and so is which nonce is current (`nonce`). A failure names the check that failed in `reason`, a fixed string
 * that never quotes the proof, so it can be logged.
 */

import type { JWK, JWTPayload } from "jose";
import { base64url, calculateJwkThumbprint, createLocalJWKSet, decodeProtectedHeader, EmbeddedJWK, importJWK, jwtVerify, SignJWT } from "jose";
import { isEntry } from "@brianjenkins94/util/env";

/** What a proof may be signed with: asymmetric only, since the point is proving a private key. */
export const ALGORITHMS = ["ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "EdDSA"];

/** A JWK's private members; a key in a proof's header carrying any of them is refused. */
const PRIVATE = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/** Seconds a proof's `iat` may be ahead of or behind the server's clock, beyond its age. */
const CLOCK_TOLERANCE = 5;

export interface ProofRequest {
	"method": string;
	/** The request's URL; its query and fragment don't count (RFC 9449 §4.3). */
	"url": string;
	/** The request's `DPoP` header. */
	"proof": string | null | undefined;
	/** At a resource: the access token presented with the proof, whose hash the proof must carry as `ath`. */
	"accessToken"?: string;
	/** The thumbprint the proof's key must have: `dpop_jkt` at a token endpoint, the token's `cnf.jkt` at a resource. */
	"jkt"?: string;
}

export interface ProofPolicy {
	/** Record `jti` (until `expires`, ms), and say whether it was recorded already — a replay. */
	"seen": (jti: string, expires: number) => boolean | Promise<boolean>;
	/** When given, the proof must carry a nonce this accepts; otherwise the failure is `use_dpop_nonce`. */
	"nonce"?: (nonce: string | undefined) => boolean | Promise<boolean>;
	/** How old a proof may be, in seconds. Default 60. */
	"maxAge"?: number;
	/** The clock, in ms. Default `Date.now`. */
	"now"?: () => number;
}

export type ProofResult = { "ok": true; "jkt": string; "jti": string } | { "ok": false; "error": "invalid_dpop_proof" | "use_dpop_nonce"; "reason": string };

const invalid = (reason: string): ProofResult => ({ "ok": false, "error": "invalid_dpop_proof", "reason": reason });

/** base64url(SHA-256(`value`)): a proof's `ath` for an access token. */
export async function accessTokenHash(value: string): Promise<string> {
	return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

/** A URL as `htu` compares it: normalized (scheme and host case, default port, encoding), without query or fragment. */
function target(value: unknown): string | undefined {
	try {
		const url = new URL(String(value));

		url.search = "";
		url.hash = "";

		return url.href;
	} catch {
		return undefined;
	}
}

/** RFC 7638's thumbprint (SHA-256) of a public key. */
export async function thumbprint(jwk: JWK): Promise<string> {
	return calculateJwkThumbprint(jwk, "sha256");
}

/**
 * Check a request's DPoP proof (RFC 9449 §4.3): its header (`typ`, an asymmetric `alg`, a public `jwk`), its signature,
 * its age, that it was made for this method and URL, the access token's hash at a resource, the key it must be bound to,
 * the server's nonce, and — last, so only proofs that passed everything else are recorded — that its `jti` is new.
 */
// eslint-disable-next-line complexity -- RFC 9449's checks, in order, read clearest as one function.
export async function verifyProof(request: ProofRequest, policy: ProofPolicy): Promise<ProofResult> {
	const now = policy.now ?? Date.now;
	const maxAge = policy.maxAge ?? 60;

	if (typeof request.proof !== "string" || request.proof === "" || request.proof.includes(",")) {
		return invalid("missing, or more than one");
	}

	let header: ReturnType<typeof decodeProtectedHeader>;

	try {
		header = decodeProtectedHeader(request.proof);
	} catch {
		return invalid("malformed");
	}

	if (header.typ !== "dpop+jwt") {
		return invalid("typ is not dpop+jwt");
	}

	if (typeof header.alg !== "string" || !ALGORITHMS.includes(header.alg)) {
		return invalid("alg is not an asymmetric one allowed");
	}

	const jwk = header.jwk;

	if (jwk === undefined || typeof jwk !== "object" || jwk.kty === "oct" || PRIVATE.some((member) => member in jwk)) {
		return invalid("jwk is missing or not a public key");
	}

	let payload: JWTPayload;

	try {
		({ payload } = await jwtVerify(request.proof, EmbeddedJWK, {
			"algorithms": ALGORITHMS,
			"typ": "dpop+jwt",
			"currentDate": new Date(now()),
			"maxTokenAge": maxAge,
			"clockTolerance": CLOCK_TOLERANCE
		}));
	} catch (error) {
		// jose's claim failures here are all iat's: missing or ahead of the clock (claim validation), older than maxAge
		// (expired).
		const code = (error as { "code"?: string }).code;

		return invalid(code === "ERR_JWT_CLAIM_VALIDATION_FAILED" || code === "ERR_JWT_EXPIRED" ? "iat is missing, too old, or in the future" : "signature doesn't verify");
	}

	if (payload["htm"] !== request.method) {
		return invalid("htm is not the request's method");
	}

	if (target(payload["htu"]) === undefined || target(payload["htu"]) !== target(request.url)) {
		return invalid("htu is not the request's URL");
	}

	if (typeof payload.jti !== "string" || payload.jti === "") {
		return invalid("jti is missing");
	}

	if (request.accessToken !== undefined && payload["ath"] !== await accessTokenHash(request.accessToken)) {
		return invalid("ath is not the access token's hash");
	}

	const jkt = await thumbprint(jwk);

	if (request.jkt !== undefined && jkt !== request.jkt) {
		return invalid("key is not the one bound");
	}

	if (policy.nonce !== undefined && !await policy.nonce(typeof payload["nonce"] === "string" ? payload["nonce"] : undefined)) {
		return { "ok": false, "error": "use_dpop_nonce", "reason": "nonce is missing or not current" };
	}

	if (await policy.seen(payload.jti, ((payload.iat as number) + maxAge + CLOCK_TOLERANCE) * 1000)) {
		return invalid("jti was seen before");
	}

	return { "ok": true, "jkt": jkt, "jti": payload.jti };
}

/**
 * Server nonces that need no storage: an HMAC of the current time window under `secret`. One is good for its own window
 * and the next, so it lives `window` to 2 × `window` seconds; a client gets a fresh one with every `DPoP-Nonce` header.
 */
export function nonces(secret: string, { window = 300, now = Date.now }: { "window"?: number; "now"?: () => number } = {}): { "issue": () => Promise<string>; "check": (nonce: string | undefined) => Promise<boolean> } {
	const key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { "name": "HMAC", "hash": "SHA-256" }, false, ["sign"]);

	async function nonce(slot: number): Promise<string> {
		const mac = await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(String(slot)));

		return `${slot}.${base64url.encode(new Uint8Array(mac))}`;
	}

	const slot = (): number => Math.floor(now() / 1000 / window);

	return {
		"issue": () => nonce(slot()),
		"check": async (value) => {
			const current = slot();

			// Compared as MACs recomputed here, so only the two windows' own nonces can match.
			return value !== undefined && (value === await nonce(current) || value === await nonce(current - 1));
		}
	};
}

/** A signing key's public half, for a JWKS (`{ keys: [publicKey(key)] }`). */
export function publicKey(key: JWK): JWK {
	return Object.fromEntries(Object.entries(key).filter(([member]) => !PRIVATE.includes(member))) as JWK;
}

export interface AccessTokenClaims {
	"iss": string;
	"aud": string;
	"sub": string;
	/** The thumbprint of the key the token is bound to: what proofs presented with it must be signed with. */
	"jkt": string;
	"clientId": string;
	/** Anything else to carry, e.g. the grant it was issued under. */
	"extra"?: Record<string, string | number | boolean>;
}

/** Sign a DPoP-bound access token (RFC 9068 `at+jwt`, `cnf.jkt`) with `key`, a private JWK with `alg` and `kid`. */
export async function signAccessToken(key: JWK, claims: AccessTokenClaims, { ttl = 300, now = Date.now }: { "ttl"?: number; "now"?: () => number } = {}): Promise<string> {
	if (key.alg === undefined || key.kid === undefined || !ALGORITHMS.includes(key.alg)) {
		throw new TypeError("an access token's key needs an asymmetric alg and a kid");
	}

	const iat = Math.floor(now() / 1000);

	return new SignJWT({ ...claims.extra, "client_id": claims.clientId, "cnf": { "jkt": claims.jkt } })
		.setProtectedHeader({ "typ": "at+jwt", "alg": key.alg, "kid": key.kid })
		.setIssuer(claims.iss)
		.setAudience(claims.aud)
		.setSubject(claims.sub)
		.setIssuedAt(iat)
		.setExpirationTime(iat + ttl)
		.setJti(crypto.randomUUID())
		.sign(await importJWK(key, key.alg));
}

export type AccessTokenResult = { "ok": true; "claims": JWTPayload & { "cnf": { "jkt": string } } } | { "ok": false; "reason": string };

/** Check an access token signed by one of `keys` (public JWKs) for `iss` and `aud`, and that it's bound to a key. */
export async function verifyAccessToken(token: string, keys: JWK[], { iss, aud, now = Date.now }: { "iss": string; "aud": string; "now"?: () => number }): Promise<AccessTokenResult> {
	try {
		const { payload } = await jwtVerify(token, createLocalJWKSet({ "keys": keys }), { "typ": "at+jwt", "algorithms": ALGORITHMS, "issuer": iss, "audience": aud, "currentDate": new Date(now()), "requiredClaims": ["exp", "iat", "sub", "jti"] });
		const cnf = payload["cnf"] as { "jkt"?: unknown } | undefined;

		if (typeof cnf?.jkt !== "string") {
			return { "ok": false, "reason": "not bound to a key" };
		}

		return { "ok": true, "claims": payload as JWTPayload & { "cnf": { "jkt": string } } };
	} catch {
		return { "ok": false, "reason": "signature, issuer, audience or expiry doesn't verify" };
	}
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const { exportJWK, generateKeyPair } = await import("jose");
		const fresh = (): ProofPolicy["seen"] => {
			const recorded = new Set<string>();

			return (jti) => recorded.has(jti) || !recorded.add(jti);
		};

		// RFC 9449's own examples: the token request (Figure 2) and the resource request (Figure 13), at their iat. The
		// key's thumbprint is the cnf.jkt of the RFC's example access token (§6.1).
		const figure2 = "eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19.eyJqdGkiOiItQndDM0VTYzZhY2MybFRjIiwiaHRtIjoiUE9TVCIsImh0dSI6Imh0dHBzOi8vc2VydmVyLmV4YW1wbGUuY29tL3Rva2VuIiwiaWF0IjoxNTYyMjYyNjE2fQ.2-GxA6T8lP4vfrg8v-FdWP0A0zdrj8igiMLvqRMUvwnQg4PtFLbdLXiOSsX0x7NVY-FNyJK70nfbV37xRZT3Lg";
		const figure13 = "eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwieCI6Imw4dEZyaHgtMzR0VjNoUklDUkRZOXpDa0RscEJoRjQyVVFVZldWQVdCRnMiLCJ5IjoiOVZFNGpmX09rX282NHpiVFRsY3VOSmFqSG10NnY5VERWclUwQ2R2R1JEQSIsImNydiI6IlAtMjU2In19.eyJqdGkiOiJlMWozVl9iS2ljOC1MQUVCIiwiaHRtIjoiR0VUIiwiaHR1IjoiaHR0cHM6Ly9yZXNvdXJjZS5leGFtcGxlLm9yZy9wcm90ZWN0ZWRyZXNvdXJjZSIsImlhdCI6MTU2MjI2MjYxOCwiYXRoIjoiZlVIeU8ycjJaM0RaNTNFc05yV0JiMHhXWG9hTnk1OUlpS0NBcWtzbVFFbyJ9.2oW9RP35yRqzhrtNP86L-Ey71EOptxRimPPToA1plemAgR6pxHF8y6-yqyVnmcw6Fy1dqd-jfxSYoMxhAJpLjA";
		const rfcJkt = "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I";

		assert.deepEqual(await verifyProof({ "method": "POST", "url": "https://server.example.com/token", "proof": figure2, "jkt": rfcJkt }, { "seen": fresh(), "now": () => 1562262616_000 }), { "ok": true, "jkt": rfcJkt, "jti": "-BwC3ESc6acc2lTc" });
		assert.equal((await verifyProof({ "method": "GET", "url": "https://resource.example.org/protectedresource", "proof": figure13, "accessToken": "Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU", "jkt": rfcJkt }, { "seen": fresh(), "now": () => 1562262618_000 })).ok, true);

		// Proofs of our own, one property off at a time.
		const { privateKey, publicKey: proofKey } = await generateKeyPair("ES256", { "extractable": true });
		const jwk = await exportJWK(proofKey);
		const jkt = await thumbprint(jwk);
		const url = "https://api.example.com/github/api/user";
		const now = Date.now();
		const proof = async ({ header = {}, claims = {}, key = privateKey as CryptoKey | Uint8Array }: { "header"?: Record<string, unknown>; "claims"?: Record<string, unknown>; "key"?: CryptoKey | Uint8Array } = {}): Promise<string> => new SignJWT({ "htm": "GET", "htu": url, "jti": crypto.randomUUID(), "iat": Math.floor(now / 1000), ...claims })
			.setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk, ...header } as Parameters<SignJWT["setProtectedHeader"]>[0])
			.sign(key);
		const check = async (value: string | undefined, request: Partial<ProofRequest> = {}, policy: Partial<ProofPolicy> = {}): Promise<ProofResult> => verifyProof({ "method": "GET", "url": url, "proof": value, ...request }, { "seen": fresh(), ...policy });
		const reason = async (...args: Parameters<typeof check>): Promise<string | undefined> => {
			const result = await check(...args);

			return "reason" in result ? result.reason : undefined;
		};

		assert.equal((await check(await proof(), { "url": `${url}?page=2#top`, "jkt": jkt })).ok, true, "a query and a fragment don't count");
		assert.equal(await reason(undefined), "missing, or more than one");
		assert.equal(await reason(`${await proof()},${await proof()}`), "missing, or more than one");
		assert.equal(await reason("not.a.jwt"), "malformed");
		assert.equal(await reason(await proof({ "header": { "typ": "JWT" } })), "typ is not dpop+jwt");
		assert.equal(await reason(await proof({ "header": { "jwk": { ...await exportJWK(privateKey) } } })), "jwk is missing or not a public key");
		assert.equal(await reason(await proof({ "header": { "alg": "HS256", "jwk": { "kty": "oct", "k": "c2VjcmV0" } }, "key": new TextEncoder().encode("secret") })), "alg is not an asymmetric one allowed");

		const unsigned = [{ "typ": "dpop+jwt", "alg": "none", "jwk": jwk }, { "htm": "GET", "htu": url, "jti": "x", "iat": Math.floor(now / 1000) }].map((part) => base64url.encode(JSON.stringify(part))).join(".") + ".";

		assert.equal(await reason(unsigned), "alg is not an asymmetric one allowed");

		const other = await exportJWK((await generateKeyPair("ES256", { "extractable": true })).publicKey);

		assert.equal(await reason(await proof({ "header": { "jwk": other } })), "signature doesn't verify", "signed by a key other than the one it carries");
		assert.equal(await reason(await proof({ "claims": { "iat": Math.floor(now / 1000) - 120 } })), "iat is missing, too old, or in the future", "too old");
		assert.equal(await reason(await proof({ "claims": { "iat": Math.floor(now / 1000) + 120 } })), "iat is missing, too old, or in the future");
		assert.equal(await reason(await proof({ "claims": { "htm": "POST" } })), "htm is not the request's method");
		assert.equal(await reason(await proof({ "claims": { "htu": "https://api.example.com/github/api/repos" } })), "htu is not the request's URL");
		assert.equal(await reason(await proof({ "claims": { "htu": "https://evil.example.com/github/api/user" } })), "htu is not the request's URL");
		assert.equal(await reason(await proof({ "claims": { "jti": undefined } })), "jti is missing");
		assert.equal(await reason(await proof(), { "accessToken": "token" }), "ath is not the access token's hash", "no ath at all");
		assert.equal(await reason(await proof({ "claims": { "ath": await accessTokenHash("another token") } }), { "accessToken": "token" }), "ath is not the access token's hash");
		assert.equal((await check(await proof({ "claims": { "ath": await accessTokenHash("token") } }), { "accessToken": "token" })).ok, true);
		assert.equal(await reason(await proof(), { "jkt": await thumbprint(other) }), "key is not the one bound");

		// Replay: the same proof twice against one store.
		const seen = fresh();
		const once = await proof();

		assert.equal((await check(once, {}, { "seen": seen })).ok, true);
		assert.equal(await reason(once, {}, { "seen": seen }), "jti was seen before");

		// Nonces: required → use_dpop_nonce without one or with a stale one; this window's and the last are good.
		let clock = now;
		const server = nonces("a secret for the test", { "window": 300, "now": () => clock });
		const current = await server.issue();

		assert.deepEqual(await check(await proof(), {}, { "nonce": server.check }), { "ok": false, "error": "use_dpop_nonce", "reason": "nonce is missing or not current" });
		assert.equal((await check(await proof({ "claims": { "nonce": current } }), {}, { "nonce": server.check })).ok, true);
		clock += 300_000;
		assert.equal(await server.check(current), true, "the next window still takes it");
		clock += 300_000;
		assert.equal(await server.check(current), false, "two windows on, it's stale");
		assert.equal(await server.check(`${current.split(".")[0]}.${"A".repeat(43)}`), false, "a forged MAC");
		assert.equal(await nonces("another secret", { "now": () => clock }).check(await server.issue()), false, "another server's");
		// A rejected proof records nothing: the same jti passes once the nonce is right.
		const later = await proof({ "claims": { "jti": "retried" } });
		const store = fresh();

		assert.equal((await check(later, {}, { "nonce": server.check, "seen": store })).ok, false);
		assert.equal((await check(await proof({ "claims": { "jti": "retried", "nonce": await server.issue() } }), {}, { "nonce": server.check, "seen": store })).ok, true);

		// Access tokens: bound, typed, issuer and audience, expiry, and only our keys.
		const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "k1" };
		const claims = { "iss": "https://api.example.com", "aud": "https://api.example.com", "sub": "user-1", "jkt": jkt, "clientId": "editor", "extra": { "grant": "g-1" } };
		const token = await signAccessToken(signing, claims);
		const options = { "iss": claims.iss, "aud": claims.aud };
		const verified = await verifyAccessToken(token, [publicKey(signing)], options);

		assert.equal(verified.ok && verified.claims.cnf.jkt, jkt);
		assert.equal(verified.ok && verified.claims["grant"], "g-1");
		assert.equal(publicKey(signing)["d"], undefined);
		assert.equal((await verifyAccessToken(token, [publicKey(signing)], { ...options, "aud": "elsewhere" })).ok, false);
		assert.equal((await verifyAccessToken(token, [publicKey(signing)], { ...options, "now": () => Date.now() + 600_000 })).ok, false, "expired");
		assert.equal((await verifyAccessToken(token, [{ ...publicKey({ ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256" }), "kid": "k1" }], options)).ok, false, "another key with its kid");
		assert.equal((await verifyAccessToken(await proof(), [publicKey(signing)], options)).ok, false, "a DPoP proof isn't an access token");
		const untyped = await new SignJWT({ "client_id": "editor", "cnf": { "jkt": jkt } }).setProtectedHeader({ "typ": "JWT", "alg": "ES256", "kid": "k1" }).setIssuer(claims.iss).setAudience(claims.aud).setSubject("user-1").setIssuedAt().setExpirationTime("5m").setJti("j").sign(await importJWK(signing, "ES256"));

		assert.equal((await verifyAccessToken(untyped, [publicKey(signing)], options)).ok, false, "our key, but not typed at+jwt");
		await assert.rejects(signAccessToken({ ...signing, "alg": "HS256" }, claims), TypeError);
	})();
}
