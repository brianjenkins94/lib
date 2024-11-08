import { table as createTable } from "table";

const defaultOptions = {
	"drawHorizontalLine": function(lineIndex, rowCount) {
		return false; // lineIndex <= 1 || lineIndex === rowCount;
	},
	"drawVerticalLine": function(lineIndex, columnCount) {
		return false;
	}
};

export function table(data, options = defaultOptions) {
	if (typeof data === "object" && !Array.isArray(data)) {
		data = Object.entries(data);
	}

	return createTable(data, options).split("\n").map(function(line) {
		return line.trimEnd();
	}).join("\n").trimEnd();
}

export function parse() {
	const table = document.querySelector("table");

	if (table === null) {
		throw new Error("Unable to find table.");
	}

	const rows = [
		...(table.tHead?.rows ?? []),
		...table.tBodies[0].rows
	];

	const headings = [...rows.shift().cells].map(function(heading) {
		return heading.innerText.toLowerCase()
			.replace(/(?:\s|-|_)+(.)/gu, function(_, match) {
				return match.toUpperCase();
			})
			.replace(/[^a-z0-9]/gui, "");
	});

	return rows.map(function(row) {
		if (row.cells[0] === undefined || row.cells[0].getAttribute("colspan") !== null) {
			return;
		}

		return [...row.cells].reduce(function(previous, current, index) {
			let cell;

			if (current.children.length > 0 && /time/ui.test(current.children[0]?.tagName) && current.children[0].getAttribute("datetime") !== null) {
				cell = new Date(current.children[0].getAttribute("datetime")).getTime();
			} else if (/\bdate\b/ui.test(headings[index])) {
				cell = new Date(current.innerText).getTime();
			}

			previous[headings[index]] = cell ?? current.innerText.trim();

			return previous;
		}, {});
	}).filter(function(element) {
		return element !== undefined;
	});
}
