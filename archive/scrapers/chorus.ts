import { attach, fido } from "../../util/playwright";
import { isWeekday, today, tomorrow } from "../../util/date";
import { waitForNetworkIdle } from "../../util/playwright/wait";

const CHORUS_URL = "https://chorus.ai/recordings?hide_no_show=true&saved_view=-1002&duration=1:*";

async function search(page) {
	// FIXME: This token can expire and we aren't handling its refresh.
	const [xsrfToken] = await Promise.all([
		new Promise(function(resolve, reject) {
			page.route("https://chorus.ai/api/meetings/filter", function(route, request) {
				resolve(request.headers()["x-xsrftoken"]);

				route.fulfill();
			}, { "times": 1 });
		}),
		page.goto(CHORUS_URL),
		waitForNetworkIdle(page)
	]);

	return {
		[Symbol.asyncIterator]: function() {
			let results;

			const date = tomorrow();

			let x = 0;

			let lastAfterSortKey;
			let lastCallId;

			async function nextPage(lastCallId, lastAfterSortKey) {
				const query = new URLSearchParams({
					"max_date": String(date.getTime() / 1000),
					"length": "20",
					"hide_no_show": String(true),
					"engagement_types": "recording",
					"min_duration": String(60),
					"with_trackers": String(false)
				});

				if (lastCallId !== undefined) {
					query.set("after_call_id", lastCallId);
				}

				if (lastAfterSortKey !== undefined) {
					query.set("after_sort_key", lastAfterSortKey);
				}

				return (await (await fido.post(page, "https://chorus.ai/api/meetings/filter", {
					"headers": {
						"Content-Type": "application/x-www-form-urlencoded",
						"X-Al-Version": "2020-06-18", // Required
						"X-Xsrftoken": xsrfToken // Required
					},
					"body": query
				})).json())["hits"];
			}

			return {
				"next": async function next() {
					if (results === undefined || x >= results.length) {
						results = await nextPage(lastCallId, lastAfterSortKey);

						x = 0;
					}

					if (results.length === 0) {
						return {
							"done": true
						};
					}

					const metadata = results[x];

					lastCallId = metadata["call_id"];
					lastAfterSortKey = metadata["after_sort_key"];

					const output = {
						"metadata": metadata
						//"transcript": transcript
					};

					x += 1;

					return {
						"value": output,
						"done": false
					};
				}
			};
		}
	};
}

const { "contexts": [context] } = await attach();

const page = await context.newPage();

// <>

let strikes = 0;

for await (const result of await search(page)) {
    const { "metadata": {
        "account_name": accountName,
        "meeting_summary": summary,
        "start_time": startTime,
        "call_state": callState,
        "call_id": callId,
        subject
    } } = result;

    const last3Hours = new Date(today().setHours(new Date().getHours() - 3, 0, 0, 0)).getTime() / 1000;

    if (callState !== "done") {
        continue;
    }

    if (startTime <= last3Hours) {
        strikes += 1;

        if (strikes < 2) {
            continue;
        } else {
            break;
        }
    }
}

// </>

await page.close();

if (isWeekday() && new Date().getHours() >= 9 && new Date().getHours() < 17) {
   console.log("Done!");
}
