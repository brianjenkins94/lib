import Papa from "papaparse";

function stringify(headersOrData, data?) {
	if (data === undefined || headersOrData.every((datum) => !Array.isArray(datum) && typeof datum === "object")) {
		[data, headersOrData] = [headersOrData, data];
	}

	return Papa.unparse({
		"fields": headersOrData,
		"data": data
	}, {
		// If true, the first row of parsed data will be interpreted as field names.
		"header": data === undefined,
		"quotes": true
	});
}

function parse(data) {
	if (Array.isArray(data)) {
		const [headers, ...rows] = data;

		if (!Array.isArray(rows[0]) && typeof rows[0] === "object") {
			return Papa.parse(stringify(headers, rows)).data;
		}

		data = stringify([headers, ...rows]);
	}

	return Papa.parse(data, {
		"header": true,
		"dynamicTyping": true
	}).data;
}

export const CSV = {
	"stringify": stringify,
	"parse": parse
};
