// Retry policy: the default "retry idempotent GETs" predicate, and a backoff strategy that turns a
// failed request into a delay (honoring Rate-Limit-After/Reset headers, capped at 2 tries) or
// undefined to give up — shaped as a Bottleneck retryHandler: `(error, info) => ms | undefined`.

export const defaultRetry = ({ method }) => method.toLowerCase() === "get";

export function backoff(retry) {
	return function(error, { retryCount }) {
		const { request, response } = error;

		// Not a fido-shaped HTTP error (e.g. a network rejection)
		if (request === undefined || response === undefined) {
			return undefined;
		}

		if (retry === false || (typeof retry === "function" && retry({ "method": request.method }) === false)) {
			return undefined;
		}

		let [header, reset] = [...response.headers].find(([header]) => /Rate-Limit-(After|Reset)/ui.test(header)) ?? [];

		reset *= 1000;

		if (reset >= Date.now()) {
			reset -= Date.now();
		}

		if (retryCount < 2) {
			const jitter = Math.floor(Math.random() * 500);

			return (reset || (2 ** (retryCount + 1)) * 1000) + jitter;
		} else {
			return undefined;
		}
	};
}
