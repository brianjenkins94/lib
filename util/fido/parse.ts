// Content-negotiated response-body parsing: sniff Content-Type and attach json()/text()/xml()
// accessors (JSON, plain text, or SAX-parsed XML). Extracted from fido's core — no fido/network deps.

let SaxesParser;

// FROM: https://github.com/tomas/needle/blob/cfc51beac3c209d7eeca2f1ba546f67d9aa780ea/lib/parsers.js#L9
function parseXml(xmlString) {
	const parser = new SaxesParser();

	return new Promise(function(resolve, reject) {
		let object;
		let current;

		parser.on("error", function(error) {
			reject(error);
		});

		parser.on("text", function(text) {
			if (current !== undefined) {
				current.value += text;
			}
		});

		parser.on("opentag", function({ name, attributes }) {
			const element = {
				"name": name ?? "",
				"value": "",
				"attributes": attributes
			};

			if (current !== undefined) {
				element["parent"] = current;

				current["children"] ??= [];

				current.children.push(element);
			} else {
				object = element;
			}

			current = element;
		});

		parser.on("closetag", function() {
			if (current.parent !== undefined) {
				const previous = current;

				current = current.parent;

				delete previous.parent;
			}
		});

		parser.on("end", function() {
			resolve(object);
		});

		parser.write(xmlString).close();
	});
}

export async function attemptParse(response: Response): Promise<any> {
	const arrayBuffer = response.arrayBuffer();

	let body;

	response.arrayBuffer = async function() {
		return arrayBuffer;
	};

	let contentType = response.headers?.get("Content-Type");
	const contentLength = response.headers.get("Content-Length");

	if (contentType === undefined && parseInt(contentLength) > 0) {
		body = new TextDecoder().decode(await arrayBuffer);

		if (/[^\r\n\x20-\x7E]/ui.test(body)) {
			contentType = "text/plain";
		}
	}

	const mimeType = contentType?.split(";")[0].trim();

	if (mimeType?.endsWith("json")) {
		try {
			body ??= JSON.parse(new TextDecoder().decode(await arrayBuffer));

			response.json = async function() {
				return body;
			};

			response.text = async function() {
				return JSON.stringify(body, undefined, 2);
			};
		} catch (error) { }
	} else if (mimeType?.startsWith("text") && !mimeType?.endsWith("xml")) {
		body ??= new TextDecoder().decode(await arrayBuffer);

		response.json = async function() {
			return JSON.parse(body);
		};

		response.text = async function() {
			return body;
		};
	} else if (SaxesParser !== null && mimeType?.endsWith("xml")) {
		try {
			SaxesParser ??= (await import(/*! @external */ "saxes"))["default"]["SaxesParser"];

			body ??= new TextDecoder().decode(await arrayBuffer);

			body = parseXml(body);

			response["xml"] = async function() {
				return body;
			};
		} catch (error) {
			SaxesParser = null;
		}
	}

	return body;
}
