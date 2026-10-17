/**
 * Sealing a secret at rest: AES-GCM under a key-encryption key (32 random bytes, base64url), bound to `context` as
 * additional data, so a value sealed for one thing (a grant, a user) won't open as another's. Sealed as
 * `v1.<iv>.<ciphertext>`: the version names the key, so it can rotate.
 *
 * Web Crypto only (browsers, Workers, Node), and jose for base64url.
 */

import { base64url } from "jose";
import { isEntry } from "@brianjenkins94/util/env";

function key(kek: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", base64url.decode(kek), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `plaintext` sealed under `kek` for `context`. */
export async function seal(kek: string, plaintext: string, context: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt({ "name": "AES-GCM", "iv": iv, "additionalData": new TextEncoder().encode(context) }, await key(kek), new TextEncoder().encode(plaintext));

	return `v1.${base64url.encode(iv)}.${base64url.encode(new Uint8Array(sealed))}`;
}

/** What `seal` sealed under `kek` for `context`; throws for anything else (another key, another context, tampering). */
export async function open(kek: string, sealed: string, context: string): Promise<string> {
	const [version, iv, ciphertext] = sealed.split(".");

	if (version !== "v1" || iv === undefined || ciphertext === undefined) {
		throw new TypeError("not a value this key sealed");
	}

	const plaintext = await crypto.subtle.decrypt({ "name": "AES-GCM", "iv": base64url.decode(iv), "additionalData": new TextEncoder().encode(context) }, await key(kek), base64url.decode(ciphertext));

	return new TextDecoder().decode(plaintext);
}

if (isEntry(import.meta)) {
	const { "default": assert } = await import("node:assert/strict");
	const kek = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const sealed = await seal(kek, "a secret", "grant-1");

	assert.match(sealed, /^v1\.[\w-]{16}\.[\w-]+$/u);
	assert.equal(sealed.includes("a secret"), false);
	assert.equal(await open(kek, sealed, "grant-1"), "a secret");
	assert.notEqual(await seal(kek, "a secret", "grant-1"), sealed, "a fresh iv each time");
	await assert.rejects(open(kek, sealed, "grant-2"), "another context");
	await assert.rejects(open(base64url.encode(crypto.getRandomValues(new Uint8Array(32))), sealed, "grant-1"), "another key");
	await assert.rejects(open(kek, `${sealed.slice(0, -2)}AA`, "grant-1"), "tampered");
	await assert.rejects(open(kek, "v2.x.y", "grant-1"), TypeError);
	console.log("seal: ok");
}
