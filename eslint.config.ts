import { defineConfig, globalIgnores } from "eslint/config";
import config from "./util/eslint";

export default defineConfig([
	globalIgnores(["archive/**", "components/monaco-vscode-api/**", "test/runtime/deno.ts", "util/bottleneck.ts"]),
	...config
]);
