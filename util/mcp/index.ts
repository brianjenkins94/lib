/**
 * Shared MCP plumbing — the reusable half of an MCP server, headed for @brianjenkins94/util/mcp.
 *
 * A server is `server.ts` (config + its own auth/request) + a `tools/` dir of one-file-each tools.
 * `serveMcp` runs it one of two ways:
 *   - production (NODE_ENV=production): plain stdio — simplest, fastest boot.
 *   - dev (default): the Vite/HTTP bridge (see bridge.ts) — `POST /mcp` rebuilt per request so tool
 *     edits hot-reload AND breakpoints bind (Vite SSR keeps stable module identity + source maps;
 *     cache-busted re-import does NOT, which is why plain hot-reload couldn't hit breakpoints).
 *
 * Auth is deliberately NOT here — it differs per server (OAuth for mail, CDP/fido for admin).
 */

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export type ToolResult = { content: { type: "text", text: string }[], isError?: boolean };

export interface McpTool {
	name: string;
	config: { title?: string; description: string; inputSchema: Record<string, unknown> };
	handler: (args: any) => ToolResult | Promise<ToolResult>;
}

export interface ServeOptions {
	name: string;
	version: string;
	/** Port for the dev bridge's HTTP server. */
	port?: number;
	/** Defaults to ./tools next to the entry's import.meta.url. */
	toolsDir?: string;
	/** Force the bridge on/off. Default: on unless NODE_ENV=production. */
	bridge?: boolean;
}

// Only `url` — we deliberately do NOT read `import.meta.env` here: Vite's SSR module runner supports
// only the static `import.meta.env.SSR` (a compile-time replacement), so reading `.env` off a passed-in
// meta throws. The Vite-pass detection uses a module-level flag instead (see serveMcp).
export type EntryMeta = { url: string };

/** Identity helper that gives a tool file its type + `export default defineTool({...})` shape. */
export function defineTool(tool: McpTool): McpTool {
	return tool;
}

/** Wrap a value (or a promise of one) as a successful JSON tool result. */
export async function ok(value: unknown): Promise<ToolResult> {
	return { "content": [{ "type": "text", "text": JSON.stringify(await value, undefined, 2) }] };
}

export function fail(message: string): ToolResult {
	return { "content": [{ "type": "text", "text": message }], "isError": true };
}

/** A tool file default-exports one tool or an array of them (admin's uniform GETs are a table). */
export function toolsFromDefault(value: McpTool | McpTool[] | undefined): McpTool[] {
	return Array.isArray(value) ? value : value ? [value] : [];
}

/** Register one tool on a server, wrapping its handler so thrown errors become an isError result. */
export function registerTool(server: McpServer, tool: McpTool): void {
	server.registerTool(tool.name, tool.config as any, async (args: unknown) => {
		try {
			return await tool.handler(args);
		} catch (error) {
			return fail(`${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

/** Discover tool files in a dir and load each via `load` (fs import for stdio, Vite SSR for the bridge). */
export async function eachToolFile(dir: string, load: (absPath: string) => Promise<{ default?: McpTool | McpTool[] }>): Promise<McpTool[]> {
	const tools: McpTool[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!/\.(ts|mts|js|mjs)$/u.test(file) || file.endsWith(".d.ts")) {
			continue;
		}
		const mod = await load(join(dir, file));
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

	const dir = options.toolsDir ?? join(dirname(fileURLToPath(meta.url)), "tools");
	const server = new McpServer({ "name": options.name, "version": options.version });

	const tools = await eachToolFile(dir, (abs) => import(pathToFileURL(abs).href));
	for (const tool of tools) {
		registerTool(server, tool);
	}

	await server.connect(new StdioServerTransport());
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
	const isEntry = Boolean(process.argv[1]) && meta.url === pathToFileURL(process.argv[1]).href;
	const useBridge = options.bridge ?? (process.env["NODE_ENV"] !== "production");

	if (useBridge) {
		// Merely imported → no-op, don't even load Vite. The SSR re-entry still has isEntry === true
		// (Vite gives the re-entered module the entry's own file URL), so this guard only stops imports.
		if (!isEntry) {
			return;
		}

		// First (tsx) pass: bootstrapOrRun creates Vite + re-enters via SSR and returns true → done, the
		// re-entry serves — so this pass never even loads the bridge. Re-entry pass: returns false →
		// load + run the bridge. (Both imports stay dynamic so `vite` never reaches the cheap paths —
		// tool files importing defineTool/ok, plain stdio, the no-op import above.)
		const { bootstrapOrRun } = await import("../vite/dev.js");
		if (await bootstrapOrRun(meta.url, dirname(fileURLToPath(meta.url)))) {
			return;
		}

		const { runBridge } = await import("./bridge.js");
		await runBridge(meta, options);
		return;
	}

	if (!isEntry) {
		return; // merely imported
	}
	await runStdio(meta, options);
}
