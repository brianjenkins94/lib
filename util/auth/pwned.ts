/**
 * Whether a password is in a known breach: Have I Been Pwned's Pwned Passwords range API, by k-anonymity (only the first
 * 5 hex characters of the password's SHA-1 leave; the answer is every suffix with that prefix, padded so its size says
 * nothing either). Pilcrow's and NIST's advice: refuse passwords known to be breached.
 *
 * Web Crypto and fetch only (browsers, Workers, Node).
 */

import { isEntry } from "@brianjenkins94/util/env";

/** How many known breaches have `password`; undefined if the API couldn't be asked (refuse then: fail closed).
 *  `api` and `fetch` are for a stand-in in tests. */
export async function breaches(password: string, { api = "https://api.pwnedpasswords.com", userAgent = "@brianjenkins94/util", fetch: fetching = fetch }: { "api"?: string; "userAgent"?: string; "fetch"?: typeof fetch } = {}): Promise<number | undefined> {
	const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password)))].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
	const response = await fetching(`${api}/range/${digest.slice(0, 5)}`, { "headers": { "add-padding": "true", "user-agent": userAgent } }).catch(() => undefined);

	if (response?.ok !== true) {
		return undefined;
	}

	const line = (await response.text()).split("\n").find((entry) => entry.startsWith(`${digest.slice(5)}:`));

	return line === undefined ? 0 : Number.parseInt(line.split(":")[1] ?? "0", 10);
}

if (isEntry(import.meta)) {
	const { "default": assert } = await import("node:assert/strict");
	// "password": SHA-1 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.
	const asked: string[] = [];
	const standIn = (async (url: string | URL | Request) => {
		asked.push(String(url));

		return new Response("1E4C9B93F3F0682250B6CF8331B7EE68FD8:42\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0");
	}) as typeof fetch;

	assert.equal(await breaches("password", { "api": "https://pwned.test", "fetch": standIn }), 42);
	assert.deepEqual(asked, ["https://pwned.test/range/5BAA6"], "only the prefix leaves");
	assert.equal(await breaches("correct horse battery staple", { "fetch": standIn }), 0);
	assert.equal(await breaches("password", { "fetch": (async () => new Response("", { "status": 503 })) as typeof fetch }), undefined);
	assert.equal(await breaches("password", { "fetch": (async () => { throw new TypeError("offline"); }) as typeof fetch }), undefined);
	console.log("pwned: ok");
}
