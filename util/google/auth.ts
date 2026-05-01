import { OAuth2Fetch } from "@badgateway/oauth2-client";
import type { OAuth2Client, OAuth2Token } from "@badgateway/oauth2-client";
import * as fs from "../fs";
import { __root } from "../env";
import { createServer } from "../server";

export function fetchWrapper(oauth2Client: OAuth2Client, { redirectUri = "http://localhost:3000/callback", scopes = [] }) {
	const fetchWrapper = new OAuth2Fetch({
		"client": oauth2Client,
		"getNewToken": async function() {
			// WORKAROUND: https://github.com/badgateway/oauth2-client/issues/110
			if (fetchWrapper["activeGetStoredToken"] !== null) {
				await fetchWrapper["activeGetStoredToken"];

				if (fs.existsSync("token.json")) {
					return JSON.parse(await fs.readFile("token.json", { "encoding": "utf8" }));
				}
			}

			let server;

			const token = await new Promise<OAuth2Token>(function(resolve, reject) {
				server = createServer();

				server.get("/callback", function(request, response) {
					const { code } = request.query;

					resolve(oauth2Client.authorizationCode.getToken({
						"code": code,
						"redirectUri": redirectUri
					}));

					return {
						"statusCode": 200
					};
				});

				server.listen(parseInt(new URL(redirectUri).port), function() {
					// TODO: Use open() instead.
					console.log(oauth2Client.settings.server + "?" + new URLSearchParams({
						"access_type": "offline",
						"prompt": "consent",
						"response_type": "code",
						"scope": scopes.join(" "),
						"client_id": oauth2Client.settings.clientId,
						//"state": "",
						"redirect_uri": redirectUri
					}).toString());
				});
			});

			await server.close();

			return token;
		},
		"storeToken": function(token) {
			fs.writeFileSync("token.json", JSON.stringify(token, undefined, "\t") + "\n");
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
