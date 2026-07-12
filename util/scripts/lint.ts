import * as path from "node:path";
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

// Root tsconfig the preset's type-aware linting needs (extends @tsconfig/node-lts, which util depends on).
// Without it EVERY .ts file throws "Could not read Project Service default project". 2-space to satisfy jsonc/indent.
const TSCONFIG = `{
  "extends": "@tsconfig/node-lts/tsconfig.json",
  "compilerOptions": {
    "alwaysStrict": true,
    "forceConsistentCasingInFileNames": false,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noPropertyAccessFromIndexSignature": true,
    "resolveJsonModule": true,
    "strict": false,
    "strictBindCallApply": true,
    "strictFunctionTypes": true,
    "target": "ESNext"
  }
}
`;

// Editor parity: make the VS Code ESLint extension lint the same file types as the CLI, auto-fix on save, and
// stay quiet about warnings (they're either auto-fixed formatting or accepted squelch/downgrade debt).
const VSCODE_ESLINT: Record<string, unknown> = {
	"eslint.useFlatConfig": true,
	"eslint.validate": ["javascript", "javascriptreact", "typescript", "typescriptreact", "yaml", "json", "jsonc", "markdown"],
	"eslint.quiet": true,
	"editor.codeActionsOnSave": { "source.fixAll.eslint": "explicit" }
};

/**
 * Make the preset work out of the box: type-aware linting needs a root tsconfig.json, and the editor needs
 * ESLint settings to match the CLI. Both are created only if absent (idempotent, non-destructive) — the tsconfig
 * always (CI's type-aware lint needs it too), the .vscode settings only when NOT on CI (no editor there), merging
 * missing keys into an existing settings.json rather than clobbering it.
 */
async function ensureScaffold(cwd: string) {
	try {
		const tsconfigPath = path.join(cwd, "tsconfig.json");

		if (!fs.existsSync(tsconfigPath)) {
			await fs.writeFile(tsconfigPath, TSCONFIG);
			process.stderr.write("util-lint: created tsconfig.json (type-aware linting needs it)\n");
		}

		if (process.env["CI"]) {
			return;
		}

		const settingsPath = path.join(cwd, ".vscode", "settings.json");
		let settings: Record<string, unknown> = {};
		const existing = fs.existsSync(settingsPath);

		if (existing) {
			try {
				settings = JSON.parse(await fs.readFile(settingsPath));
			} catch {
				return; // an unparseable (comments/trailing-comma) settings.json — leave it be
			}
		} else {
			await fs.mkdir(path.join(cwd, ".vscode"), { "recursive": true });
		}

		let changed = false;

		for (const [key, value] of Object.entries(VSCODE_ESLINT)) {
			if (!(key in settings)) {
				settings[key] = value;
				changed = true;
			}
		}

		if (changed) {
			await fs.writeFile(settingsPath, JSON.stringify(settings, undefined, 2) + "\n");
			process.stderr.write("util-lint: " + (existing ? "added ESLint keys to" : "created") + " .vscode/settings.json\n");
		}
	} catch (error) {
		process.stderr.write("util-lint: scaffold skipped (" + (error instanceof Error ? error.message : String(error)) + ")\n");
	}
}

if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(await fs.realpath(process.argv[1])).toString()) {
	const args = process.argv.slice(2);
	const positional = args.filter((argument) => !argument.startsWith("-"));

	await ensureScaffold(process.cwd());

	const errorCount = await lint({
		"fix": args.includes("--fix"),
		"patterns": positional.length > 0 ? positional : ["."]
	});

	process.exitCode = errorCount > 0 ? 1 : 0;
}
