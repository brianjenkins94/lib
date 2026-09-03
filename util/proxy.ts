import { Readable } from "node:stream";
import { createProxyServer } from "http-proxy-3";

export function createProxy(to) {
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

export async function proxy(request, response, options = { "fetch": fetch, "to": request.url }) {
	const { fetch, to } = options;

	const proxyResponse = await fetch(new Request(to, {
		"method": request.method,
		"headers": new Headers(Object.entries<string>({
			...request.headers,
			"accept-encoding": "identity"
		}).filter(([header]) => !UNSAFE_HEADERS.includes(header))),
		"body": request.method === "GET" || request.method === "HEAD" ? undefined : request,
		// @ts-expect-error
		"duplex": "half"
	}));

	pipeResponse(response, proxyResponse);
}

/**
 * Copy an upstream fetch `Response` onto an Express-style response: status, every header not in
 * `UNSAFE_HEADERS`, then stream the body. The tail of `proxy()`, exported so a route that obtains its
 * upstream Response some other way (a fido client, say) finishes exactly the way the proxy does.
 */
export function pipeResponse(response, upstream: Response): void {
	response.status(upstream.status);

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
