import { isEntry } from "@brianjenkins94/util/env";
import { serve } from "@brianjenkins94/util/vite/dev";

/**
 * The `util-dev` bin. Run from a package directory (`"dev": "util-dev"`) to serve
 * that package (its cwd) with the shared Vite dev server. A package that needs more
 * imports `serve` from `@brianjenkins94/util/vite/dev` and composes its own dev
 * script — see games/war2/scripts/dev.ts (PeerJS broker + debug server).
 */
if (isEntry(import.meta)) {
	await serve(process.cwd());
}
