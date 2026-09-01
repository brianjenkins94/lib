// Cursor/pagination polling: follow an RFC 5988 `Link: rel=next` header or a `?page=N` counter,
// calling the fido instance's own get/post/etc. (via `this[method]`, bound in withDefaults) until a
// page condition says stop. Extracted from fido's core — no imports.

function nextPageUrl(request, response, body, collected) {
	const link = response.headers.get("link");

	if (typeof link === "string") {
		const next = /<([^>]+)>\s*;\s*rel="?next"?/iu.exec(link);

		if (next !== null) {
			// The Link target may be a relative URI-reference (RFC 5988) — resolve it against this page's URL,
			// or `new Request(next, …)` in the caller throws on a non-absolute URL.
			return new URL(next[1], request.url).toString();
		}
	}

	if (typeof body["totalCount"] === "number" && collected < body["totalCount"]) {
		const url = new URL(request.url);

		url.searchParams.set("page", String(Number(url.searchParams.get("page") ?? "1") + 1));

		return url.toString();
	}
}

export async function defaultConditionCallback(accumulator, { request, response }, callCount) {
	const body = await response.json();

	const items = Array.isArray(body) ? body : body["items"];

	if (!Array.isArray(items) || items.length === 0) {
		return accumulator;
	}

	accumulator.push(...items);

	const next = nextPageUrl(request, response, body, accumulator.length);

	return next === undefined
		? accumulator
		: new Request(next, { "headers": request["headers"], "body": request["body"] });
}

export async function poll(url, query, { conditionCallback = defaultConditionCallback, initialValue = [], ...options }) {
	if (typeof url === "string") {
		url = new URL(url);
	}

	url.search = new URLSearchParams([
		...new URLSearchParams(url.search),
		...Object.entries(query)
	]).toString();

	const currentValue = initialValue;

	let request = new Request(url.toString(), {
		"method": options["method"] ?? "GET",
		"headers": options["headers"],
		"body": options["body"]
	});

	for (let callCount = 1; request instanceof Request; callCount++) {
		const response = await this[request.method.toLowerCase()](request);

		request = await conditionCallback(currentValue, { "request": request, "response": response }, callCount);
	}

	return request;
}
