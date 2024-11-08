import { docs as docsApi } from "googleapis/build/src/apis/docs";
import type { docs_v1 as DocsApis } from "googleapis/build/src/apis/docs";
import { OAuth2Client } from "googleapis-common";
import { GoogleDocument } from "gatsby-source-google-docs/utils/google-document";

export class Doc {
	private readonly docsApi;
	private readonly documentId;

	public constructor({ accessToken, refreshToken, ...clientOptions }, documentId: string) {
		const client = new OAuth2Client(clientOptions);

		client.setCredentials({
			"access_token": accessToken,
			"refresh_token": refreshToken
		});

		this.docsApi = docsApi({
			"version": "v1",
			"auth": client
		});

		this.documentId = documentId;
	}

	public async get() {
		return (await this.docsApi.documents.get({
			"documentId": this.documentId
		} as DocsApis.Params$Resource$Documents$Get))["data"];
	}

	public append(request: DocsApis.Schema$InsertTextRequest) {
		return this.docsApi.documents.batchUpdate({
			"documentId": this.documentId,
			"requestBody": {
				"requests": [
					{
						"insertText": {
							"endOfSegmentLocation": {
								"segmentId": "" // An empty segment ID signifies the document's body.
							},
							...request
						}
					}
				]
			}
		} as DocsApis.Params$Resource$Documents$Batchupdate);
	}

	public prepend(request: DocsApis.Schema$InsertTextRequest) {
		return this.docsApi.documents.batchUpdate({
			"documentId": this.documentId,
			"requestBody": {
				"requests": [
					{
						"insertText": {
							"location": {
								"index": 1
							},
							...request
						}
					}
				]
			}
		} as DocsApis.Params$Resource$Documents$Batchupdate);
	}

	public async getAsMarkdown() {
		return new GoogleDocument({ "document": await this.get() }).toMarkdown();
	}

	// InsertTextRequest (https://developers.google.com/docs/api/reference/rest/v1/documents/request#InsertTextRequest)
	// UpdateTextStyleRequest (https://developers.google.com/docs/api/reference/rest/v1/documents/request#UpdateTextStyleRequest)
	// CreateParagraphBulletsRequest (https://developers.google.com/docs/api/reference/rest/v1/documents/request#CreateParagraphBulletsRequest)
	// UpdateParagraphStyleRequest (https://developers.google.com/docs/api/reference/rest/v1/documents/request#UpdateParagraphStyleRequest)
	// InsertPageBreakRequest (https://developers.google.com/docs/api/reference/rest/v1/documents/request#InsertPageBreakRequest)

	public heading() {

	}

	public paragraph() {

	}

	public bold() {

	}

	public italic() {

	}

	public underline() {

	}

	public strikethrough() {

	}

	public highlight() {

	}

	public hyperlink() {

	}

	public preformatted() {

	}

	public code() {

	}

	public bulletedList() {

	}

	public numberedList() {

	}

	public pageBreak() {
		return { "insertPageBreak": {} };
	}

	public horizontalRule() {

	}
}
