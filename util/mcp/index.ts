/**
 * Serving an MCP server — the transport half, on top of the tool MODEL in `./tool` (definition +
 * registration + MRTR) and the discovery/resolver in `util/router/core` (one walk, one hot-reload path
 * shared with HTTP routing). This file owns only HOW a server is served, not what a tool is.
 *
 * A server is `server.ts` (config + its own auth/request) + a `tools/` dir of one-file-each tools.
 * `serveMcp` runs it one of two ways:
 *   - production (NODE_ENV=production): plain stdio — simplest, fastest boot.
 *   - dev (default): the Vite/HTTP bridge (see bridge.ts) — a persistent streaming `/mcp` session
 *     (required for elicitation) whose tools still hot-reload per call AND whose breakpoints bind
 *     (Vite SSR keeps stable module identity + source maps; cache-busted re-import does NOT).
 *
 * Auth is deliberately NOT here — it differs per server (OAuth for mail, CDP/fido for admin).
 */

import type { McpTool } from "./tool";
import * as path from "node:path";
import * as url from "node:url";
import { isEntry } from "@brianjenkins94/util/env";
import { discover } from "@brianjenkins94/util/router/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { attachLogging, configureServerRuns, registerTool, toolsFromDefault } from "./tool";

// Re-export the tool model so `@brianjenkins94/util/mcp` stays the public authoring surface — a tool
// file `import { defineTool, ok, fail } from "@brianjenkins94/util/mcp"` keeps working unchanged.
export * from "./tool";

// Only `url` — we deliberately do NOT read `import.meta.env` here: Vite's SSR module runner supports
// only the static `import.meta.env.SSR` (a compile-time replacement), so reading `.env` off a passed-in
// meta throws. The Vite-pass detection uses a module-level flag instead (see serveMcp).
export interface EntryMeta { "url": string }

export interface ServeOptions {
	"name": string;
	"version": string;
	/** Port for the dev bridge's HTTP server. */
	"port"?: number;
	/** Defaults to ./tools next to the entry's import.meta.url. */
	"toolsDir"?: string;
	/** Force the bridge on/off. Default: on unless NODE_ENV=production. */
	"bridge"?: boolean;
	/** Runtime capability broker: gate tools' node-side net calls (BERNARD/JUDICIAL + MRTR). Default: on.
	 *  Set false to opt out; `JUDICIAL=allow` keeps it on but auto-approves (no prompts). */
	"broker"?: boolean;
}

/**
 * Discover tool files in a dir (RECURSIVELY, via the shared `util/router/core` walk) and load each via
 * `load` (fs import for stdio, Vite SSR for the bridge). This runs at session start, so it picks up files
 * that exist at boot — a file ADDED at runtime is registered live via context.addTool/updateTool instead,
 * and discovered here on the next boot.
 */
export async function eachToolFile(dir: string, load: (absPath: string) => Promise<{ "default"?: McpTool | McpTool[] }>): Promise<McpTool[]> {
	const tools: McpTool[] = [];

	for (const absPath of await discover(dir)) {
		const mod = await load(absPath);

		tools.push(...toolsFromDefault(mod.default));
	}

	return tools;
}

/** stdout is the JSON-RPC channel — route stray logs to stderr so nothing corrupts the protocol. */
export function silenceStdout(): void {
	for (const level of ["log", "info", "debug"] as const) {
		console[level] = (...args: unknown[]) => process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
	}
}

async function runStdio(meta: EntryMeta, options: ServeOptions): Promise<void> {
	silenceStdout();

	const dir = options.toolsDir ?? path.join(path.dirname(url.fileURLToPath(meta.url)), "tools");
	const server = new McpServer({ "name": options.name, "version": options.version }, { "capabilities": { "logging": {} } });

	// Point the run ledger at the server's own dir (`.silo/runs.jsonl`) — every tool invocation is recorded there.
	// The capability broker is DEV-ONLY (it rides the Vite bridge's builtin-rewrite), so stdio/production does
	// not gate — it trusts tools already reviewed in dev, and keeps the registration gate + ledger.
	configureServerRuns(server, path.dirname(url.fileURLToPath(meta.url)));

	const tools = await eachToolFile(dir, (abs) => import(url.pathToFileURL(abs).href));

	for (const tool of tools) {
		registerTool(server, tool);
	}

	await server.connect(new StdioServerTransport());
	attachLogging(server);
	process.stderr.write(`${options.name} MCP: stdio server ready\n`);
}

/**
 * Boot the server. Dev → Vite/HTTP bridge (hot-reload + breakpoints + curl-able /mcp); production →
 * plain stdio. Pass `import.meta` (we read `.url` to tell the entry from a mere import).
 */
export async function serveMcp(meta: EntryMeta, options: ServeOptions): Promise<void> {
	// Boots only when this module is the process entry (tsx) or the bridge is re-entering it under SSR —
	// NOT when merely imported (e.g. a CLI that pulls in the server's exports). On failure this rejects;
	// the caller owns the exit policy.
	const entry = isEntry(meta);
	const useBridge = options.bridge ?? (process.env["NODE_ENV"] !== "production");

	if (useBridge) {
		// Merely imported → no-op, don't even load Vite. The SSR re-entry is still the entry
		// (Vite gives the re-entered module the entry's own file URL), so this guard only stops imports.
		if (!entry) {
			return;
		}

		// First (tsx) pass: bootstrapOrRun creates Vite + re-enters via SSR and returns true → done, the
		// re-entry serves — so this pass never even loads the bridge. Re-entry pass: returns false →
		// load + run the bridge. (Both imports stay dynamic so `vite` never reaches the cheap paths —
		// tool files importing defineTool/ok, plain stdio, the no-op import above.)
		const { bootstrapOrRun } = await import("@brianjenkins94/util/vite/dev");

		// Dev-only capability gating (bootstrapOrRun no-ops in production): inject the Vite plugin that rewrites
		// a TOOL module's node:fs / node:child_process to the broker-gated shim, scoped to the tools dir. Off
		// when the broker is disabled. The in-process, HMR-preserving replacement for a pre-bundle box.
		const dir = path.dirname(url.fileURLToPath(meta.url));
		const toolsDir = (options.toolsDir ?? path.join(dir, "tools")).replace(/\\/gu, "/");
		const plugins: unknown[] = [];

		if (options.broker !== false) {
			const { gateBuiltins } = await import("@brianjenkins94/util/vite/plugins/gateBuiltins");

			plugins.push(gateBuiltins({ "shouldGate": (importer: string) => importer.replace(/\\/gu, "/").includes(toolsDir) }));
		}

		if (await bootstrapOrRun(meta.url, dir, plugins as never)) {
			return;
		}

		const { runBridge } = await import("./bridge.js");

		await runBridge(meta, options);

		return;
	}

	if (!entry) {
		return; // merely imported
	}

	await runStdio(meta, options);
}
