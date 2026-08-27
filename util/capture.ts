/**
 * The in-browser analogue of `playwright/capture` (which captures over CDP): monkey-patch `window.fetch`
 * so every request matching a filter is timed and its request/response bodies captured, then handed to a
 * callback. Consumer-specific shaping (path normalization, mode inference, header parsing, delivery) lives
 * in that callback — the raw `input`/`init`/`response` are passed through so it can derive whatever it needs.
 * Browser-only (uses `window`/`performance` at call time; importing the module server-side is inert).
 */

export interface FetchCapture {
	/** The original fetch arguments — so a consumer can inspect request headers, infer a mode, etc. */
	"input": RequestInfo | URL;
	"init"?: RequestInit;
	"method": string;
	"url": string;
	/** HTTP status, or 0 on a network error (see `error`). */
	"status": number;
	/** Round-trip time in milliseconds. */
	"ms": number;
	"requestBody"?: string;
	"responseBody"?: string;
	/** The response (on success) — for reading headers; its body was already cloned for `responseBody`. */
	"response"?: Response;
	/** Present when the fetch itself threw (network error). */
	"error"?: string;
}

export interface InterceptOptions {
	/** Which requests to capture, by URL. Default: all. */
	"filter"?: (url: string) => boolean;
	/** The fetch to wrap. Default: `window.fetch`. */
	"fetch"?: typeof fetch;
}

/**
 * Replace `window.fetch` with a wrapper that invokes `onCapture` for every request whose URL passes
 * `filter`, with timing + request/response bodies. Non-matching requests pass straight through. Returns a
 * restore function that puts the original `window.fetch` back.
 */
export function interceptFetch(onCapture: (capture: FetchCapture) => void, options: InterceptOptions = {}): () => void {
	const original = (options.fetch ?? window.fetch).bind(window);
	const filter = options.filter ?? (() => true);

	window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);

		if (!url || !filter(url)) {
			return original(input, init);
		}

		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		const requestBody = typeof init?.body === "string" ? init.body : undefined;
		const started = performance.now();

		try {
			const response = await original(input, init);
			const ms = Math.round(performance.now() - started);

			// Read the body off a clone so the caller's response is left intact/unconsumed.
			response.clone().text().then(function(responseBody) {
				onCapture({ input, init, method, url, "status": response.status, ms, requestBody, responseBody, response });
			}).catch(function() {
				onCapture({ input, init, method, url, "status": response.status, ms, requestBody, response });
			});

			return response;
		} catch (error) {
			onCapture({ input, init, method, url, "status": 0, "ms": Math.round(performance.now() - started), requestBody, "error": String(error) });

			throw error;
		}
	};

	return function restore() {
		window.fetch = original;
	};
}
