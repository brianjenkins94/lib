import { registerHooks } from "node:module";

// Keep util's own files from resolving packages out of the repo root's node_modules: Node walks up past
// util/node_modules to lib/node_modules, where the root's devDependencies would quietly satisfy an import util never
// declared. Failing it like a genuinely missing package ("Cannot find package '…'") hands it to node.ts to add as a peer.
// Only util's own source is held to this — a dependency inside util/node_modules resolves however it likes.
const root = new URL("../../node_modules/", import.meta.url).href;
const util = new URL("../../util/", import.meta.url).href;

registerHooks({
	"resolve": function(specifier, context, nextResolve) {
		const result = nextResolve(specifier, context);
		const parentURL = context.parentURL ?? "";

		if (result.url.startsWith(root) && parentURL.startsWith(util) && !parentURL.includes("/node_modules/")) {
			const packageName = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
			const message = `Cannot find package '${packageName}' imported from ${parentURL} (only the repo root's node_modules has it)`;
			// Node prints the line that constructed the error above the message, and node.ts takes the first '…' on
			// stderr as the package name — so that line must not contain one.
			const error = new Error(message);

			error.code = "ERR_MODULE_NOT_FOUND";

			throw error;
		}

		return result;
	}
});
