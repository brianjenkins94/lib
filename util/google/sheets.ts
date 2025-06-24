import { sheets as sheetsApi } from "googleapis/build/src/apis/sheets";
import type { sheets_v4 as SheetsApi } from "googleapis/build/src/apis/sheets";
import {  } from "googleapis-common";
import { fetchWrapper } from "./auth";
import { OAuth2Client } from "@badgateway/oauth2-client";
import { OAuth2Client as GoogleOAuth2Client } from "googleapis-common";

class Sheet {
	private readonly sheetsApi;
	private readonly spreadSheetId;

	public constructor(client, spreadSheetId: string) {
		this.sheetsApi = sheetsApi({
			"version": "v4",
			"auth": client
		});

		this.spreadSheetId = spreadSheetId;
	}

	public async get(range: string, options = { "valueRenderOption": "FORMATTED_VALUE" }) {
		const rows = (await this.sheetsApi.spreadsheets.values.get({
			...options,
			"spreadsheetId": this.spreadSheetId,
			"range": range,
			"fields": "values"
		} as SheetsApi.Params$Resource$Spreadsheets$Values$Get))["data"]?.["values"] ?? [];

		return rows.map((row) => (Array.isArray(row) ? row : [row]).map(function(cell) {
			if (typeof cell === "string" && /^[{\[].*[}\]]$/.test(cell.trim())) {
				try {
					return JSON.parse(cell);
				} catch (error) {}
			}

			return cell;
		}));
	}

	public async getMaxRange(sheetName: string) {
		return (await this.sheetsApi.spreadsheets.get({
			"spreadsheetId": this.spreadSheetId,
			"ranges": [sheetName]
		} as SheetsApi.Params$Resource$Spreadsheets$Get))["data"]["sheets"][0]["properties"]["gridProperties"];
	}

	public update(range: string, data: unknown[] | unknown[][]) {
		if (!data.every(Array.isArray)) {
			data = [data];
		}

		return this.sheetsApi.spreadsheets.values.update({
			"spreadsheetId": this.spreadSheetId,
			"range": range,
			"valueInputOption": "RAW",
			"resource": {
				"values": data // [[key, parseInt(await get("Sheet1!B" + index), 10) + value]]
			}
		} as SheetsApi.Params$Resource$Spreadsheets$Values$Update);
	}

	public append(range: string, data: unknown[] | unknown[][]) {
		if (!data.every(Array.isArray)) {
			data = [data];
		}

		return this.sheetsApi.spreadsheets.values.append({
			"spreadsheetId": this.spreadSheetId,
			"range": range,
			"valueInputOption": "RAW",
			"resource": {
				"values": data // [[key, value]]
			}
		} as SheetsApi.Params$Resource$Spreadsheets$Values$Append);
	}

	public batch(requests: SheetsApi.Schema$ValueRange[]) {
		return this.sheetsApi.spreadsheets.values.batchUpdate({
			"spreadsheetId": this.spreadSheetId,
			"requestBody": {
				"valueInputOption": "USER_ENTERED",
				"data": requests
			}
		} as SheetsApi.Params$Resource$Spreadsheets$Values$Batchupdate);
	}
}

export async function initSheets(oauth2ClientOptions, spreadsheetId) {
	const client = new OAuth2Client({
		"authorizationEndpoint": "./auth",
		"tokenEndpoint": "./token",
		"server": "https://accounts.google.com/o/oauth2/auth",
		...oauth2ClientOptions
	});

	const { accessToken, refreshToken } = await fetchWrapper(client, {
		"scopes": [
			"https://www.googleapis.com/auth/spreadsheets",
			"https://www.googleapis.com/auth/documents",
			"https://www.googleapis.com/auth/drive",
			"https://www.googleapis.com/auth/drive.file"
		]
	}).getToken();

	const googleOAuth2Client = new GoogleOAuth2Client({
		"clientId": oauth2ClientOptions.clientId,
		"clientSecret": oauth2ClientOptions.clientSecret,
		"redirectUri": "http://localhost:3000/callback"
	});

	googleOAuth2Client.setCredentials({
		"access_token": accessToken,
		"refresh_token": refreshToken
	});

	return new Sheet(googleOAuth2Client, spreadsheetId);
}
