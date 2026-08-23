import type { BrowserContext, Response } from "playwright";
import type { Observation } from "../discovery/accumulate.js";

// This CDP adapter emits the pipeline's native `Observation` (see ../discovery/accumulate) directly, so a
// consumer can feed capture straight into accumulate() with no per-consumer field rename in between.

/**
 * Normalize a URL to a stable PATH pattern — drop the origin and query string, collapse volatile
 * segments (long call ids, UUIDs, numeric ids) — so repeated hits on one endpoint (including different
 * query values) dedupe to a single pattern. Query params are captured separately (see startCapture).
 *
 * ANY standalone all-digit segment is treated as an id (`/partners/2` and `/partners/11` both →
 * `/partners/ID`) — without this, short numeric ids fragment into a distinct pattern (and tool) per id.
 * `\b` keeps digits fused to letters intact, so version-like segments (`v1`, `v2`, `oauth2`) are NOT ids.
 */
export function urlPattern(url: string): string {
	return url
		.replace(/https?:\/\/[^/]+/u, "")
		.replace(/\?.*$/u, "")
		.replace(/\b\d{15,}\b/gu, "CALL_ID")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "UUID")
		.replace(/\b\d+\b/gu, "ID");
}

/** Parse a URL's query string into a plain object (undefined when there is none). */
function parseQuery(url: string): Record<string, string> | undefined {
	const index = url.indexOf("?");

	if (index === -1) {
		return undefined;
	}

	const entries = [...new URLSearchParams(url.slice(index + 1)).entries()];

	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** True if a body looks like real data worth surfacing — filters trivial ack/ping responses. */
export function isRichBody(body: unknown): boolean {
	if (body === null || typeof body !== "object") {
		return false;
	}

	if (Array.isArray(body)) {
		return body.length > 0;
	}

	const entries = Object.entries(body as Record<string, unknown>);

	if (entries.length >= 3) {
		return true;
	}

	return entries.some(([, value]) => value !== null && typeof value === "object");
}

/** A URL filter matching the registered domain of `baseUrl` (e.g. anything on *.partstech.com). */
export function domainFilter(baseUrl: string): (url: string) => boolean {
	const registered = new URL(baseUrl).hostname.split(".").slice(-2).join(".");

	return (url) => {
		try {
			return new URL(url).hostname.endsWith(registered);
		} catch {
			return false;
		}
	};
}

/**
 * Passively record JSON API responses on a browser context. Each matching response is pushed to
 * `captured` and handed to `onCapture` (if given) — so a consumer can dedupe into its own store live,
 * as the page is driven by an agent OR by a human. Returns `stop()` to detach the listener.
 */
export function startCapture(
	context: BrowserContext,
	filter: (url: string) => boolean,
	onCapture?: (observation: Observation) => void
): { "captured": Observation[]; "stop": () => void } {
	const captured: Observation[] = [];

	async function onResponse(response: Response): Promise<void> {
		const url = response.url();

		if (!filter(url)) {
			return;
		}

		if (!(response.headers()["content-type"] ?? "").includes("application/json")) {
			return;
		}

		try {
			const postData = response.request().postData();
			let requestBody: unknown;

			if (postData !== null) {
				try { requestBody = JSON.parse(postData); } catch { requestBody = postData; }
			}

			const record: Observation = {
				"method": response.request().method(),
				"path": url,
				"pathPattern": urlPattern(url),
				"status": response.status(),
				"query": parseQuery(url),
				"link": response.headers()["link"],
				"requestBody": requestBody,
				"responseBody": await response.json()
			};

			captured.push(record);
			onCapture?.(record);
		} catch {
			// Body wasn't JSON-parseable — skip it.
		}
	}

	context.on("response", onResponse);

	return { "captured": captured, "stop": () => { context.off("response", onResponse); } };
}
