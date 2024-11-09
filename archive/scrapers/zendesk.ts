import { attach, fido } from "../../util/playwright";
import { __root } from "../../util/env";
import { parse } from "../../util/table";
import { waitForNetworkIdle } from "../../util/playwright/wait";
import { getTicketCorrespondence, getTicketData } from "./models/Ticket";
import { isWeekday, nDaysAgo, today, tomorrow, yesterday } from "../../util/date";

const ALL_TICKETS = "https://devdept.zendesk.com/agent/filters/55555555555555";

function getTicketUrl(ticketNumber) {
	return `https://devdept.zendesk.com/api/v2/tickets/${ticketNumber}?include=brands%2Cpermissions%2Cusers%2Cgroups%2Corganizations%2Csharing_agreements%2Cincident_counts%2Ctde_workspace%2Ccustom_statuses%2Clookup_relationship_fields%2Ccustom_statuses%2Cgroup_slas`;
}

async function getTicketData(page, ticketNumber) {
	const response = await (await fido.get(page, getTicketUrl(ticketNumber))).json();

	return response["ticket"];
}

function getTicketConversationsUrl(ticketNumber) {
	return `https://devdept.zendesk.com/api/lotus/tickets/${ticketNumber}/conversations.json?include=users&sort_order=desc`;
}

async function getTicketCorrespondence(page, ticketNumber) {
	const { conversations, ...body } = await (await fido.get(page, getTicketConversationsUrl(ticketNumber))).json();

	/*
	conversations = conversations.map(function(conversation) {
		return conversation["body"].replace(/[^\n\x20-\x7E]/gui, "");
	});

	const results = /ENG-\d+/gui.exec(conversation);

	if (results !== null) {
		console.log(...results);
	}
	*/

	return {
		...body,
		"conversations": conversations
	};
}

async function getAccountTicketsUrl(accountName) {
	const { zendeskName, account } = await getAccount(accountName);

	return `https://devdept.zendesk.com/agent/search/1?copy&type=ticket&q=organization%3A%22${encodeURIComponent(zendeskName ?? account)}%22%20status%3Csolved`;
}

async function search({ account, maxResults = Infinity }) {
	const { "contexts": [context] } = await attach();

	const page = await context.newPage();

	await page.goto(account === undefined ? ALL_TICKETS : await getAccountTicketsUrl(account));

	await waitForNetworkIdle(page);

	const results = [];

	// <>

	let shouldContinue = true;

	while (shouldContinue) {
		const data = await page.evaluate(parse);

		for (const datum of data) {
			if (results.length >= maxResults) {
				shouldContinue = false;

				break;
			}

			try {
				datum["id"] = datum["id"].substring(1);
			} catch (error) {
				continue;
			}

			results.push(datum);
		}

		if (!shouldContinue) {
			break;
		}

		const nextButton = await page.$("[aria-label=\"Next Page\"]") ?? await page.$("[data-test-id=\"generic-table-pagination-next\"]");

		if (nextButton === null || await nextButton.getAttribute("disabled") !== null) {
			break;
		}

		await nextButton.click();

		await waitForNetworkIdle(page);
	}

	// </>

	await page.close();

	return results;
}

const { "contexts": [context] } = await attach();

const page = await context.newPage();

await page.goto(ALL_TICKETS);

// <>

const previousRecord = (function(date) {
    switch (date) {
    case 1:
        return hashMap[nDaysAgo(7).toISOString().split("T")[0]];
    case 7:
        return hashMap[nDaysAgo(2).toISOString().split("T")[0]];
    default:
        return hashMap[nDaysAgo(1).toISOString().split("T")[0]];
    }
})(today().getDay()) ?? {};

const record = {};

// </>

const results = await search();

for (let { "id": ticketNumber, "organization": accountName, "requested": dateCreated } of results) {
    if (record[accountName] === undefined) {
        record[accountName] = {
            "(45, ∞)": [],
            "(15, 45]": [],
            "(5, 15]": [],
            "[0, 5]": []
        };
    }

    dateCreated = new Date(dateCreated);

    switch (true) {
    case dateCreated < tomorrow() && dateCreated > nDaysAgo(5):
        record[accountName]["[0, 5]"].push(ticketNumber);
        break;
    case dateCreated <= nDaysAgo(5) && dateCreated > nDaysAgo(15):
        record[accountName]["(5, 15]"].push(ticketNumber);
        break;
    case dateCreated <= nDaysAgo(15) && dateCreated > nDaysAgo(45):
        record[accountName]["(15, 45]"].push(ticketNumber);
        break;
    case dateCreated <= nDaysAgo(45):
        record[accountName]["(45, ∞)"].push(ticketNumber);
        break;
    default:
        throw new Error("This should never happen.");
    }
}

const ticketsClosed = {};

for (const accountName of Object.keys(record)) {
    if (previousRecord[accountName] === undefined) {
        continue;
    }

    const message = [
        `Tickets since ${today().getDay() === 1 ? "last week" : "yesterday"}:`,
        "```"
    ];

    for (const [range, issues] of Object.entries(record[accountName])) {
        if (issues.length === 0) {
            continue;
        }

        // TODO: Replace with `Set.prototype.difference()`
        const difference1 = issues.filter(function(value) {
            return !previousRecord?.[accountName]?.[range].includes(value);
        });

        const record = hashMap[yesterday().toISOString().split("T")[0]] ?? {};

        const difference2 = issues.filter(function(value) {
            return record?.[accountName]?.[range] !== undefined && !Object.values(record?.[accountName]?.[range]).includes(value);
        });

        for (const ticketNumber of difference2) {
            if (record?.[accountName] !== undefined && !Object.values(record?.[accountName]).flat(Infinity).includes(ticketNumber)) {
                continue;
            }

            // This is a closed ticket and would not be in the cache.
            const { "assignee_id": assigneeId } = await getTicketData(page, ticketNumber);

            const { conversations, users } = await getTicketCorrespondence(page, ticketNumber);

            let lastHumanResponder;

            for (const message of conversations) {
                const user = users.find(function(user) {
                    return user["id"] === message["author_id"];
                });

                /*
                if (!user["email"].endsWith("@zendesk.com")) {
                    continue;
                }
                */

                lastHumanResponder = user["name"];

                break;
            }

            lastHumanResponder ??= users.find(function(user) {
                return user["id"] === assigneeId;
            })?.["name"];

            if (lastHumanResponder === undefined) {
                console.warn("Unable to determine the owner for ticket " + ticketNumber);

                continue;
            }

            ticketsClosed[lastHumanResponder] ??= [];
            ticketsClosed[lastHumanResponder].push(ticketNumber);
        }

        if (!isWeekday() || difference1.length === 0) {
            continue;
        }

        /*
        message.push(...[
            range + ":",
            ...difference1.map(function(ticketNumber) {
                return [
                    "",
                    previousRecord.includes?.(ticketNumber) ? "○" : "▲",
                    subject + " (https://devdept.zendesk.com/agent/tickets/" + ticketNumber + ")"
                ].join("\t");
            }),
            ""
        ]);
        */
    }

    /*
    console.log([
        message.join("\n").trimEnd(),
        "```"
    ].join("\n"));
    */
}

// </>

await page.close();

console.log("Done!")
