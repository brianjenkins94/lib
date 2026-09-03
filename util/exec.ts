/**
 * The child_process facade — so you never think about spawn vs exec vs execFile again. Three entry points:
 * `exec` (async) when you want the OUTPUT or exit code, `fire` (async, did-it-succeed) when you just want a
 * yes/no, and `launch` when you want to start a DETACHED process that outlives you (a browser, an opened URL).
 * All make the `shell` decision ONCE, correctly, in `shellFor` — instead of each call site remembering it.
 * `exec` returns a uniform `ExecResult` (the "give me stdout" and "what was the exit code" call patterns are
 * just fields on it); `fire` runs and reports only success; `launch` returns the (unref'd) child.
 *
 * THE shell fix: npm-ecosystem CLIs (`npm`/`pnpm`/`npx`/`yarn`) are `.cmd` shims on Windows, and since
 * CVE-2024-27980 `spawn` *requires* `shell: true` to run a `.cmd` (it throws EINVAL otherwise). Native
 * binaries never need it. So `shellFor` turns the shell on exactly for the shim family on Windows — and
 * because shelling makes the OS re-parse the joined command, args are quoted first (`prep`).
 */

import * as cp from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";

import { isWindows } from "@brianjenkins94/util/env";

/** npm-ecosystem CLIs that ship as Windows `.cmd`/`.ps1` shims and therefore need a shell to spawn. */
const SHIMS = new Set(["npm", "npx", "pnpm", "pnpx", "yarn"]);

export interface ExecOptions {
	"cwd"?: string;
	"env"?: NodeJS.ProcessEnv;
	/** stdin piped to the process. */
	"input"?: string;
	/** Force the shell on/off. Default: on for an npm-family shim on Windows (required — see the module note). */
	"shell"?: boolean;
	/** How to wire stdio. `pipe` (default) collects stdout/stderr; `inherit` streams to the parent; `ignore` drops. */
	"stdio"?: "pipe" | "inherit" | "ignore";
	/** SIGKILL the process if it is still running after this many ms; the result then has `timedOut: true`. */
	"timeoutMs"?: number;
}

export interface ExecResult {
	"command": string;
	/** Exit code (0 = success); the signal-killed case surfaces as a non-zero fallback. */
	"exitCode": number;
	/** Trimmed stdout (empty when stdio isn't `pipe`). */
	"stdout": string;
	/** Trimmed stderr (empty when stdio isn't `pipe`). */
	"stderr": string;
	"ok": boolean;
	/** True when `timeoutMs` elapsed and the process was killed (exitCode is then the non-zero fallback). */
	"timedOut": boolean;
}

/** The one shell decision (see the module note): honor an explicit `opts.shell`, else shell iff it's an
 *  npm-family shim on Windows. */
function shellFor(command: string, opts: ExecOptions): boolean {
	return opts.shell ?? (isWindows && SHIMS.has(command));
}

/** When shelling, the OS joins command + args into a string and re-splits it, so quote any arg that would
 *  otherwise word-split or trip a metacharacter. Simple cross-platform double-quoting — enough for the
 *  flag-shaped args these commands take; a pathological arg on cmd.exe is the known edge. */
function quote(arg: string): string {
	return /[\s"'`$&|;<>(){}!^%]/u.test(arg) ? `"${arg.replace(/(["\\])/gu, "\\$1")}"` : arg;
}

const prep = (args: string[], shell: boolean): string[] => (shell ? args.map(quote) : args);

/**
 * Run a command to completion, ASYNC. Resolves with the full `ExecResult` on ANY exit (a non-zero exit is NOT
 * an error — read `.ok`/`.exitCode`); it REJECTS only if the process can't be spawned (ENOENT, EACCES, …) —
 * which is the error handler the hand-rolled `new Promise(spawn…)` wrappers kept forgetting, hanging forever.
 */
export function exec(command: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
	const shell = shellFor(command, opts);
	const stdio = opts.stdio ?? "pipe";
	const child = cp.spawn(command, prep(args, shell), { "cwd": opts.cwd, "env": opts.env, "shell": shell, "stdio": opts.input !== undefined && stdio === "inherit" ? ["pipe", "inherit", "inherit"] : stdio });

	if (opts.input !== undefined) { child.stdin?.end(opts.input); }

	let timedOut = false;
	const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);

	return new Promise((resolve, reject) => {
		child.once("error", (error) => { clearTimeout(timer); reject(error); });   // ENOENT/EACCES etc. — reject instead of hanging

		// `text` (node:stream/consumers) consumes each stream to a string — no manual on("data") accumulation.
		// A pipe-less stdio (inherit/ignore) has no stream, so those resolve to "".
		Promise.all([
			child.stdout ? text(child.stdout) : Promise.resolve(""),
			child.stderr ? text(child.stderr) : Promise.resolve(""),
			once(child, "close")
		]).then(([stdout, stderr, [code]]) => {
			clearTimeout(timer);
			resolve({ "command": command, "exitCode": (code as number | null) ?? 1, "stdout": stdout.trim(), "stderr": stderr.trim(), "ok": code === 0, "timedOut": timedOut });
		}, reject);
	});
}

/**
 * Launch a long-lived / DETACHED process (`spawn` + `unref`, returns the child) — the third shape, for the
 * fire-and-OUTLIVE cases you neither await nor read: opening a URL, starting a browser. Set `detached`/`stdio`
 * per the platform (macOS `open(1)` wants neither; xdg-open/a browser wants both); `unref` is always applied
 * so the parent process can exit. Shell handling matches `exec` (an npm-family shim auto-shells).
 */
export function launch(command: string, args: string[] = [], opts: cp.SpawnOptions = {}): cp.ChildProcess {
	const shell = opts.shell ?? shellFor(command, {});
	const child = cp.spawn(command, prep(args, Boolean(shell)), { ...opts, "shell": shell });

	child.unref();

	return child;
}

/** Fire a command and report ONLY whether it succeeded (exit 0) — output discarded, a spawn error counts as
 *  failure. "Run it and tell me if it worked" (e.g. does this release/tag exist, are these files identical). */
export function fire(command: string, args: string[] = [], opts: ExecOptions = {}): Promise<boolean> {
	const shell = shellFor(command, opts);

	return new Promise((resolve) => {
		const child = cp.spawn(command, prep(args, shell), { "cwd": opts.cwd, "env": opts.env, "shell": shell, "stdio": "ignore" });

		child.on("error", () => { resolve(false); });
		child.on("close", (code) => { resolve(code === 0); });
	});
}
