import { realpathSync } from "fs";
import * as url from "url";
import { serve } from "../vite/dev";

/**
 * The `util-dev` bin. Run from a package directory (`"dev": "util-dev"`) to serve
 * that package (its cwd) with the shared Vite dev server. A package that needs more
 * imports `serve` from `@brianjenkins94/util/vite/dev` and composes its own dev
 * script — see games/war2/scripts/dev.ts (PeerJS broker + debug server).
 */
if (process.argv[1] !== undefined && import.meta.url === url.pathToFileURL(realpathSync(process.argv[1])).toString()) {
    await serve(process.cwd());
}
