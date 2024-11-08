import { sheets as sheetsApi } from "googleapis/build/src/apis/sheets";
import type { sheets_v4 as SheetsApi } from "googleapis/build/src/apis/sheets";
import { OAuth2Client } from "googleapis-common";

export class Sheet {
	private readonly sheetsApi;
	private readonly spreadSheetId;

	public constructor({ accessToken, refreshToken, ...clientOptions }, spreadSheetId: string) {
		const client = new OAuth2Client(clientOptions);

		client.setCredentials({
			"access_token": accessToken,
			"refresh_token": refreshToken
		});

		this.sheetsApi = sheetsApi({
			"version": "v4",
			"auth": client
		});

		this.spreadSheetId = spreadSheetId;
	}

	public async get(range: string, options = { "valueRenderOption": "FORMATTED_VALUE" }) {
		const data = [];

		const rows = (await this.sheetsApi.spreadsheets.values.get({
			...options,
			"spreadsheetId": this.spreadSheetId,
			"range": range
		} as SheetsApi.Params$Resource$Spreadsheets$Values$Get))["data"]?.["values"] ?? [];

		for (const row of rows) {
			if (Array.isArray(row)) {
				const columns = [];

				for (const cell of row) {
					try {
						columns.push(JSON.parse(cell));
					} catch (error) {
						columns.push(cell);
					}
				}

				data.push(columns);
			} else {
				data.push(JSON.parse(row));
			}
		}

		return data;
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

import { fetchWrapper, oauth2Client } from "./auth";

// TODO: Memoize
export async function initSheets(spreadsheetId) {
	const { accessToken, refreshToken } = await fetchWrapper.getToken();

	// TODO: Pretty this up:
	const sheets = new Sheet({
		"clientId": oauth2Client.settings.clientId,
		"clientSecret": oauth2Client.settings.clientSecret,
		"redirectUri": "http://localhost:3000/callback",
		"accessToken": accessToken,
		"refreshToken": refreshToken
	}, spreadsheetId);

	return sheets;
}
