import * as url from "node:url";
import { ESLint } from "eslint";
import * as fs from "@brianjenkins94/util/fs";

/**
 * The `util-lint` bin. Run from a package directory (`"lint": "util-lint"`, or
 * `"lint:fix": "util-lint --fix"`) to lint that package's cwd with the shared
 * flat-config preset. A consumer only re-exports the preset from its own
 * eslint.config.js (`export { default } from "@brianjenkins94/util/eslint"`) —
 * the whole eslint toolchain ships with util, so no eslint deps of its own.
 *
 * Uses the ESLint Node API rather than spawning the `eslint` bin so it resolves
 * from util's dependencies regardless of the consumer's node_modules layout.
 */
export async function lint({ fix = false, patterns = ["."] }: { "fix"?: boolean; "patterns"?: string[] } = {}) {
	const eslint = new ESLint({ "cwd": process.cwd(), "fix": fix });

	const results = await eslint.lintFiles(patterns);

	if (fix) {
		await ESLint.outputFixes(results);
	}

	const formatter = await eslint.loadFormatter("stylish");
	const output = await formatter.format(results);

	if (output !== "") {
		process.stdout.write(output.endsWith("\n") ? output : output + "\n");
	}

	return results.reduce((total, result) => total + result.errorCount, 0);
}

if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(await fs.realpath(process.argv[1])).toString()) {
	const args = process.argv.slice(2);
	const positional = args.filter((argument) => !argument.startsWith("-"));

	const errorCount = await lint({
		"fix": args.includes("--fix"),
		"patterns": positional.length > 0 ? positional : ["."]
	});

	process.exitCode = errorCount > 0 ? 1 : 0;
}
