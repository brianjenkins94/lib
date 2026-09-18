/**
 * Capability interception surface — which node builtin methods each capability covers, and how to build a
 * canonical scope from a call. Hoisted from the `silo` prototype's enforce/preload.mjs so every binding
 * (almostnode shims, the --import preload, the service-worker fetch gate) instruments the SAME method set
 * and emits the SAME scope strings that decide.mjs's redline and broker.gate consume. Single source of
 * truth for "which call is which capability".
 *
 * Pure data + string builders — no node, no imports — so it loads unchanged in the browser.
 */

/** fs methods → the fs op they perform (read | write). */
export const CAP_FS = {
	"readFileSync": "read",
	"readFile": "read",
	"existsSync": "read",
	"statSync": "read",
	"readdirSync": "read",
	"createReadStream": "read",
	"writeFileSync": "write",
	"writeFile": "write",
	"appendFileSync": "write",
	"appendFile": "write",
	"mkdirSync": "write",
	"unlinkSync": "write",
	"rmSync": "write",
	"renameSync": "write",
	"createWriteStream": "write"
};

/** child_process methods that spawn a process. */
export const CAP_EXEC = new Set(["execFileSync", "execSync", "exec", "execFile", "spawnSync", "spawn", "fork"]);

/** Canonical scope builders — match decide.mjs's redline vocabulary exactly. */
export const fsScope = (op, path) => "fs:" + op + ":" + path;
export const netScope = (host) => "net:" + host;
export const execScope = (bin) => "exec:" + bin;
export const evalScope = (kind) => "eval:" + kind;

/** Host (with port) from a fetch input (URL string or Request-like), or `*` when indeterminate — which is
 *  itself a redline (`net:*`), so an unparseable target fails safe. */
export function hostOf(input) {
	try {
		const url = typeof input === "string" ? input : input.url;

		return new URL(url).host || "*";
	} catch {
		return "*";
	}
}
