/**
 * The dev bridge: a Vite/HTTP MCP server with a stdio front-end.
 *
 * Why Vite (not cache-busted re-import): breakpoints. The inspector binds a breakpoint to a file
 * URL; `import('./tool.ts?v=123')` is a new URL each time, so editor breakpoints never attach. Vite
 * SSR keeps stable module identity + source maps, so breakpoints in server.ts and tools/*.ts bind —
 * and edits hot-reload. The shared plumbing (this package) is externalized so Vite doesn't try to
 * transform itself; only the consumer's server.ts + tools/ (inside the Vite root) get transformed.
 *
 * Streaming + stateful (was: JSON, per-request rebuild). Elicitation is a server→client request: it
 * rides the tool call's SSE stream, and the human's reply comes back as a SEPARATE POST that must
 * reach the SAME server instance — so `/mcp` now runs a persistent, session-keyed StreamableHTTP
 * transport instead of a fresh one per request. Hot-reload is preserved a level down: the registered
 * tool list is fixed at session start, but each INVOCATION reloads its tool module (see makeToolCallback
 * + currentTools), so tool-body edits still take effect live. Changing a tool's schema, or adding/
 * removing a tool file, needs a restart.
 *
 * Quine: tsx runs server.ts → serveMcp → bootstrapOrRun (util/vite/dev) creates Vite and re-enters
 * server.ts through SSR → serveMcp (second pass) → runBridge actually boots. The two passes are told
 * apart by a module-level flag in bootstrapOrRun, NOT import.meta.env.SSR. stdio is bridged to /mcp so
 * Claude — and `curl localhost:PORT/mcp` — both hit the same hot-reloading endpoint.
 */

import type { EntryMeta, ServeOptions } from "./index";
import * as path from "node:path";
import * as url from "node:url";
import { createServer } from "@brianjenkins94/util/server";
import { getViteDevServer } from "@brianjenkins94/util/vite/dev";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { eachToolFile, registerResolvingTool, silenceStdout } from "./index";

// The dev quine (bootstrapOrRun) lives in util/vite/dev — shared with the express app; serveMcp imports
// it from there directly. Node-module deps — including @brianjenkins94/util itself — are externalized by
// Vite's SSR default, so no ssr.external is needed (the old override existed only for the file:-link era).

/** Vite root-relative module URL (what ssrLoadModule wants), e.g. /server.ts or /tools/list.ts. */
function viteUrl(root: string, absPath: string): string {
	return "/" + path.relative(root, absPath).replace(/\\/gu, "/");
}

/** Second pass (Vite SSR): boot POST/GET/DELETE /mcp (persistent streaming session) + the stdio bridge. */
export async function runBridge(meta: EntryMeta, options: ServeOptions): Promise<void> {
	silenceStdout();

	const root = path.dirname(url.fileURLToPath(meta.url));
	const vite = await getViteDevServer(root);
	const toolsDir = options.toolsDir ?? path.join(root, "tools");
	const port = options.port ?? 3000;

	// Reload every tool module fresh: ssrLoadModule returns the new code after an edit (Vite invalidates
	// it) and the cached module otherwise, so this is cheap. Called once at session start to register the
	// tools, and again per invocation (via makeToolCallback's resolve) so a tool-body edit runs the new
	// code even though the server/session is now persistent.
	const currentTools = () => eachToolFile(toolsDir, (abs) => vite.ssrLoadModule(viteUrl(root, abs)));

	async function buildServer(): Promise<McpServer> {
		const server = new McpServer({ "name": options.name, "version": options.version });

		for (const tool of await currentTools()) {
			registerResolvingTool(server, tool.name, tool.config, async () => (await currentTools()).find((candidate) => candidate.name === tool.name));
		}

		return server;
	}

	// One StreamableHTTP transport per MCP session. A single stdio front-end drives one session; a second
	// front-end that bridges to this same HTTP server (EADDRINUSE path below) initializes its own.
	const sessions = new Map<string, StreamableHTTPServerTransport>();

	async function handle(request: any, response: any, body?: unknown): Promise<void> {
		const sessionId = request.headers["mcp-session-id"] as string | undefined;
		let transport = sessionId !== undefined ? sessions.get(sessionId) : undefined;

		if (transport === undefined && body !== undefined && isInitializeRequest(body)) {
			transport = new StreamableHTTPServerTransport({
				// Streaming (SSE) is the transport default — required so a tool call's response stream can
				// carry the server→client elicitation request back to the client (do not set enableJsonResponse).
				"sessionIdGenerator": () => crypto.randomUUID(),
				"onsessioninitialized": (id: string) => { sessions.set(id, transport); }
			});
			transport.onclose = () => { if (transport.sessionId !== undefined) { sessions.delete(transport.sessionId); } };
			await (await buildServer()).connect(transport);
		}

		if (transport === undefined) {
			response.writeHead(400, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ "jsonrpc": "2.0", "error": { "code": -32000, "message": "No valid session" }, "id": null }));

			return;
		}

		// The transport writes the response itself (JSON or an SSE stream); util/server's !headersSent
		// guard then leaves the already-sent response alone.
		await transport.handleRequest(request, response, body);
	}

	const app = createServer();

	app.post("/mcp", async (request: any, response: any) => {
		try {
			await handle(request, response, await request.json());
		} catch (error) {
			vite.ssrFixStacktrace?.(error as Error); // map the stack back to TS source for readable dev errors
			throw error;
		}
	});
	// GET = the server→client SSE stream; DELETE = explicit session teardown. Both route by session id.
	app.get("/mcp", (request: any, response: any) => handle(request, response));
	app.delete("/mcp", (request: any, response: any) => handle(request, response));

	await new Promise<void>((resolve, reject) => {
		const httpServer = app.listen(port, () => { resolve(); });

		httpServer.on("error", (err: NodeJS.ErrnoException) => {
			// Port taken → a sibling instance already serves /mcp; bridge to it.
			if (err.code === "EADDRINUSE") { process.stderr.write(`${options.name} MCP: port ${port} in use — bridging to existing\n`); resolve(); } else { reject(err); }
		});
	});

	// stdio ⇄ HTTP bridge: Claude speaks stdio; forward every JSON-RPC message to our own /mcp. The SDK
	// client transport carries the session id and opens the server→client SSE stream automatically, so
	// server-initiated requests (elicitation) flow back through here to stdout.
	const httpClient = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
	const stdio = new StdioServerTransport();

	const warn = (label: string) => (error: unknown) => process.stderr.write(`${options.name} MCP bridge (${label}): ${error instanceof Error ? error.message : String(error)}\n`);

	stdio.onmessage = (message) => { httpClient.send(message).catch(warn("stdin→http")); };
	httpClient.onmessage = (message) => { stdio.send(message).catch(warn("http→stdout")); };
	stdio.onerror = warn("stdio");
	httpClient.onerror = warn("http");
	stdio.onclose = () => { httpClient.close().catch(warn("close http")); };
	httpClient.onclose = () => { stdio.close().catch(warn("close stdio")); };

	await httpClient.start();
	await stdio.start();

	process.stderr.write(`${options.name} MCP: stdio ⇄ http://localhost:${port}/mcp bridge ready\n`);
}
