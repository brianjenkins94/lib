/**
 * Authenticator-app codes: TOTP (RFC 6238) over HOTP (RFC 4226), as every authenticator app reads an `otpauth://` URI:
 * HMAC-SHA-1, 6 digits, 30-second steps. A code is good for its step or one either side (a clock a little off), and each
 * step once (`last`, the newest step used, is the caller's to keep). Recovery codes are the way in when the app is lost.
 *
 * Web Crypto only (browsers, Workers, Node).
 */

import { ALPHABET } from "@brianjenkins94/util/auth/codes";
import { isEntry } from "@brianjenkins94/util/env";

export const DIGITS = 6;

export const PERIOD = 30;

/** RFC 4648 base32, no padding: what an `otpauth://` URI's secret is written in. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
	let bits = "";

	for (const byte of bytes) {
		bits += byte.toString(2).padStart(8, "0");
	}

	return (bits.match(/.{1,5}/gu) ?? []).map((chunk) => BASE32[Number.parseInt(chunk.padEnd(5, "0"), 2)]).join("");
}

export function unbase32(text: string): Uint8Array<ArrayBuffer> {
	const bits = [...text.toUpperCase().replaceAll(/[\s=]/gu, "")].map((character) => BASE32.indexOf(character).toString(2).padStart(5, "0")).join("");

	return Uint8Array.from(bits.match(/.{8}/gu) ?? [], (byte) => Number.parseInt(byte, 2));
}

/** A new secret: 20 random bytes (160 bits, RFC 4226's recommendation for SHA-1). */
export const newSecret = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(20));

/** HOTP (RFC 4226): the code for `counter`, `digits` long. */
export async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number, digits = DIGITS): Promise<string> {
	const message = new Uint8Array(8);

	new DataView(message.buffer).setBigUint64(0, BigInt(counter));

	const key = await crypto.subtle.importKey("raw", secret, { "name": "HMAC", "hash": "SHA-1" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
	const offset = (mac[mac.length - 1] ?? 0) & 0x0F;
	const binary = new DataView(mac.buffer).getUint32(offset) & 0x7F_FF_FF_FF;

	return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The 30-second step a moment falls in. */
export const stepAt = (now: number): number => Math.floor(now / 1000 / PERIOD);

/** The step `code` belongs to, if it's the code for the step now or one either side, and newer than `last` (each step
 *  is good once); otherwise undefined. */
export async function verifyTotp(secret: Uint8Array<ArrayBuffer>, code: string, now: number, last = -1): Promise<number | undefined> {
	if (!new RegExp(`^\\d{${DIGITS}}$`, "u").test(code)) {
		return undefined;
	}

	const step = stepAt(now);

	for (const candidate of [step - 1, step, step + 1]) {
		if (candidate > last && await hotp(secret, candidate) === code) {
			return candidate;
		}
	}

	return undefined;
}

/** The URI an authenticator app reads from the QR code: `account` at `issuer`. */
export const otpauthUri = (secret: Uint8Array, account: string, issuer: string): string => `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${new URLSearchParams({ "secret": base32(secret), "issuer": issuer, "algorithm": "SHA1", "digits": String(DIGITS), "period": String(PERIOD) })}`;

/** Recovery codes: `count` of them (10), each 10 symbols of util/auth/codes' 32, shown as `ABCDE-FGHJK`: 50 bits apiece. */
export const newRecoveryCodes = (count = 10): string[] => Array.from({ "length": count }, () => {
	const symbols = [...crypto.getRandomValues(new Uint8Array(10))].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");

	return `${symbols.slice(0, 5)}-${symbols.slice(5)}`;
});

/** A recovery code as typed, compared: case, the dash and spaces don't matter. */
export const typedRecovery = (code: string): string => code.toUpperCase().replaceAll(/[\s-]/gu, "");

/** Whether it looks like a recovery code (typed first), not an app's. */
export const isRecoveryCode = (code: string): boolean => /^[A-HJ-NP-Z2-9]{10}$/u.test(code);

if (isEntry(import.meta)) {
	const { "default": assert } = await import("node:assert/strict");
	const rfc = new TextEncoder().encode("12345678901234567890");

	// RFC 6238's SHA-1 test vectors (8 digits).
	for (const [time, code] of [[59, "94287082"], [1_111_111_109, "07081804"], [1_234_567_890, "89005924"], [20_000_000_000, "65353130"]] as const) {
		assert.equal(await hotp(rfc, Math.floor(time / PERIOD), 8), code, String(time));
	}

	const secret = newSecret();
	const now = Date.now();

	assert.deepEqual(unbase32(base32(secret)), secret);
	assert.equal(await verifyTotp(secret, await hotp(secret, stepAt(now)), now), stepAt(now));
	assert.equal(await verifyTotp(secret, await hotp(secret, stepAt(now) + 1), now), stepAt(now) + 1, "a step ahead");
	assert.equal(await verifyTotp(secret, await hotp(secret, stepAt(now) + 2), now), undefined, "two steps ahead");
	assert.equal(await verifyTotp(secret, await hotp(secret, stepAt(now)), now, stepAt(now)), undefined, "each step once");
	assert.match(otpauthUri(secret, "a@example.com", "unusually good"), /^otpauth:\/\/totp\/unusually%20good%3Aa%40example\.com\?secret=[A-Z2-7]{32}&issuer=unusually\+good&algorithm=SHA1&digits=6&period=30$/u);

	const recovery = newRecoveryCodes();

	assert.equal(recovery.length, 10);
	assert.equal(recovery.every((code) => isRecoveryCode(typedRecovery(code))), true);
	assert.equal(isRecoveryCode(typedRecovery("abcde-fghjk")), true);
	assert.equal(isRecoveryCode("123456"), false);
	console.log("totp: ok");
}
