/**
 * The streaming `/mcp` transport, plus the dev bridge that fronts it with stdio.
 *
 * `mountMcp(app, …)` mounts a session-keyed StreamableHTTP `/mcp` endpoint onto an EXISTING HTTP app
 * (Express or util/server) — no stdio, no listener of its own. It is the PRODUCTION transport half of
 * colocation: a long-running web server binds its HTTP routes AND its `defineTool`s onto one McpServer
 * (via `util/router` `bind({ http, mcp })`), then `mountMcp` exposes that server at `/mcp` on the same
 * app — HTTP routes and MCP tools in one process, no stdio to fight the web server's stdout.
 *
 * `runBridge` is the DEV consumer of `mountMcp`: it stands up its own `util/server` app, mounts `/mcp`,
 * and adds a stdio front-end so Claude (and `curl localhost:PORT/mcp`) hit the same endpoint. Its edge
 * over cache-busted re-import is breakpoints + hot-reload: tools resolve through `util/router/core`'s
 * Vite SSR resolver (stable module identity + source maps), so editor breakpoints in tools/*.ts bind
 * and tool-body edits take effect per invocation.
 *
 * Quine: tsx runs server.ts → serveMcp → bootstrapOrRun (util/vite/dev) creates Vite and re-enters
 * server.ts through SSR → serveMcp (second pass) → runBridge actually boots. The two passes are told
 * apart by a module-level flag in bootstrapOrRun, NOT import.meta.env.SSR.
 */

import type { EntryMeta, ServeOptions } from "./index";
import * as path from "node:path";
import * as url from "node:url";
import { createServer } from "@brianjenkins94/util/server";
import { discover, getViteDevServer, resolveExport } from "@brianjenkins94/util/router/core";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { silenceStdout } from "./index.js";
import { isMcpTool, registerResolvingTool } from "./tool.js";

export interface MountOptions {
	/**
	 * Build the McpServer for a new session. Called once per initialize (the SDK binds one server per
	 * transport), so a fresh server is connected to each session's transport — which is also what makes
	 * the dev bridge's hot-reload work (each session gets the current tools). A production colocation
	 * server that doesn't hot-reload can rebuild-and-`bind` here, or close over a prebuilt server and
	 * re-register its tools onto a fresh instance.
	 */
	"buildServer": () => McpServer | Promise<McpServer>;
	/** Dev-only: map an error's stack back to TS source (Vite `ssrFixStacktrace`). Omitted in production. */
	"fixStack"?: (error: Error) => void;
}

/**
 * Mount POST/GET/DELETE `/mcp` (a persistent, session-keyed StreamableHTTP transport) onto `app`. The
 * caller owns the app and its `listen` — this only wires the routes and the per-session transport map.
 * Streaming (SSE) is the transport default so a tool call's response stream can carry a server→client
 * elicitation request back to the client (do NOT set enableJsonResponse).
 */
export function mountMcp(app: any, options: MountOptions): void {
	// One StreamableHTTP transport per MCP session. A stdio front-end (runBridge) drives one session; a
	// browser client or a second bridging front-end initializes its own.
	const sessions = new Map<string, StreamableHTTPServerTransport>();

	async function handle(request: any, response: any, body?: unknown): Promise<void> {
		const sessionId = request.headers["mcp-session-id"] as string | undefined;
		let transport = sessionId !== undefined ? sessions.get(sessionId) : undefined;

		if (transport === undefined && body !== undefined && isInitializeRequest(body)) {
			transport = new StreamableHTTPServerTransport({
				"sessionIdGenerator": () => crypto.randomUUID(),
				"onsessioninitialized": (id: string) => { sessions.set(id, transport); }
			});
			transport.onclose = () => { if (transport.sessionId !== undefined) { sessions.delete(transport.sessionId); } };
			await (await options.buildServer()).connect(transport);
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

	app.post("/mcp", async (request: any, response: any) => {
		try {
			await handle(request, response, await request.json());
		} catch (error) {
			options.fixStack?.(error as Error); // map the stack back to TS source for readable dev errors
			throw error;
		}
	});
	// GET = the server→client SSE stream; DELETE = explicit session teardown. Both route by session id.
	app.get("/mcp", (request: any, response: any) => handle(request, response));
	app.delete("/mcp", (request: any, response: any) => handle(request, response));
}

/** Second pass (Vite SSR): boot `/mcp` (via mountMcp) + the stdio bridge. */
export async function runBridge(meta: EntryMeta, options: ServeOptions): Promise<void> {
	silenceStdout();

	const root = path.dirname(url.fileURLToPath(meta.url));
	const vite = await getViteDevServer(root);
	const toolsDir = options.toolsDir ?? path.join(root, "tools");
	const port = options.port ?? 3000;

	// Reload every tool module fresh through the shared Vite SSR resolver: `resolveExport` returns the new
	// code after an edit (the core watcher invalidates it) and the cached module otherwise. Registration
	// reads each tool's name/config now; each INVOCATION re-resolves the handler, so tool-body edits run
	// live even though the session is persistent. Adding/removing a tool file, or changing its schema,
	// needs a restart. A fresh server is built per session (the SDK binds one server per transport).
	const buildServer = async (): Promise<McpServer> => {
		const server = new McpServer({ "name": options.name, "version": options.version });

		for (const filePath of await discover(toolsDir)) {
			const tool = await resolveExport(root, filePath, "default");

			if (!isMcpTool(tool)) {
				continue;
			}

			registerResolvingTool(server, tool.name, tool.config, () => resolveExport(root, filePath, "default"));
		}

		return server;
	};

	const app = createServer();

	mountMcp(app, { "buildServer": buildServer, "fixStack": (error) => vite.ssrFixStacktrace?.(error) });

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
