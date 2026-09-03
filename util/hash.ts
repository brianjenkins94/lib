import { createHash } from "node:crypto";

/** SHA-256 of a string or bytes, as lowercase hex. */
export function sha256(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * The first `length` hex chars of the SHA-256 — a stable short id for filenames and dedup keys where the
 * full digest is noise. 12 chars (48 bits) is plenty for per-repo id spaces; pass more where ids are global.
 */
export function shortHash(input: string | Uint8Array, length = 12): string {
	return sha256(input).slice(0, length);
}
