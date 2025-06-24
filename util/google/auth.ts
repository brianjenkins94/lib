import { OAuth2Fetch } from "@badgateway/oauth2-client";
import type { OAuth2Client, OAuth2Token } from "@badgateway/oauth2-client";
import * as fs from "../fs";
import { __root } from "../env";
import { createServer } from "../server";
import { attach, launch } from "../playwright";
import { waitForNavigation } from "../playwright/wait";

export function fetchWrapper(oauth2Client: OAuth2Client, { redirectUri = "http://localhost:3000/callback", scopes = [] }) {
	const fetchWrapper = new OAuth2Fetch({
		"client": oauth2Client,
		"getNewToken": async () => {
			// WORKAROUND: https://github.com/badgateway/oauth2-client/issues/110
			if (fetchWrapper["activeGetStoredToken"] !== null) {
				await fetchWrapper["activeGetStoredToken"];

				if (fs.existsSync("token.json")) {
					return JSON.parse(await fs.readFile("token.json", { "encoding": "utf8" }));
				}
			}

			let server;

			return new Promise<OAuth2Token>(function(resolve, reject) {
				let page;

				server = createServer();

				server.get("/callback", function(request, response) {
					const { code } = request.query;

					resolve(oauth2Client.authorizationCode.getToken({
						"code": code,
						"redirectUri": redirectUri
					}));

					page.close();

					return {
						"statusCode": 200
					};
				});

				server.listen(parseInt(new URL(redirectUri).port), async function() {
					page = await attach(oauth2Client.settings.server + "?" + new URLSearchParams({
						"access_type": "offline",
						"response_type": "code",
						"scope": scopes.join(" "),
						"client_id": oauth2Client.settings.clientId,
						//"state": "",
						"redirect_uri": redirectUri
					}).toString());
				});
			}).then(function() {
				server.close();
			});
		},
		"storeToken": function(token) {
			if (!fs.existsSync("token.json")) {
				fs.writeFileSync("token.json", JSON.stringify(token, undefined, "\t") + "\n");
			}
		},
		"getStoredToken": async function() {
			if (fs.existsSync("token.json")) {
				return JSON.parse(await fs.readFile("token.json", { "encoding": "utf8" }));
			} else {
				return null;
			}
		}
	});

	return fetchWrapper;
}
