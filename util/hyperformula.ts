import { HyperFormula } from "hyperformula";
import { CSV } from "./csv";

export function columnToLetter(n) {
	if (n < 0) {
		throw new Error("Number cannot be less than 0.");
	}

	return n > 26 ? columnToLetter(Math.floor((n - 1) / 26)) + columnToLetter(n % 26) : String.fromCharCode(65 + (n - 1 % 26));
}

export function initHyperFormula(data) {
	const hfInstance = HyperFormula.buildFromArray(data, {
		"licenseKey": "gpl-v3",
		"maxRows": 1_000_000
	});

	const sheetId = hfInstance.getSheetId(hfInstance.getSheetNames()[0]);

	function $(cellAddress: string, contextSheetId: number = sheetId) {
		return hfInstance.getCellValue(hfInstance.simpleCellAddressFromString(cellAddress, contextSheetId)) as string;
	}

	function $$(cellRange: number | string, contextSheetId: number = sheetId) {
		let [start, end] = String(cellRange).split(":");

		end ??= start;

		const { height, width } = hfInstance.getSheetDimensions(sheetId);

		switch (true) {
		// `start` ends with a letter
		// Example: A:A
		case /\D$/u.test(start):
			start += 1;
		// `end` ends with a letter
		// Example: A1:A
		case /\D$/u.test(end):
			end += height;
			break;
		// `start` starts with a digit
		// Example: 1:1
		case /^\d/u.test(start):
			if (start === end) {
				start = "A" + start;
				end = columnToLetter(width) + end;

				break;
			}

			start = "A" + start;
		// `end` starts with a digit
		// Example: A1:1
		case /^\d/u.test(end):
			end = /\d+$/u.exec(start)[0] === end ? /^\D+/u.exec(start)[0] + width : columnToLetter(width) + height;
			break;
		default:
		}

		const range = hfInstance.simpleCellRangeFromString([start, end].join(":"), contextSheetId);

		class RangeLike extends Array {
			public range;

			public constructor(range) {
				super();

				this.range = range;

				let values = hfInstance.getRangeValues(this.range) as any[];

				if (values.length === 1 || values.every((value) => value.length === 1)) {
					values = values.flat(Infinity);
				}

				this.push(...values);

				// WARN: Without this proxy `$()` and `$$()` may return stale values!
				/*
				return new Proxy(this, {
					"get": (target, property, receiver) => {
						if (/^\d+$/u.test(property.toString())) {
							this.splice(0, this.length, ...this.refresh());
						}

						return target[property];
					}
				});
				*/
			}

			public serialize() {
				let values = hfInstance.getRangeSerialized(this.range) as any[];

				if (values.length === 1 || values.every((value) => value.length === 1)) {
					values = values.flat(Infinity);
				}

				return values;
			}

			public append(changes, headers = $$("1:1")) {
				if (!Array.isArray(changes) && typeof changes === "object") {
					changes = [changes];
				}

				if (Array.isArray(changes)) {
					if (headers.every((header) => Array.isArray(header))) {
						headers = headers.reduce((result, headers) => result.map((value, index) => headers[index] !== undefined ? headers[index] : value));
					}

					if (changes.every((change) => !Array.isArray(change) && typeof change === "object")) {
						changes = CSV.parse([headers, ...changes]);
					}
				}

				const { start, end } = this.range;

				const { height, width } = hfInstance.getSheetDimensions(sheetId);

				hfInstance.setCellContents({ ...start, "row": height }, changes);
			}

			public update(changes, headers = $$("1:1")) {
				if (!Array.isArray(changes) && typeof changes === "object") {
					changes = [changes];
				}

				if (Array.isArray(changes)) {
					changes = CSV.parse([headers, ...changes]);
				}

				const { start, end } = this.range;

				let current = this.serialize();

				if (!current.every((element) => Array.isArray(element))) {
					current = [current];
				}

				for (let x = 0; x < current.length; x++) {
					for (let y = 0; y < current[x].length; y++) {
						if (changes[x][y] !== "") {
							current[x][y] = changes[x][y];
						}
					}
				}

				hfInstance.setCellContents(start, current);
			}
		}

		return new RangeLike(range);
	}

	return {
		"hfInstance": hfInstance,
		"$": $,
		"$$": $$
	};
}
