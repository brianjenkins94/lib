import * as fs from "./fs";
import * as path from "node:path";
import * as url from "node:url";

async function readdir(directory) {
	const output = {
		"directories": [],
		"files": []
	};

	for (const fileName of await fs.readdir(directory)) {
		if (/^\.|node_modules/u.test(fileName)) {
			continue;
		}

		if ((await fs.stat(path.join(directory, fileName))).isDirectory()) {
			output.directories.push(fileName);
		} else {
			output.files.push(fileName);
		}
	}

	function compare(a, b) {
		return a.localeCompare(b);
	}

	output.directories.sort(compare);
	output.files.sort(compare);

	return output;
}

const SYMBOLS = {
	"BRANCH": "├── ",
	"INDENT": "    ",
	"LAST_BRANCH": "└── ",
	"VERTICAL": "│   "
};

export async function tree(cwd = process.cwd(), preface = []) {
	if (preface.length === 0) {
		console.log(path.basename(cwd));
	}

	const { directories, files } = await readdir(cwd);

	for (const directory of directories) {
		const isLast = directories.indexOf(directory) === directories.length - 1 && files.length === 0;

		console.log([...preface, isLast ? SYMBOLS.LAST_BRANCH : SYMBOLS.BRANCH].join("") + directory);

		await tree(path.join(cwd, directory), [...preface, isLast ? SYMBOLS.INDENT : SYMBOLS.VERTICAL]);
	}

	for (const file of files) {
		const isLast = files.indexOf(file) === files.length - 1;

		console.log([...preface, isLast ? SYMBOLS.LAST_BRANCH : SYMBOLS.BRANCH].join("") + file);
	}
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).toString()) {
	tree();
}
