/**
 * A Chromium for tests: whichever this machine has, found the same way everywhere — `CHROME_PATH`, else Playwright's
 * own, else the system Chrome (preinstalled on GitHub's runners), else the newest build in Playwright's cache (one an
 * older Playwright downloaded still runs). Headless, one browser per call, nothing held in module state, and none of
 * util/playwright's scraping machinery (or Vite) loaded — for a test harness, not a scraper.
 */
import type { Browser, LaunchOptions } from "playwright";
import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import { chromium } from "playwright";

/** The newest Chromium in Playwright's browser cache, if any. */
export async function cachedChromium(): Promise<string | undefined> {
	const cache = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? path.join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : process.platform === "win32" ? "AppData/Local/ms-playwright" : ".cache/ms-playwright");
	const builds = fs.existsSync(cache)
		? (await fs.readdir(cache)).filter((name) => /^chromium(?:_headless_shell)?-\d+$/u.test(name)).sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]))
		: [];
	const executables = [
		"chrome-headless-shell-mac-arm64/chrome-headless-shell",
		"chrome-headless-shell-mac-x64/chrome-headless-shell",
		"chrome-headless-shell-linux64/chrome-headless-shell",
		"chrome-headless-shell-win64/chrome-headless-shell.exe",
		"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
		"chrome-linux64/chrome",
		"chrome-linux/chrome",
		"chrome-win64/chrome.exe"
	];

	return builds.flatMap((build) => executables.map((executable) => path.join(cache, build, executable))).find((candidate) => fs.existsSync(candidate));
}

/** Launch a headless Chromium (see above); `options` pass through to Playwright. Fails with every attempt's reason. */
export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
	if (process.env["CHROME_PATH"] !== undefined) {
		return chromium.launch({ ...options, "executablePath": process.env["CHROME_PATH"] });
	}

	const cached = await cachedChromium();
	const attempts: LaunchOptions[] = [{}, { "channel": "chrome" }, ...cached === undefined ? [] : [{ "executablePath": cached }]];
	const errors: unknown[] = [];

	for (const attempt of attempts) {
		try {
			return await chromium.launch({ ...options, ...attempt });
		} catch (error) {
			errors.push(error);
		}
	}

	throw new AggregateError(errors, "no Chromium to launch: install one (npx playwright install chromium) or set CHROME_PATH");
}
