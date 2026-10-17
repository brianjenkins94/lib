import { Readable } from "node:stream";

/** An http-proxy-3 handler for `to`. Imported when called, so `proxy` and `pipeResponse` don't need http-proxy-3. */
export async function createProxy(to) {
	const { createProxyServer } = await import("http-proxy-3");
	const server = createProxyServer({
		"target": to,
		"changeOrigin": true
	});

	return server.web;
}

export const UNSAFE_HEADERS = [
	"connection",
	"content-encoding", // Not unsafe, but Node.js fetch (undici) always decodes the response.
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade"
];

export interface ProxyOptions {
	/** What sends the request upstream: `fetch` by default, or anything shaped like it (a test harness's dispatcher). */
	"fetch"?: (request: Request) => Promise<Response>;
	/** Where to: the incoming request's URL by default. */
	"to"?: string;
	/** Headers to set on the way through, over the incoming ones (a client address an upstream expects, say). */
	"headers"?: Record<string, string>;
	/** `"manual"` passes the upstream's redirects back to the client as they are; by default they're followed. */
	"redirect"?: RequestRedirect;
}

/** Forward a Node `IncomingMessage` upstream and stream the answer back onto `response` (Express or plain Node). */
export async function proxy(request, response, { "fetch": send = fetch, "to": to = request.url, "headers": extra = {}, "redirect": redirect }: ProxyOptions = {}) {
	const proxyResponse = await send(new Request(to, {
		"method": request.method,
		"headers": new Headers(Object.entries<string>({
			...request.headers,
			"accept-encoding": "identity",
			...extra
		}).filter(([header]) => !UNSAFE_HEADERS.includes(header))),
		"body": request.method === "GET" || request.method === "HEAD" ? undefined : request,
		...redirect === undefined ? {} : { "redirect": redirect },
		// @ts-expect-error
		"duplex": "half"
	}));

	pipeResponse(response, proxyResponse);
}

/**
 * Copy an upstream fetch `Response` onto a response, Express's or plain Node's `ServerResponse`: status, every header
 * not in `UNSAFE_HEADERS`, then stream the body. The tail of `proxy()`, exported so a route that obtains its upstream
 * Response some other way (a fido client, say) finishes exactly the way the proxy does.
 */
export function pipeResponse(response, upstream: Response): void {
	if (typeof response.status === "function") {
		response.status(upstream.status);
	} else {
		response.statusCode = upstream.status;
	}

	for (const [header, value] of [...upstream.headers].filter(([header]) => !UNSAFE_HEADERS.includes(header))) {
		response.setHeader(header, value);
	}

	// A bodiless upstream (204/304, HEAD) has `body === null`, not undefined.
	if (upstream.body === null) {
		response.end();
	} else {
		Readable.fromWeb(upstream.body).pipe(response);
	}
}
