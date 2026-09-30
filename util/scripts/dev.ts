import { isEntry } from "@brianjenkins94/util/env";
import { serve } from "@brianjenkins94/util/vite/dev";

/**
 * The `util-dev` bin. Run from a package directory (`"dev": "util-dev"`) to serve
 * that package (its cwd) with the shared Vite dev server — on `--port <n>` or `$PORT`, else 5173 (which an editor's
 * own dev server may hold). A package that needs more imports `serve` from `@brianjenkins94/util/vite/dev` and
 * composes its own dev script — see games/war2/scripts/dev.ts (PeerJS broker + debug server).
 */
export function devPort(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
	const flag = argv.findIndex((argument) => argument === "--port" || argument.startsWith("--port="));
	const value = flag === -1 ? env["PORT"] : argv[flag]!.includes("=") ? argv[flag]!.slice("--port=".length) : argv[flag + 1];
	const port = Number(value);

	return Number.isInteger(port) && port >= 0 && value !== undefined && value !== "" ? port : 5173;
}

if (isEntry(import.meta)) {
	await serve(process.cwd(), devPort());
}
