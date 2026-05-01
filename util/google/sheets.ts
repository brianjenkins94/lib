import { sheets as sheetsApi } from "googleapis/build/src/apis/sheets";
import type { sheets_v4 as SheetsApi } from "googleapis/build/src/apis/sheets";
import {  } from "googleapis-common";
import { fetchWrapper } from "./auth";
import { OAuth2Client } from "@badgateway/oauth2-client";
import { OAuth2Client as GoogleOAuth2Client } from "googleapis-common";
import { ClientSettings } from "@badgateway/oauth2-client/dist/client";
import { mapAsync } from "../array";

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

	private parseCell(cell) {
		if (typeof cell === "string" && /^[{\[].*[}\]]$/.test(cell.trim())) {
			try {
				return JSON.parse(cell);
			} catch {}
		}

		return cell;
	};

	private normalizeRows(rows = []) {
		return rows.map((row) => {
			return (Array.isArray(row) ? row : [row]).map((cell) => this.parseCell(cell))
		});
	}

	public async get(range: string, options = { "valueRenderOption": "FORMATTED_VALUE" }) {
		let ranges = range.split(";")

		if (ranges.length > 1) {
			ranges = await mapAsync(ranges, async (range) => {
				if (/\d$/.test(range)) {
					return range;
				}

				const [, sheet, start, end] = range.match(/^([^!]+)!(\w+):(\w+)$/u);

				// TODO: Memoize
				return sheet + "!" + start + ":" + end + (await this.getMaxRange(sheet)).rowCount;
			})

			const rows = (await this.sheetsApi.spreadsheets.values.batchGet({
				...options,
				"spreadsheetId": this.spreadSheetId,
				"ranges": ranges,
				"fields": "valueRanges(values)"
			} as SheetsApi.Params$Resource$Spreadsheets$Values$Batchget))["data"]?.["valueRanges"] ?? [];

			return rows.flatMap(({ values }) => this.normalizeRows(values));
		}

		const rows = (await this.sheetsApi.spreadsheets.values.get({
			...options,
			"spreadsheetId": this.spreadSheetId,
			"range": range,
			"fields": "values"
		} as SheetsApi.Params$Resource$Spreadsheets$Values$Get))["data"]?.["values"] ?? [];

		return this.normalizeRows(rows);
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
			"valueInputOption": "USER_ENTERED",
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
			"valueInputOption": "USER_ENTERED",
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

export async function initSheets({ sheetId, ...oauth2ClientOptions }: Partial<ClientSettings> & { sheetId: string }) {
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

	return new Sheet(googleOAuth2Client, sheetId);
}
