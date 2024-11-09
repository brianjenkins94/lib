import { attach } from "../../util/playwright";

const LI_AT_COOKIE = process.env["LI_AT_COOKIE"];

if (LI_AT_COOKIE === undefined) {
	throw new Error("LI_AT_COOKIE undefined.");
}

const selectors = {
	"apply": ".jobs-apply-button",
	"jobs": ".job-card-container",
	"logo": ".artdeco-entity-lockup__image img[class*=\"square\"]", // ".artdeco-entity-lockup__image img",
	"details": ".jobs-details__main-content",
	"title": ".artdeco-entity-lockup__title",
	"link": ".artdeco-entity-lockup__title a",
	"company": ".job-card-container__primary-description", // ".job-card-container__company-name",
	"location": ".artdeco-entity-lockup__caption",
	"date": ".jobs-unified-top-card__posted-date",
	"compensation": "[href=\"#SALARY\"]",
	"size": ".jobs-unified-top-card__job-insight:has([type=\"company\"])",
	"industry": ".jobs-unified-top-card__job-insight:has([type=\"company\"])",
	"insights": ".jobs-unified-top-card__job-insight",
	"getPage": function(index) {
		return "li[data-test-pagination-page-btn=\"" + index + "\"]";
	}
};

const searchTerms = [
	"architect",
	"implementation",
	"integration",
	"node.js",
	"solutions",
	"startup",
	"technical",
	"typescript"
];

const searches = searchTerms.map(function(searchTerm) {
	const query = new URLSearchParams({
		"keywords": searchTerm, // + " NOT manager",
		"location": "United States",
		"sortBy": "DD", // Date descending
		"f_JT": "F", // Full Time
		"f_SB2": "6", // $140,000+
		"f_TPR": "r604800", // Past week
		"f_WT": "2" // Remote
	});

	const url = "https://www.linkedin.com/jobs/search?" + query;

	return function() {
		return new Promise(async function(resolve, reject) {
            const { "contexts": [context] } = await attach();

            const page = await context.newPage();

            page.goto(url);

            if ((await page.context().cookies()).length === 0) {
                await context.addCookies([
                    {
                        "name": "li_at",
                        "value": LI_AT_COOKIE,
                        "domain": ".www.linkedin.com",
                        "path": "/"
                    }
                ]);
            }

            page.route("**/*", function(route) {
                return [/* "image", "stylesheet", */ "media", "font", "imageset"].includes(route.request().resourceType())
                    ? route.abort()
                    : route.continue();
            });

            const results = [];

            // TODO: Improve
            try {
                await page.goto(url);
            } catch (error) {
                try {
                    await page.goto(url);
                } catch (error) {
                    // This will result in data being skipped.
                    await page.close();

                    resolve(results);
                }
            }

            const PAGES_TO_SCRAPE = 8;

            for (let pageNumber = 2; pageNumber < (PAGES_TO_SCRAPE + 2); pageNumber++) {
                // Mitigate skipping
                await page.waitForTimeout(2500);

                // TODO: Improve
                try {
                    await page.waitForSelector(selectors.jobs);
                } catch (error) {
                    try {
                        await page.reload();

                        // Mitigate skipping
                        await page.waitForTimeout(2500);

                        await page.waitForSelector(selectors.jobs);
                    } catch (error) {
                        // This will result in data being skipped.
                        break;
                    }
                }

                for (let x = 0, jobs = page.locator(selectors.jobs), job = jobs.nth(x); x < await jobs.count(); x++, jobs = page.locator(selectors.jobs), job = jobs.nth(x)) {
                    job.evaluate(function(element) {
                        element.scrollIntoView(true);
                    });

                    await job.click({
                        "position": {
                            "x": 0,
                            "y": 0
                        }
                    });

                    // TODO: Improve
                    try {
                        await page.waitForSelector(selectors.insights);
                    } catch (error) {
                        try {
                            let previousJob = jobs.nth(x - 1)

                            previousJob.evaluate(function(element) {
                                element.scrollIntoView(true);
                            });

                            await previousJob.click({
                                "position": {
                                    "x": 0,
                                    "y": 0
                                }
                            });

                            await page.waitForSelector(selectors.insights);

                            await job.click({
                                "position": {
                                    "x": 0,
                                    "y": 0
                                }
                            });

                            await page.waitForSelector(selectors.insights);
                        } catch (error) {
                            // This will result in data being skipped.
                            continue;
                        }
                    }

                    const details = page.locator(selectors.details);

                    if (false) {
                        const applyButton = details.locator(selectors.apply, { "hasText": "Apply" }).first();

                        if (await applyButton.count() > 0 && !(await applyButton.textContent()).includes("Easy Apply")) {
                            const popupPromise = page.waitForEvent("popup");

                            await applyButton.click();

                            let popup;

                            try {
                                popup = await popupPromise;

                                await popup.waitForLoadState();
                            } catch (error) { } finally {
                                await popup?.close();
                            }

                            console.log("Applied ¬‿¬");
                        }
                    }

                    try {
                        const result = {
                            "title": (await job.locator(selectors.title).textContent()).trim(),
                            "logo": (await job.locator(selectors.logo).getAttribute("src")).trim(),
                            "link": (await job.locator(selectors.link).evaluate(function(element: HTMLAnchorElement) { return element.href; })).trim(),
                            "company": (await job.locator(selectors.company).textContent()).trim(),
                            "location": (await job.locator(selectors.location).textContent()).trim().replace(/\s{2,}/gu, " - "),
                            "date": (await details.locator(selectors.date).textContent()).split(/(?<=ago)/u)[0].trim(),
                            "compensation": (await details.locator(selectors.compensation).count()) > 0 ? (await details.locator(selectors.compensation).textContent()).split(" (from job description)")[0].trim() : undefined,
                            "size": (await details.locator(selectors.size).count()) > 0 ? (await details.locator(selectors.size).textContent()).split(" · ")[0]?.trim() : undefined,
                            "industry": (await details.locator(selectors.industry).count()) > 0 ? (await details.locator(selectors.industry).textContent()).split(" · ")[1]?.trim() : undefined
                        };

                        console.log(result);

                        results.push(result);
                    } catch (error) {
                        console.error(error);
                    }
                }

                try {
                    if ((await page.locator(selectors.getPage(pageNumber)).count()) > 0) {
                        await page.locator(selectors.getPage(pageNumber)).click();
                    } else {
                        await page.locator(selectors.getPage(pageNumber - 1) + " + *").click();
                    }
                } catch (error) {
                    break;
                }
            }

            await page.close();

            resolve(results);
		});
	}
});

const startTime = performance.now();

const results = await Promise.all(searches);

const endTime = performance.now();
const dateTime = new Date(Date.now() + (endTime - startTime));

console.log("Job began at " + dateTime.toUTCString() + " and took " + dateTime.getMinutes() + " minutes.");
