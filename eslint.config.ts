import { defineConfig, globalIgnores } from "eslint/config";
import config from "./util/eslint";

export default defineConfig([
	globalIgnores(["archive/**", "components/monaco-vscode-api/**", "test/runtime/deno.ts", "util/bottleneck.ts"]),
	...config,
	// The fs wrapper re-exports node fs (it IS the wrapper); store.ts is sync-bound (readFileSync in a constructor,
	// unlinkSync in a process `exit` handler — neither can be async). Both are legitimately allowed to import node fs.
	{ "files": ["util/fs.ts", "util/store.ts"], "rules": { "ts/no-restricted-imports": "off" } },
	// Lib-only: force the @brianjenkins94/util/* alias over relative CROSS-directory imports (../ and deeper) — the
	// alias reads clearer and survives file moves. Same-dir ./siblings stay relative (the alias only adds verbosity
	// there), EXCEPT ./fs: the fs wrapper is alias-only everywhere so import-style's single-key namespace check
	// can't be skipped by a relative form. (Downstream repos never had a relative wrapper, so this is lib-scoped.)
	{ "files": ["util/**/*.?([cm])ts?(x)"], "rules": { "no-restricted-imports": ["error", { "patterns": [{ "group": ["../**"], "message": "Use the @brianjenkins94/util/* alias for cross-directory imports (not a relative ../ path)." }, { "group": ["./fs"], "message": "Import the fs wrapper via its alias: @brianjenkins94/util/fs (not a relative path)." }] }] } }
]);
