import { attach } from "../../util/playwright";
import { __root } from "../../util/env";
import { waitForNetworkIdle } from "../../util/wait";
import { parse } from "../../util/table";

const MY_OPEN_ISSUES = "https://jira.atlassian.com/issues/?filter=-1";
const REPORTED_BY_ME = "https://jira.atlassian.com/issues/?filter=-2";
const ALL_ISSUES = "https://jira.atlassian.com/issues/?filter=-4";
const CREATED_RECENTLY = "https://jira.atlassian.com/issues/?filter=-6";
const UPDATED_RECENTLY = "https://jira.atlassian.com/issues/?filter=-8";

async function getAccountIssuesUrl(accountName) {
	const { tag } = await getAccount(accountName);

	return `https://jira.atlassian.com/issues/?jql=labels%20in%20(${tag})%20AND%20statusCategory%20!%3D%20done%20ORDER%20BY%20created%20DESC`;
}

// TODO: This needs to become an async iterator.
async function search({ account, maxResults = Infinity }) {
	const { "contexts": [context] } = await attach();

	const page = await context.newPage();

	await page.goto(account === undefined ? ALL_ISSUES : await getAccountIssuesUrl(account));

	await waitForNetworkIdle(page);

	const results = [];

    // <>

	let shouldContinue = true;

	while (shouldContinue) {
		let data;

		try {
			data = await page.evaluate(parse);
		} catch (error) {
			await page.close();

			return [];
		}

		for (const datum of data) {
			if (results.length >= maxResults) {
				shouldContinue = false;

				break;
			}

			results.push(datum);
		}

		if (!shouldContinue) {
			break;
		}

		const nextButton = page.locator("css=[aria-label=\"Next page\"]");

		if (await nextButton.count() === 0 || await nextButton.getAttribute("disabled") !== null) {
			break;
		}

		await nextButton.click();

		await waitForNetworkIdle(page);
	}

    // </>

	await page.close();

	return results;
}

console.log("Done!");
