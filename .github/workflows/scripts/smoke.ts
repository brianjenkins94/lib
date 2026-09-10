import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Smoke-test each freshly-published package against its LIVE GitHub Pages tarball (replaces smoke.sh):
 * install it with `--no-save`, then run the runtime test over every non-"." export it declares.
 */

const packages = process.argv.slice(2);
const owner = process.env["GITHUB_REPOSITORY_OWNER"];
const repo = (process.env["GITHUB_REPOSITORY"] ?? "").split("/").slice(1).join("/");

for (const pkg of packages) {
	const scoped = `@${owner}/${pkg}`;
	const url = `https://${owner}.github.io/${repo}/${pkg}@latest.tgz`;

	// --legacy-peer-deps: the package declares its peers as "latest", and npm's peer auto-resolution crashes
	// on the runner ("Cannot read properties of null (reading 'matches')") trying to satisfy them. The smoke
	// test only needs the tarball itself installed — skip peer resolution rather than install the whole graph.
	execFileSync("npm", ["install", "--no-save", "--legacy-peer-deps", url], { "stdio": "inherit" });

	const exportsMap = JSON.parse(readFileSync(`node_modules/${scoped}/package.json`, "utf8")).exports as Record<string, unknown>;
	const exportPaths = Object.keys(exportsMap).filter((key) => key !== ".").map((key) => scoped + key.slice(1));

	execFileSync("npx", ["tsx", "test/runtime/node.ts", ...exportPaths], { "stdio": "inherit" });
}
