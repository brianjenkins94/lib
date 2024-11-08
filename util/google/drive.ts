import { drive as driveApi } from "googleapis/build/src/apis/drive";
import type { drive_v3 as DriveApi } from "googleapis/build/src/apis/drive";
import { OAuth2Client } from "googleapis-common";

export class Drive {
	private readonly driveApi;

	private readonly parentFolderId;

	public constructor({ accessToken, refreshToken, ...clientOptions }, parentFolderId) {
		const client = new OAuth2Client(clientOptions);

		client.setCredentials({
			"access_token": accessToken,
			"refresh_token": refreshToken
		});

		this.driveApi = driveApi({
			"version": "v3",
			"auth": client
		});

		this.parentFolderId = parentFolderId;
	}

	public async getOrCreateFolder(folderName) {
		const { "data": { files } } = await this.driveApi.files.list({
			"q": "parents in \"" + this.parentFolderId + "\" and mimeType = \"application/vnd.google-apps.folder\" and name = \"" + folderName + "\" and trashed = false",
			"supportsAllDrives": true,
			"includeItemsFromAllDrives": true
		} as DriveApi.Params$Resource$Files$List);

		if (files.length > 0) {
			return files[0];
		}

		return (await this.driveApi.files.create({
			"requestBody": {
				"name": folderName,
				"parents": [this.parentFolderId],
				"mimeType": "application/vnd.google-apps.folder"
			},
			"supportsAllDrives": true
		} as DriveApi.Params$Resource$Files$Create))["data"];
	}

	public async createFile(fileName, options = {}) {
		return (await this.driveApi.files.create({
			"uploadType": "resumable",
			"supportsAllDrives": true,
			"requestBody": {
				...options,
				"name": fileName,
				"parents": [this.parentFolderId]
			}
		} as DriveApi.Params$Resource$Files$Create))["data"];
	}

	public async uploadFile(fileName, fileBytes, options = {}) {
		const { id } = await this.createFile(fileName, {
			...options,
			"uploadType": "resumable",
			"supportsAllDrives": true
		});

		return (await this.driveApi.files.update({
			"fileId": id,
			"media": {
				"mimeType": options["mimeType"],
				"body": fileBytes
			},
			"supportsAllDrives": true
		} as DriveApi.Params$Resource$Files$Update))["data"];
	}

	public async getFilePermissions(fileId) {
		return (await this.driveApi.permissions.list({
			"fileId": fileId,
			"supportsAllDrives": true
		} as DriveApi.Params$Resource$Permissions$List))["data"]["permissions"];
	}

	public async getSharableFileUrl(fileId) {
		const response = await this.driveApi.permissions.create({
			"fileId": fileId,
			"requestBody": {
				"type": "anyone",
				"role": "reader"
			},
			"supportsAllDrives": true
		} as DriveApi.Params$Resource$Permissions$Create);

		console.log(response);

		return "https://drive.google.com/file/d/" + fileId + "/view?usp=sharing";
	}
}
