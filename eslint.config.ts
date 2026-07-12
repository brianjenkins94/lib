import { defineConfig, globalIgnores } from "eslint/config";
import config from "./util/eslint";

export default defineConfig([
	globalIgnores(["archive/**", "components/monaco-vscode-api/**", "test/runtime/deno.ts", "util/bottleneck.ts"]),
	...config,
	// The fs wrapper re-exports node fs (it IS the wrapper); store.ts is sync-bound (readFileSync in a constructor,
	// unlinkSync in a process `exit` handler — neither can be async). Both are legitimately allowed to import node fs.
	{ "files": ["util/fs.ts", "util/store.ts"], "rules": { "ts/no-restricted-imports": "off" } }
]);
