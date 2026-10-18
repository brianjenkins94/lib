/**
 * Short codes a person types: emailed sign-in codes, codes for an action, recovery codes. Symbols from 32 that can't be
 * misread (no I, O, 0 or 1), shown in two halves (`ABCD-EFGH`), compared whatever the case, dash or spaces. Kept only as
 * an HMAC under a key the store never holds, bound to what the code is for (`bound`: a sign-in attempt, a user's
 * action), so a leaked store can't be guessed at offline and a code works only where it was asked for.
 *
 * Web Crypto only (browsers, Workers, Node), and jose for base64url.
 */

import { base64url } from "jose";
import { isEntry } from "@brianjenkins94/util/env";

/** The 32 symbols: 5 bits each. */
export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A new code, `length` symbols (8 by default: 40 bits). */
export const newCode = (length = 8): string => [...crypto.getRandomValues(new Uint8Array(length))].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");

/** As it's shown and sent: its halves, `ABCD-EFGH`. */
export const shown = (code: string): string => `${code.slice(0, Math.ceil(code.length / 2))}-${code.slice(Math.ceil(code.length / 2))}`;

/** As it's typed, compared: case and the dash and spaces don't matter. */
export const typed = (code: string): string => code.toUpperCase().replaceAll(/[\s-]/gu, "");

/** Whether it's shaped like a code of `length` at all (typed first). */
export const isCode = (code: string, length = 8): boolean => code.length === length && [...code].every((symbol) => ALPHABET.includes(symbol));

/** What's kept of `code`: an HMAC-SHA-256 under `key`, bound to `bound` (base64url). Compare with `same`. */
export async function codeHash(key: string, bound: string, code: string): Promise<string> {
	const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { "name": "HMAC", "hash": "SHA-256" }, false, ["sign"]);

	return base64url.encode(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${bound}:${code}`))));
}

/** Whether two kept hashes are the same, in constant time. */
export function same(given: string, kept: string): boolean {
	const a = new TextEncoder().encode(given);
	const b = new TextEncoder().encode(kept);

	if (a.byteLength !== b.byteLength) {
		return false;
	}

	let difference = 0;

	for (let index = 0; index < a.byteLength; index += 1) {
		difference |= (a[index] as number) ^ (b[index] as number);
	}

	return difference === 0;
}

if (isEntry(import.meta)) {
	const { "default": assert } = await import("node:assert/strict");
	const code = newCode();

	assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/u);
	assert.equal(newCode(10).length, 10);
	assert.equal(shown("ABCDEFGH"), "ABCD-EFGH");
	assert.equal(shown("ABCDEFGHJK"), "ABCDE-FGHJK");
	assert.equal(typed(" abcd-efgh "), "ABCDEFGH");
	assert.equal(isCode(typed("abcd-efgh")), true);
	assert.equal(isCode("ABCD0FGH"), false, "no 0");
	assert.equal(isCode("ABCDEFG"), false, "too short");
	assert.equal(isCode("ABCDEFGHJK", 10), true);

	const kept = await codeHash("a key", "attempt-1", code);

	assert.match(kept, /^[\w-]{43}$/u);
	assert.equal(same(await codeHash("a key", "attempt-1", code), kept), true);
	assert.equal(same(await codeHash("a key", "attempt-2", code), kept), false, "bound to what it's for");
	assert.equal(same(await codeHash("another key", "attempt-1", code), kept), false, "under its key");
	assert.equal(same("short", kept), false);
	console.log("codes: ok");
}
