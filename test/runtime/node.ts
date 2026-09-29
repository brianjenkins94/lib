import { spawn } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { __root } from "../../util/env";
import * as fs from "../../util/fs";

const packages = process.argv.slice(2);

// Resolve util's imports as if util were installed on its own, not inside this repo (see isolate.mjs).
const isolate = pathToFileURL(path.join(__root, "test", "runtime", "isolate.mjs")).href;

const items = packages.length > 0 ? packages : fs.glob(path.join(__root, "util", "**", "*.ts"), {
	"exclude": function(fileName) {
		return /(^|[\\/])(node_modules|scripts)([\\/]|$)/u.test(fileName);
	}
});

for await (const item of items) {
	const command = packages.length > 0
		? ["node", "--input-type=module", "--eval", `import "${item}";`]
		: ["npx", "tsx", "--import", isolate, item];

	console.log(">", command.join(" "));
	let process = spawn(command[0], command.slice(1), {
		"shell": true
		//"stdio": "inherit"
	});

	await new Promise<void>(function recurse(resolve, reject) {
		const buffer = [];

		process.stderr.on("data", function(chunk) {
			buffer.push(chunk);
		});

		process.on("close", async function(code) {
			if (code === 0) {
				resolve();

				return;
			}

			const [packageName] = /(?<=').*?(?=')/u.exec(Buffer.concat(buffer).toString());

			if (packageName.startsWith(".")) {
				reject(new Error(`${item} has a broken relative import: ${packageName}`));

				return;
			}

			// Record the import as a PEER only — the point of this test: every util module's imports end up declared as
			// util's peers, discovered by running each file rather than hand-maintaining a manifest per file. (`pnpm add
			// --save-peer` would also write a devDependency.) `*` rather than a tag: pnpm rejects `latest` as a peer range.
			const manifestPath = path.join(__root, "util", "package.json");
			const manifest = JSON.parse(await fs.readFile(manifestPath));
			const peers = { ...manifest["peerDependencies"], [packageName]: "*" };

			manifest["peerDependencies"] = Object.fromEntries(Object.entries(peers).sort(([a], [b]) => a.localeCompare(b)));
			await fs.writeFile(manifestPath, JSON.stringify(manifest, undefined, 2) + "\n");

			// Then install with pnpm, like the install that built util/node_modules (root postinstall: `pnpm
			// --ignore-workspace install` per package; npm writing into a pnpm tree can crash reading its layout). pnpm's
			// autoInstallPeers installs the project's own missing peer; everything already present is only relinked, and
			// --ignore-scripts skips re-running every dependency's build. --no-frozen-lockfile: in CI pnpm defaults to a
			// frozen lockfile, which refuses exactly the manifest change we just made (ERR_PNPM_OUTDATED_LOCKFILE).
			const install = ["--ignore-workspace", "install", "--ignore-scripts", "--no-frozen-lockfile"];

			console.log(">", ["pnpm", ...install].join(" "), `(after adding peer ${packageName})`);
			const subprocess = spawn("pnpm", install, {
				"cwd": path.join(__root, "util"),
				"shell": true,
				"stdio": "inherit"
			});

			await new Promise(function(resolve, reject) {
				subprocess.on("close", resolve);
			});

			console.log(">", command.join(" "));
			process = spawn(command[0], command.slice(1), {
				"shell": true
				//"stdio": "inherit"
			});

			recurse(resolve, reject);
		});
	});
}
