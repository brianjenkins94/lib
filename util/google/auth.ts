import { OAuth2Client, OAuth2Fetch } from "@badgateway/oauth2-client";
import type { OAuth2Token } from "@badgateway/oauth2-client";
import { existsSync, promises as fs, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { __root } from "../env";
import { createServer } from "../server";
import { launch } from "../playwright";

const clientSecret = {
	"client_id": "",
	"project_id": "",
	"auth_uri": "",
	"token_uri": "",
	"auth_provider_x509_cert_url": "",
	"client_secret": "",
	"redirect_uris": [""],
	"javascript_origins": [""]
};

const EMAIL = "";

const AUTH_URL = clientSecret["auth_uri"];

const CLIENT_ID = clientSecret["client_id"];

const SECRET_KEY = clientSecret["client_secret"];

const REDIRECT_URI = clientSecret["redirect_uris"][0];

const SCOPES = [
	"https://www.googleapis.com/auth/spreadsheets",
	"https://www.googleapis.com/auth/documents",
	"https://www.googleapis.com/auth/drive",
	"https://www.googleapis.com/auth/drive.file"
];

export const oauth2Client = new OAuth2Client({
	"authorizationEndpoint": "./auth",
	"tokenEndpoint": "./token",
	"server": AUTH_URL,
	"clientId": CLIENT_ID,
	"clientSecret": SECRET_KEY
});

export const fetchWrapper = new OAuth2Fetch({
	"client": oauth2Client,
	"getNewToken": async function() {
		// WORKAROUND: https://github.com/badgateway/oauth2-client/issues/110
		if (fetchWrapper.activeGetStoredToken !== null) {
			await fetchWrapper.activeGetStoredToken;

			if (existsSync("token.json")) {
				return JSON.parse(await fs.readFile("token.json", { "encoding": "utf8" }));
			}
		}

		return new Promise<OAuth2Token>(function(resolve, reject) {
			let page;

			const server = createServer();

			server.get("/callback", function(request, response) {
				const { code } = request.query;

				resolve(oauth2Client.authorizationCode.getToken({
					"code": code,
					"redirectUri": REDIRECT_URI
				}));

				server.close();

				page.close();

				return {
					"statusCode": 200
				};
			});

			server.listen(parseInt(new URL(REDIRECT_URI).port), async function() {
				page = await launch(AUTH_URL + "?" + new URLSearchParams({
					"access_type": "offline",
					"response_type": "code",
					"scope": SCOPES.join(" "),
					"client_id": CLIENT_ID,
					//"state": "",
					"redirect_uri": REDIRECT_URI
				}).toString());

				// Enter email
				const nextButtonSelector = "#identifierNext";

				await page.waitForSelector("input[type=\"email\"]");
				await page.type("input[type=\"email\"]", EMAIL);
				await page.waitForSelector(nextButtonSelector);
				await page.click(nextButtonSelector);

				// Enter password
				const passwordNextButtonSelector = "#passwordNext";

				await page.waitForSelector("input[type=\"password\"]");

				const readline = createInterface({
					"input": process.stdin,
					"output": process.stdout
				});

				const PASSWORD = await new Promise(function(resolve, reject) {
					readline.question("Password: ", resolve);
				});

				readline.close();

				await page.type("input[type=\"password\"]", PASSWORD);

				await page.waitForSelector(passwordNextButtonSelector);
				await page.click(passwordNextButtonSelector);
			});
		});
	},
	"storeToken": function(token) {
		if (!existsSync("token.json")) {
			writeFileSync("token.json", JSON.stringify(token, undefined, "\t") + "\n");
		}
	},
	"getStoredToken": async function() {
		if (existsSync("token.json")) {
			return JSON.parse(await fs.readFile("token.json", { "encoding": "utf8" }));
		} else {
			return null;
		}
	}
});
