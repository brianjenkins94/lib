import { defineConfig } from "tsup";
import { esbuildOptions } from "./util/esbuild";
import { precompile } from "./util/esbuild/plugins/precompile";

export default defineConfig({
	"format": "esm",
	"treeshake": true,
	"esbuildOptions": esbuildOptions(),
	"esbuildPlugins": [
		precompile()
	]
});
