import { scheduleJob } from "node-schedule";
import * as path from "node:path";
import * as url from "node:url";
import { promises as fs } from "node:fs";

export async function bindScheduledTasks(scheduledTasksDirectory) {
	const files = [];

	await (async function recurse(directory) {
		for (const file of await fs.readdir(directory)) {
			if ((await fs.stat(path.join(directory, file))).isDirectory()) {
                //recurse(path.join(directory, file));
			} else if (path.extname(file).toLowerCase() === ".ts") {
				files.push(path.join(directory, file));
			}
		}
	})(scheduledTasksDirectory);

	for (const file of files) {
		const defaultExport = (await import(url.pathToFileURL(file).toString())).default;

		if (defaultExport !== undefined) {
			console.log("Scheduling ." + file.substring(scheduledTasksDirectory.length).replace(/\\+/gu, "/"));

			scheduleJob(...defaultExport);
		}
	}
}
