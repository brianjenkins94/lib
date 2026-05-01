import Papa from "papaparse";

function flatten(object, parentKey?) {
    return Object.entries(object).reduce(function(object, [key, value]) {
        if (/\d+/u.test(key)) {
            key = "[" + key + "]";
        }

        key = parentKey !== undefined ? `${parentKey}.${key}` : key;

        if (Array.isArray(value) && value.every((value) => typeof value !== "object")) {
            value = value.join(", ")
        } else if (typeof value === "object" && value !== null && Object.keys(value).length > 0) {
            return {
                ...object,
                ...flatten(value, key)
            };
        }

        return {
            ...object,
            [key]: value
        };
    }, {});
}

function getKeysOfLargestObject(array) {
    return Object.keys(array.reduce(function(object, current) {
        return Object.keys(current).length > Object.keys(object).length ? current : object
    }, {}));
}

function stringify(data: object[]): string;
function stringify(headers: string[], data: string[][]): string;
function stringify(headers: string[], data: object[]): string;
function stringify(headersOrData: string[] | object[], data?: string[][] | object[]): string {
    const hasExplicitHeaders =
        Array.isArray(headersOrData) && headersOrData.length > 0 && typeof headersOrData[0] === "string";

    const headers: string[] | undefined = hasExplicitHeaders ? headersOrData as string[] : undefined;
    const rows = hasExplicitHeaders ? data! : headersOrData as object[];

    const isArrayRows = rows.length > 0 && Array.isArray(rows[0]);
    const flatRows = isArrayRows ? rows : (rows as object[]).map((row) => flatten(row));
    const fields = headers ?? getKeysOfLargestObject(flatRows as object[]);

    return Papa.unparse({
        "fields": fields,
        "data": flatRows
    }, {
        "header": headers === undefined,
        "quotes": true
    });
}

function parse(data: any[][] | string): object[] {
    if (Array.isArray(data)) {
        // Serialize the full 2D array (header row + data rows) so Papa can correctly
        // identify the header row. Going through stringify(headers, rows) omits the
        // header row from the CSV output (header: false), causing Papa to treat the
        // first data row as headers instead.
        data = Papa.unparse(data as any[][], { quotes: true });
    }

    return Papa.parse(data, { header: true, dynamicTyping: true }).data as object[];
}

function toArray(data: object[]): any[][];
function toArray(headers: string[], data: object[]): any[][];
function toArray(headersOrData: string[] | object[], data?: object[]): any[][] {
    const hasExplicitHeaders =
        Array.isArray(headersOrData) && headersOrData.length > 0 && typeof headersOrData[0] === "string";

    const headers = hasExplicitHeaders
        ? headersOrData as string[]
        : getKeysOfLargestObject((headersOrData as object[]).map((r) => flatten(r)));
    const rows = hasExplicitHeaders ? data! : headersOrData as object[];
    const flatRows = rows.map((r) => flatten(r) as Record<string, unknown>);

    return [headers, ...flatRows.map((row) => headers.map((h) => row[h] ?? ""))];
}

export const CSV = {
    "stringify": stringify,
    "parse": parse,
    "toArray": toArray,
};
