import { createProxyServer } from "http-proxy-3";
import { Readable } from "stream";

export function createProxy(to) {
	const server = createProxyServer({
		"target": to,
		"changeOrigin": true
	})

	return server.web;
}

const UNSAFE_HEADERS = [
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

    response.status(proxyResponse.status);

    for (const [header, value] of [...proxyResponse.headers].filter(([header]) => !UNSAFE_HEADERS.includes(header))) {
        response.setHeader(header, value);
    }

    if (proxyResponse.body !== undefined) {
        const readable = Readable.fromWeb(proxyResponse.body);

        readable.pipe(response);
    } else {
        response.end()
    }
}
