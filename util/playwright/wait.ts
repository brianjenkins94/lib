import type { Page } from "playwright-chromium";

import { sleep } from "../sleep";

export function waitForNavigation(page: Page, targetUrl, options = { "timeout": 30_000 }) {
	if (options["timeout"] === 0) {
		return new Promise<void>(function recurse(resolve, reject) {
			console.log("Waiting for navigation...");

			setTimeout(function() {
				if (page.url().startsWith(targetUrl)) {
					console.log("Navigation success!");

					resolve();
				} else {
					recurse(resolve, reject);
				}
			}, 2000);
		});
	}

	return Promise.race([
		waitForNavigation(page, targetUrl, {
			"timeout": 0
		}),
		new Promise(async function(resolve, reject) {
			await sleep(options.timeout);

			reject(new Error("Timeout!"));
		})
	]);
}

function waitForDOMContentIdle(page: Page) {
	return page.evaluate(function() {
		return new Promise<void>(function(resolve, reject) {
			let timeoutId = setTimeout(function() {
				mutationObserver.disconnect();

				resolve();
			}, 500);

			const mutationObserver = new MutationObserver(function(mutations, observer) {
				console.log("Mutation!");

				clearTimeout(timeoutId);

				timeoutId = setTimeout(function() {
					mutationObserver.disconnect();

					resolve();
				}, 500);
			});

			mutationObserver.observe(document.body, { "attributes": true, "childList": true, "subtree": true });
		});
	});
}

export function waitForNetworkIdle(page: Page, options = {}) {
	return Promise.race([
		// Wait for network idle only fires once per page load.
		//new Promise<void>(async function(resolve, reject) {
		//	await page.waitForLoadState("networkidle");
		//}),
		new Promise<void>(function(resolve, reject) {
			const pending = new Set();

			function onRequest(request) {
				pending.add(request);
			}
			function onRequestDone(request) {
				pending.delete(request);
			}

			page.on("request", onRequest);
			page.on("requestfinished", onRequestDone);
			page.on("requestfailed", onRequestDone);

			// Wait at least 1 second.
			//await sleep(1000);

			setTimeout(function poll() {
				if (pending.size !== 0) {
					setTimeout(poll, 500);
				} else {
					resolve();

					page.removeListener("request", onRequest);
					page.removeListener("requestfinished", onRequestDone);
					page.removeListener("requestfailed", onRequestDone);
				}
			}, 500);
		}).then(function() {
			return waitForDOMContentIdle(page);
		}),
		new Promise<void>(async function(resolve, reject) {
			await sleep(options["timeout"] ?? 10_000);

			resolve();
		})
	]);
}

export function scrollIntoView(element, options = { "behavior": "auto", "block": "center", "inline": "start" }) {
	return element.evaluate(function(element, options) {
		element.scrollIntoView(options);
	}, options);
}

/*
export function scrollTo(page, options = { "top": 0, "left": 0, "behavior": "auto" }) {
	return page.evaluate(function(options) {
		console.log(arguments);
		window.scroll(options);
	}, options);
}
*/

export function clickAndWait(page, element, options = {}) {
	return Promise.all([
		element.click(options),
		waitForNetworkIdle(page)
	]);
}
