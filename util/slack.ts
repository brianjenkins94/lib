const SLACK_WEBHOOK_URL = "";

export function postMessage(message, options = {}) {
	return fetch(SLACK_WEBHOOK_URL, {
		"method": "POST",
		"body": JSON.stringify({
            //"channel": "#general",
			"text": message.trimEnd(),
			"icon_emoji": ":sunglasses:",
			...options
		})
	});
}
