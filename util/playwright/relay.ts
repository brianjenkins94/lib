/**
 * Relay a page's WebSocket to another server: every socket the page opens to a URL matching `pattern` is answered by
 * a socket from here to `url` — e.g. a page's dev-tool connection, sent to a test's own instance instead of whatever
 * runs on the developer's machine. Messages the page sends before the upstream is open are queued, not lost; either
 * side closing closes the other.
 */
import type { BrowserContext } from "playwright";

export async function relayWebSocket(context: BrowserContext, pattern: RegExp | string, url: string): Promise<void> {
	await context.routeWebSocket(pattern, (route) => {
		const upstream = new WebSocket(url);
		const queued: (string | Buffer)[] = [];

		upstream.addEventListener("open", () => {
			for (const message of queued.splice(0)) {
				upstream.send(message);
			}
		});
		upstream.addEventListener("message", (event) => { route.send(event.data as string); });
		upstream.addEventListener("close", () => { void route.close(); });
		route.onMessage((message) => {
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.send(message);
			} else {
				queued.push(message);
			}
		});
		route.onClose(() => { upstream.close(); });
	});
}
