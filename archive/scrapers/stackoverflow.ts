import { TextWriter, ZipReader } from "@zip.js/zip.js";
import { Readable } from "stream";
import * as path from "path";

import { attach } from "../../util/playwright";
import { __root } from "../../util/env";
import { waitForNetworkIdle } from "../../util/playwright/wait";
import { querySelectorAll } from "../../util/querySelector";

const STACK_OVERFLOW_TEAMS_ACCOUNT_SETTINGS_URL = "https://stackoverflowteams.com/c/community/admin/billing/account";

const { "contexts": [context] } = await attach();

const page = await context.newPage();

await page.goto(STACK_OVERFLOW_TEAMS_ACCOUNT_SETTINGS_URL);

await waitForNetworkIdle(page);

const results = [];

// <>

/*
const $$ = querySelectorAll(page);

const questions = [];

while (true) {
    questions.push(...(await Array.fromAsync($$("[data-controller=\"details-popover\"] > a"), function(element) {
        return element.getAttribute("href");
    })));


    const nextButton = page.locator("css=a[rel=\"next\"]");

    if (await nextButton.count() === 0) {
        break;
    }

    await nextButton.click();

    await waitForNetworkIdle(page);
}
*/

const downloadPromise = page.waitForEvent("download");

await page.getByRole("button", { "name": "Download data", "exact": true }).click();

const readStream = Readable.toWeb(await (await downloadPromise).createReadStream());

const zipReader = new ZipReader(readStream);

const { posts, users } = Object.fromEntries(await Promise.all((await zipReader.getEntries()).filter(function(entry) {
    return entry.filename.endsWith(".json");
}).map(async function(entry) {
    const textWriter = new TextWriter();

    return [path.basename(entry.filename, path.extname(entry.filename)), JSON.parse(await entry.getData(textWriter))];
})));

await zipReader.close();

// </>

await page.close();

console.log("Done!");
