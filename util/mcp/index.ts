/**
 * Shared MCP plumbing — the reusable half of an MCP server, headed for @brianjenkins94/util/mcp.
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

import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import * as url from "node:url";
import * as fs from "@brianjenkins94/util/fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface ToolResult { "content": { "type": "text"; "text": string }[]; "isError"?: boolean }

/**
 * Passed to every tool handler as its 2nd arg. Generic MCP capabilities that aren't specific to any
 * one server — today just elicitation (asking the human mid-call). Tools that don't need it ignore it.
 */
export interface ToolContext {
	/** Aborts when the in-flight tool call is cancelled by the client. */
	"signal": AbortSignal;
	/**
	 * Ask the human for input mid-call (MCP elicitation). Returns the raw result — `action` is
	 * "accept" | "decline" | "cancel", with `content` on accept. Needs an elicitation-capable client
	 * (Claude Code is) and, under the dev bridge, the streaming transport (see bridge.ts).
	 */
	"elicit": (params: { "message": string; "requestedSchema"?: Record<string, unknown> }) => Promise<ElicitResult>;
	/**
	 * Yes/no gate (MRTR): resolves true only if this prompt was already approved, otherwise throws to
	 * surface a re-invoke-with-approval result. Approval keys on `key` (default: `message`), so a prompt
	 * whose text varies between calls — interpolated counts, timestamps, ids — MUST pass a stable `key`
	 * (a fixed string naming the action), or it never matches on re-invoke and loops.
	 */
	"confirm": (message: string, key?: string) => Promise<boolean>;
	/**
	 * Register a new tool on the LIVE server and notify the client (tools/list_changed), so it becomes
	 * usable without a restart. Throws if the name is already registered.
	 */
	"addTool": (tool: McpTool) => void;
	/**
	 * Upsert a tool on the LIVE server (tools/list_changed): if the name is already registered, replace its
	 * definition — title, description, input schema, handler — in place; otherwise add it. Use when a
	 * re-derived tool should REPLACE the running one live (e.g. it's now paginated), with no restart.
	 */
	"updateTool": (tool: McpTool) => void;
}

export interface McpTool {
	"name": string;
	"config": { "title"?: string; "description": string; "inputSchema": Record<string, unknown> };
	"handler": (args: any, context: ToolContext) => ToolResult | Promise<ToolResult>;
}

export interface ServeOptions {
	"name": string;
	"version": string;
	/** Port for the dev bridge's HTTP server. */
	"port"?: number;
	/** Defaults to ./tools next to the entry's import.meta.url. */
	"toolsDir"?: string;
	/** Force the bridge on/off. Default: on unless NODE_ENV=production. */
	"bridge"?: boolean;
}

// Only `url` — we deliberately do NOT read `import.meta.env` here: Vite's SSR module runner supports
// only the static `import.meta.env.SSR` (a compile-time replacement), so reading `.env` off a passed-in
// meta throws. The Vite-pass detection uses a module-level flag instead (see serveMcp).
export interface EntryMeta { "url": string }

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

/** Default elicitation schema — an empty accept/decline (used by `elicit` when a caller passes no schema). */
const CONFIRM_SCHEMA = { "type": "object", "properties": {}, "required": [] };

/** Thrown by `context.confirm` when the user hasn't approved a prompt yet — caught into an MRTR result below. */
class ConfirmationRequired extends Error {
	public readonly prompt: string;
	/** Stable approval token (defaults to `prompt`) — what goes into `_approved`, so a dynamic prompt can stay matchable. */
	public readonly key: string;
	public readonly approved: string[];

	public constructor(prompt: string, key: string, approved: string[]) {
		super(prompt);
		this.name = "ConfirmationRequired";
		this.prompt = prompt;
		this.key = key;
		this.approved = approved;
	}
}

/**
 * MRTR confirmation. A tool asked to confirm something it hasn't been approved for. Client elicitation
 * auto-declines under agent-driven calls, so instead of prompting we hand the AGENT a result it can act on:
 * surface the prompt to the user, then RE-INVOKE with the prompt added to `_approved`. Each distinct prompt
 * is approved individually, so one "yes" can't rubber-stamp a later, unseen action (e.g. a write gated
 * behind a Chrome-restart). Stateless: the re-invocation carries the approvals, the server holds nothing.
 */
function confirmationResult(error: ConfirmationRequired): ToolResult {
	return {
		"content": [{
			"type": "text",
			"text": `⚠️ CONFIRMATION REQUIRED — nothing was executed.\n\n${error.prompt}\n\n`
				+ "Show this to the user verbatim. If — and only if — they approve, re-invoke this tool with the "
				+ `IDENTICAL arguments plus:\n  "_approved": ${JSON.stringify([...error.approved, error.key])}\n`
				+ "If they decline, do not re-invoke."
		}]
	};
}

/**
 * The SDK tool callback both transports share. `resolve` yields the tool to run — a fixed tool for stdio,
 * a freshly hot-reloaded one for the bridge. Confirmation is MRTR (see confirmationResult): `context.confirm`
 * throws when unapproved so tool code can stay `if (!await confirm(msg)) …`, and this catches it into a
 * re-invoke-with-approval result. `_approved` (added to every tool's inputSchema) carries the grants.
 */
export function makeToolCallback(server: McpServer, name: string, resolve: () => McpTool | undefined | Promise<McpTool | undefined>) {
	return async (args: any, extra: any): Promise<ToolResult> => {
		const approved: string[] = Array.isArray(args?._approved) ? args._approved : [];
		const toolArgs = { ...(args ?? {}) };

		delete toolArgs._approved;

		const context: ToolContext = {
			"signal": extra.signal,
			// Raw elicitation — still used by tools that request structured input (e.g. admin_review_discoveries).
			// NOTE: agent-driven calls auto-decline in some clients (incl. Claude Code); prefer `confirm` (MRTR).
			"elicit": (params) => server.server.elicitInput(
				{ "message": params.message, "requestedSchema": (params.requestedSchema ?? CONFIRM_SCHEMA) as any },
				{ "relatedRequestId": extra.requestId }
			),
			// MRTR yes/no gate: true only if this prompt's key was already approved, else throw → re-invoke result.
			// key defaults to the message; a tool with a dynamic prompt passes a stable key so it stays matchable.
			"confirm": async (message, key = message) => {
				if (approved.includes(key)) {
					return true;
				}

				throw new ConfirmationRequired(message, key, approved);
			},
			"addTool": (tool: McpTool) => { registerTool(server, tool); },
			"updateTool": (tool: McpTool) => { updateTool(server, tool); }
		};

		try {
			const tool = await resolve();

			if (tool === undefined) {
				return fail(`${name} is no longer registered`);
			}

			return await tool.handler(toolArgs, context);
		} catch (error) {
			if (error instanceof ConfirmationRequired) {
				return confirmationResult(error);
			}

			return fail(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
}

/** Appended to every tool's inputSchema so a re-invocation can carry the approved confirmations (MRTR). */
const APPROVED_FIELD = z.array(z.string()).optional().describe("Internal (MRTR): confirmation prompts the user has approved; supply when re-invoking after a CONFIRMATION REQUIRED result.");

// The SDK RegisteredTool handle per name per server, kept so a tool can be UPDATED in place later (updateTool)
// rather than only added. WeakMap-keyed on the server so it's collected with it.
const registeredTools = new WeakMap<McpServer, Map<string, { "update": (updates: Record<string, unknown>) => void }>>();

function registryFor(server: McpServer): Map<string, { "update": (updates: Record<string, unknown>) => void }> {
	let registry = registeredTools.get(server);

	if (registry === undefined) {
		registry = new Map();
		registeredTools.set(server, registry);
	}

	return registry;
}

/** Register a tool whose live definition comes from `resolve` (fixed for stdio, hot-reloaded for the bridge). */
export function registerResolvingTool(server: McpServer, name: string, config: McpTool["config"], resolve: () => McpTool | undefined | Promise<McpTool | undefined>): void {
	const inputSchema = { ...(config.inputSchema ?? {}), "_approved": APPROVED_FIELD };
	const registered = server.registerTool(name, { ...config, "inputSchema": inputSchema } as any, makeToolCallback(server, name, resolve));

	registryFor(server).set(name, registered);
}

/** Register one tool on a server, wrapping its handler with error handling + the confirmation context. */
export function registerTool(server: McpServer, tool: McpTool): void {
	registerResolvingTool(server, tool.name, tool.config, () => tool);
}

/**
 * Upsert a tool on the LIVE server: if `tool.name` is already registered, UPDATE its definition in place
 * (title/description/input schema/handler) and notify the client (tools/list_changed); otherwise add it
 * fresh. Lets a re-derived tool (e.g. now paginated → a different handler + schema) replace the running one
 * with no restart. Falls back to a fresh registration if the name isn't tracked (e.g. a stale handle).
 */
export function updateTool(server: McpServer, tool: McpTool): void {
	const existing = registryFor(server).get(tool.name);

	if (existing === undefined) {
		registerTool(server, tool);

		return;
	}

	existing.update({
		"title": tool.config.title,
		"description": tool.config.description,
		"paramsSchema": { ...(tool.config.inputSchema ?? {}), "_approved": APPROVED_FIELD },
		"callback": makeToolCallback(server, tool.name, () => tool)
	});
}

/**
 * Discover tool files in a dir (RECURSIVELY, so e.g. a `dynamic/` subdir of generated tools loads the same
 * way) and load each via `load` (fs import for stdio, Vite SSR for the bridge). This runs at session start,
 * so it picks up files that exist at boot — a file ADDED at runtime is registered live via context.addTool/
 * updateTool instead, and discovered here on the next boot.
 */
export async function eachToolFile(dir: string, load: (absPath: string) => Promise<{ "default"?: McpTool | McpTool[] }>): Promise<McpTool[]> {
	const tools: McpTool[] = [];

	for (const file of (await fs.readdir(dir, { "recursive": true })).sort()) {
		if (!/\.(ts|mts|js|mjs)$/u.test(file) || file.endsWith(".d.ts")) {
			continue;
		}

		const mod = await load(path.join(dir, file));

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
	const server = new McpServer({ "name": options.name, "version": options.version });

	const tools = await eachToolFile(dir, (abs) => import(url.pathToFileURL(abs).href));

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
	const isEntry = Boolean(process.argv[1]) && meta.url === url.pathToFileURL(process.argv[1]).href;
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
		const { bootstrapOrRun } = await import("@brianjenkins94/util/vite/dev");

		if (await bootstrapOrRun(meta.url, path.dirname(url.fileURLToPath(meta.url)))) {
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
