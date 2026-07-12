/**
 * The dev bridge: a Vite/HTTP MCP server with a stdio front-end.
 *
 * Why Vite (not cache-busted re-import): breakpoints. The inspector binds a breakpoint to a file
 * URL; `import('./tool.ts?v=123')` is a new URL each time, so editor breakpoints never attach. Vite
 * SSR keeps stable module identity + source maps, so breakpoints in server.ts and tools/*.ts bind —
 * and edits hot-reload. The shared plumbing (this package) is externalized so Vite doesn't try to
 * transform itself; only the consumer's server.ts + tools/ (inside the Vite root) get transformed.
 *
 * Quine: tsx runs server.ts → serveMcp → bootstrapOrRun (util/vite/dev) creates Vite and re-enters
 * server.ts through SSR → serveMcp (second pass) → runBridge actually boots. The two passes are told
 * apart by a module-level flag in bootstrapOrRun, NOT import.meta.env.SSR — Vite's module runner forbids
 * reading import.meta.env dynamically off a passed-in meta. One server on POST /mcp (rebuilt per request from
 * the current tools); stdio is bridged to it so Claude — and `curl localhost:PORT/mcp` — both hit the
 * same hot-reloading endpoint.
 */

import type { EntryMeta, ServeOptions } from "./index";
import * as path from "node:path";
import * as url from "node:url";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../server";
import { getViteDevServer } from "../vite/dev";
import { eachToolFile, registerTool, silenceStdout } from "./index";

// The dev quine (bootstrapOrRun) lives in util/vite/dev — shared with the express app; serveMcp imports
// it from there directly. Node-module deps — including @brianjenkins94/util itself — are externalized by
// Vite's SSR default, so no ssr.external is needed (the old override existed only for the file:-link era).

/** Vite root-relative module URL (what ssrLoadModule wants), e.g. /server.ts or /tools/list.ts. */
function viteUrl(root: string, absPath: string): string {
	return "/" + path.relative(root, absPath).replace(/\\/gu, "/");
}

/** Second pass (Vite SSR): boot POST /mcp (per-request rebuild → hot-reload) + the stdio bridge. */
export async function runBridge(meta: EntryMeta, options: ServeOptions): Promise<void> {
	silenceStdout();

	const root = path.dirname(url.fileURLToPath(meta.url));
	const vite = await getViteDevServer(root);
	const toolsDir = options.toolsDir ?? path.join(root, "tools");
	const port = options.port ?? 3000;

	// Rebuilt per request: ssrLoadModule re-evaluates a tool after you edit it (Vite invalidates it),
	// so the next call runs the new code — with breakpoints.
	async function buildServer(): Promise<McpServer> {
		const server = new McpServer({ "name": options.name, "version": options.version });
		const tools = await eachToolFile(toolsDir, (abs) => vite.ssrLoadModule(viteUrl(root, abs)));

		for (const tool of tools) {
			registerTool(server, tool);
		}

		return server;
	}

	// util/server gives routing + request.json(); the MCP transport writes the response itself, so the
	// handler returns nothing and util/server leaves the already-sent response alone.
	const app = createServer();

	app.post("/mcp", async (request: any, response: any) => {
		try {
			const body = await request.json();
			const transport = new StreamableHTTPServerTransport({ "sessionIdGenerator": undefined, "enableJsonResponse": true });
			const server = await buildServer();

			response.on("close", () => { transport.close(); server.close(); });
			await server.connect(transport);
			await transport.handleRequest(request, response, body);
		} catch (error) {
			vite.ssrFixStacktrace?.(error as Error); // map the stack back to TS source for readable dev errors
			throw error;
		}
	});

	await new Promise<void>((resolve, reject) => {
		const httpServer = app.listen(port, () => { resolve(); });

		httpServer.on("error", (err: NodeJS.ErrnoException) => {
			// Port taken → a sibling instance already serves /mcp; bridge to it.
			if (err.code === "EADDRINUSE") { process.stderr.write(`${options.name} MCP: port ${port} in use — bridging to existing\n`); resolve(); } else { reject(err); }
		});
	});

	// stdio ⇄ HTTP bridge: Claude speaks stdio; forward every JSON-RPC message to our own /mcp.
	const httpClient = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
	const stdio = new StdioServerTransport();

	const warn = (label: string) => (error: unknown) => process.stderr.write(`${options.name} MCP bridge (${label}): ${error instanceof Error ? error.message : String(error)}\n`);

	stdio.onmessage = (message) => { httpClient.send(message).catch(warn("stdin→http")); };
	httpClient.onmessage = (message) => { stdio.send(message).catch(warn("http→stdout")); };
	stdio.onerror = warn("stdio");
	httpClient.onerror = (error) => {
		// The client probes for an optional server→client SSE stream (GET /mcp); we're JSON-only, so it
		// 404s — expected and harmless.
		if (/SSE stream/iu.test(error instanceof Error ? error.message : String(error))) { return; }
		warn("http")(error);
	};

	stdio.onclose = () => { httpClient.close().catch(warn("close http")); };
	httpClient.onclose = () => { stdio.close().catch(warn("close stdio")); };

	await httpClient.start();
	await stdio.start();

	process.stderr.write(`${options.name} MCP: stdio ⇄ http://localhost:${port}/mcp bridge ready\n`);
}
