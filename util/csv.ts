import Papa from "papaparse";

// TODO: Review
function objectToCsv(dataOrHeaders, data?) {
	const [headers, inputData] = data === undefined
        ? [null, dataOrHeaders]
        : [dataOrHeaders, data];

    // Recursively flatten the nested structure into paths + leaf key-value pairs
    const flatten = (obj, path = []) => {
        if (typeof obj !== 'object' || obj === null) {
            return [[...path, obj]];
        }
        if (Array.isArray(obj)) {
            return [[...path, ...obj]];
        }
        return Object.entries(obj).flatMap(
            ([k, v]) => flatten(v, [...path, k])
        );
    };

    const rows = flatten(inputData);

    // Separate key-paths from metric keys/values (assume last two = metric key + value)
    const parsed = rows.map(row => {
        const metricKey = row[row.length - 2];
        const metricValue = row[row.length - 1];
        const keys = row.slice(0, -2);
        return { keys, metricKey, metricValue };
    });

    // Determine number of path columns from header or auto-detect
    const metricKeys = new Set(parsed.map(r => r.metricKey));
    const pathColumnCount = headers
        ? headers.findIndex(h => metricKeys.has(h))
        : Math.max(...parsed.map(r => r.keys.length));

    // If headers not provided, generate from observed keys
    const finalHeaders = headers || [
        ...Array.from({ length: pathColumnCount }, (_, i) => `key${i + 1}`),
        ...Array.from(metricKeys)
    ];

    // Group by unique key path
    const rowMap = new Map();
    for (const { keys, metricKey, metricValue } of parsed) {
        const rowKey = keys.join('|||');
        if (!rowMap.has(rowKey)) {
            rowMap.set(rowKey, { keys, metrics: {} });
        }
        rowMap.get(rowKey).metrics[metricKey] = metricValue;
    }

    // Build 2D array output
    const output = [];

    for (const { keys, metrics } of rowMap.values()) {
        const row = [];
        for (let i = 0; i < finalHeaders.length; i++) {
            const col = finalHeaders[i];
            if (i < pathColumnCount) {
                row.push(keys[i] ?? '');
            } else {
                row.push(metrics[col] ?? '');
            }
        }
        output.push(row);
    }

    return output;
}

function stringify(headersOrData, data?) {
	if (Array.isArray(headersOrData) && (!Array.isArray(data) && typeof data === "object") || ((!Array.isArray(headersOrData) && typeof headersOrData === "object") && data === undefined)) {
		return objectToCsv(headersOrData, data);
	}

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
