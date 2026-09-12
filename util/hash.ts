/**
 * SHA-256 helpers over the Web Crypto API, so they run in the browser and Node alike (no `node:crypto`).
 * `crypto.subtle.digest` has no synchronous form, so these are async.
 */

/** SHA-256 of a string or bytes, as lowercase hex. */
export async function sha256(input: string | Uint8Array): Promise<string> {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const digest = await crypto.subtle.digest("SHA-256", bytes);

	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The first `length` hex chars of the SHA-256 — a stable short id for filenames and dedup keys where the
 * full digest is noise. 12 chars (48 bits) is plenty for per-repo id spaces; pass more where ids are global.
 */
export async function shortHash(input: string | Uint8Array, length = 12): Promise<string> {
	return (await sha256(input)).slice(0, length);
}
