export function initSlack(webhookUrl) {
	return function postMessage(message, options = {}) {
		return fetch(webhookUrl, {
			"method": "POST",
			"body": JSON.stringify({
				//"channel": "#general",
				"text": message.trimEnd(),
				"icon_emoji": ":sunglasses:",
				...options
			})
		});
	}
}