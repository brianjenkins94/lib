/**
 * The MCP tool MODEL — the one definition of what a tool is and how it registers onto an McpServer,
 * shared by every construction path: `serveMcp`/`runStdio` (dedicated stdio), `runBridge`/`mountMcp`
 * (the streaming `/mcp` transport), and `util/router`'s colocation binder. So a tool authored once
 * (`export default defineTool(...)`) registers identically — same `ToolContext`, same MRTR confirmation
 * — whether it's served from a dedicated MCP server or colocated beside HTTP routes.
 *
 * This leaf depends only on the MCP SDK + zod (no router, no transports), so `util/router` can lazy-import
 * it and stay SDK-free for HTTP-only consumers, and `util/mcp` can build on it without a cycle.
 */

import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as path from "node:path";
// The broker scope leaf (zero-dep ALS) — the Vite plugin's rewritten node:fs/child_process shim reads the same
// store to gate fs/exec, and the fetch wrap reads it for net; the gate logic (closures) is built below.
import { type BrokerScope, brokerStore } from "./broker";
import { sinks } from "@brianjenkins94/util/logger";
// The run ledger + registry (util/silo) — oxc-free (util/fs only), so recording/gating never pulls the kernels.
import { type SiloPaths, siloPaths } from "@brianjenkins94/util/silo/paths";
import { type Confidence, confidence, loadRegistry, recordRun, saveRegistrySync } from "@brianjenkins94/util/silo/runs";
// The broker's shared decision core (BERNARD redline + JUDICIAL) — reused for runtime net + fs gating.
import { judicial, redline } from "@brianjenkins94/util/silo/enforce/decide.mjs";

export interface ToolResult { "content": { "type": "text"; "text": string }[]; "isError"?: boolean }

// Ambient tool context: makeToolCallback runs each handler inside this store, so ANY code the handler calls
// (an app's request client, etc.) can read the live ToolContext — signal/progress/confirm — WITHOUT threading
// it through every function. Makes cancellation/progress/the confirm-gate de-facto for a server, not opt-in.
const toolContextStore = new AsyncLocalStorage<ToolContext>();

/** The ToolContext of the currently-executing tool handler (undefined outside one). */
export function currentToolContext(): ToolContext | undefined {
	return toolContextStore.getStore();
}

// LogRecord level → MCP logging level; anything below `info` stays local-only (still hits the default sinks).
const TO_MCP_LEVEL: Record<string, string> = { "trace": "debug", "debug": "debug", "info": "info", "warn": "warning", "error": "error", "fatal": "critical" };
const CLIENT_LEVELS = new Set(["info", "warn", "error", "fatal"]);

/**
 * Forward this server's logger records to the MCP client as `notifications/message` (needs the `logging`
 * capability). info+ only, so the client isn't drowned in debug/trace. Self-detaches on server close, so a
 * per-session bridge server neither leaks a sink nor logs to a dead session. Returns a manual detach too.
 */
export function attachLogging(server: McpServer): () => void {
	let sending = false;

	const sink = (record: { "level": string; "span"?: string }): void => {
		if (sending || !CLIENT_LEVELS.has(record.level)) { return; }

		sending = true; // guard: sendLoggingMessage must never re-enter dispatch and loop

		try {
			void Promise.resolve(server.server.sendLoggingMessage({ "level": TO_MCP_LEVEL[record.level] ?? "info", "logger": record.span, "data": record })).catch(() => {});
		} catch {}

		sending = false;
	};

	sinks.push(sink);

	const detach = (): void => {
		const index = sinks.indexOf(sink);

		if (index !== -1) { sinks.splice(index, 1); }
	};

	const previous = server.server.onclose;

	server.server.onclose = (): void => { detach(); previous?.(); };

	return detach;
}

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
	/**
	 * Report progress for a long-running op. Only reaches the client if it opted in by sending a
	 * progressToken with the call (else a no-op); `total` is optional (indeterminate progress).
	 */
	"progress": (progress: number, total?: number) => void;
	/**
	 * This tool's trust confidence from the server's run ledger (`.silo/runs.jsonl`) — a churn-decayed score
	 * that rises with clean runs and decays when the tool changes. `undefined` if the server keeps no ledger
	 * (a colocated bind() that never went through serveMcp/runBridge).
	 */
	"confidence": () => Confidence | undefined;
}

export interface McpTool {
	"name": string;
	"config": { "title"?: string; "description": string; "inputSchema": Record<string, unknown> };
	"handler": (args: any, context: ToolContext) => ToolResult | Promise<ToolResult>;
}

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

/** True if a value looks like an McpTool (a callable handler + a config) — used to tell a tool's default
 *  export from an HTTP-only file's default when the router dispatches colocated files by shape. */
export function isMcpTool(value: unknown): value is McpTool {
	return typeof value === "object" && value !== null && typeof (value as McpTool).handler === "function" && typeof (value as McpTool).config === "object";
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

// ── Run ledger: every tool invocation is appended to the server's `.silo/runs.jsonl` (via util/silo/runs), so
//    a server accrues a churn-decayed trust score per tool with no per-tool wiring. The server's `.silo/` root
//    is set by serveMcp/runStdio and runBridge (configureServerRuns); without it, recording is a silent no-op
//    (e.g. a colocated bind() that never went through serveMcp). The consumer owns `.silo/`'s gitignore. ──
const serverPaths = new WeakMap<McpServer, SiloPaths>();

/** Point a server's run ledger at `root`'s `.silo/`. Called by the serve paths; a consumer decides whether to
 *  commit or gitignore `.silo/runs.jsonl` — the framework just maintains it. */
export function configureServerRuns(server: McpServer, root: string): void {
	serverPaths.set(server, siloPaths(root));
}

/** A tool's content hash — config + handler source — so its confidence decays when the tool definition changes. */
function shaOfTool(tool: McpTool): string {
	return createHash("sha256").update(JSON.stringify(tool.config ?? {}) + String(tool.handler)).digest("hex").slice(0, 12);
}

/** Confidence for a tool from the server's ledger (undefined when the server keeps no `.silo/`). */
function confidenceForTool(server: McpServer, name: string, tool: McpTool): Confidence | undefined {
	const paths = serverPaths.get(server);

	return paths === undefined ? undefined : confidence(paths, name, shaOfTool(tool));
}

/** Append a run to the ledger — best-effort, so a ledger write never affects the tool's result. */
function recordToolRun(server: McpServer, name: string, tool: McpTool, exit: number): void {
	const paths = serverPaths.get(server);

	if (paths === undefined) { return; }

	void recordRun(paths, { "script": name, "ts": new Date().toISOString(), "sha": shaOfTool(tool), "exit": exit, "mode": "apply" }).catch(() => {});
}

// ── Runtime capability broker. During a brokered tool handler, node-side `fetch` (net) and every `util/fs`
//    read/write (fs) are gated with the FINE scope (`net:<host>`, `fs:read:/path`) via the broker's decision
//    core (BERNARD redline + JUDICIAL), the MRTR confirm, and per-tool grants persisted to the registry (TOFU).
//    Enforcement is ALS-scoped (util/mcp/broker): a call made OUTSIDE a brokered handler — or by the server's own
//    infrastructure under its tree — passes straight through. fs is intercepted at the util/fs chokepoint (the
//    lint rule forbids direct node:fs), so no boxed `--import` launch is needed.
const brokeredServers = new WeakSet<McpServer>();
let brokerInstalled = false;

/** Turn on runtime capability gating for a server's tools (called by the serve paths unless disabled). */
export function configureServerBroker(server: McpServer): void {
	brokeredServers.add(server);

	if (!brokerInstalled) {
		installBroker();
		brokerInstalled = true;
	}
}

/**
 * Build the net + fs gate closures for ONE invocation of a tool — captures that invocation's `_approved` set,
 * so an MRTR re-invocation carries the grant. Both gates share one decision path: an in-tree fs path passes; a
 * registry grant passes; a BERNARD redline scope needs an explicit break-glass approval (never persisted);
 * JUDICIAL denies (throw) or allows; otherwise the human MRTR-confirms. A granted scope is persisted (TOFU).
 * `requireApproval` throws ConfirmationRequired synchronously, so it works for the sync fs gate too.
 */
function makeGates(name: string, paths: SiloPaths | undefined, approved: string[]): Pick<BrokerScope, "gateFs" | "gateNet"> {
	const requireApproval = (message: string, key: string): void => {
		if (!approved.includes(key)) { throw new ConfirmationRequired(message, key, approved); }
	};
	const granted = (capScope: string): boolean => {
		if (paths === undefined) { return false; }

		try { return (loadRegistry(paths)[name]?.approved ?? []).includes(capScope); } catch { return false; }
	};
	const persist = (capScope: string): void => {
		if (paths === undefined) { return; }

		try {
			const registry = loadRegistry(paths);
			const entry = registry[name] ?? { "sha": "", "imports": [], "staticCaps": [], "approved": [] };

			if (!entry.approved.includes(capScope)) { entry.approved.push(capScope); registry[name] = entry; saveRegistrySync(paths, registry); }
		} catch {}
	};
	const decide = (capScope: string, message: string, request: object): void => {
		if (granted(capScope)) { return; }

		if (redline(capScope)) {
			requireApproval(`⛔ BERNARD REDLINE — ${capScope}\n\nTool "${name}" is reaching a capability on the catastrophic list, which is never a routine grant. Approve ONLY as a deliberate, one-time break-glass.`, `bernard:${name}:${capScope}`);

			return;   // break-glass approved for THIS invocation; deliberately NOT persisted
		}

		const verdict = judicial(request);

		if (verdict?.behavior === "deny") { throw new Error(`[broker] DENIED ${capScope} — JUDICIAL: ${verdict.message ?? "deny"}`); }
		if (verdict?.behavior !== "allow") { requireApproval(message, `${name}:${capScope}`); }

		persist(capScope);
	};

	return {
		"gateNet": async (host: string): Promise<void> => { decide(`net:${host}`, `Allow tool "${name}" to make a network request to net:${host}?`, { "kind": "net", "scope": `net:${host}`, "host": host, "tool": name }); },
		"gateFs": (op: "read" | "write", target: string): void => {
			const abs = path.resolve(target);

			// In-tree: a path under the server's own root (its `.silo/`, logs, tools) is routine — the server's
			// own infrastructure runs inside the handler's ALS scope too, and must not be gated.
			if (paths !== undefined && (abs === paths.root || abs.startsWith(paths.root + path.sep))) { return; }

			decide(`fs:${op}:${abs}`, `Allow tool "${name}" to ${op} ${abs}?`, { "kind": "fs", "op": op, "scope": `fs:${op}:${abs}`, "path": abs, "tool": name });
		},
		"gateExec": (command: string): void => { decide(`exec:${command}`, `Allow tool "${name}" to run \`${command}\`?`, { "kind": "exec", "scope": `exec:${command}`, "command": command, "tool": name }); }
	};
}

/** Install the process-wide `fetch` wrapper once. Enforces only when a brokered handler is on the stack (broker
 *  scope set with a gateNet); every other fetch — server infrastructure — is untouched. fs is gated in util/fs. */
function installBroker(): void {
	const realFetch = globalThis.fetch;

	if (typeof realFetch !== "function") { return; }

	globalThis.fetch = async function(this: unknown, input: any, init?: any) {
		const gateNet = brokerStore.getStore()?.gateNet;

		if (gateNet === undefined) { return realFetch.call(this, input, init); }

		let host = "*";

		try { host = new URL(typeof input === "string" ? input : (input?.url ?? String(input))).host || "*"; } catch {}

		await gateNet(host);

		return realFetch.call(this, input, init);
	};
}

/**
 * The SDK tool callback both transports share. `resolve` yields the tool to run — a fixed tool for stdio,
 * a freshly hot-reloaded one for the bridge. Confirmation is MRTR (see confirmationResult): `context.confirm`
 * throws when unapproved so tool code can stay `if (!await confirm(msg)) …`, and this catches it into a
 * re-invoke-with-approval result. `_approved` (added to every tool's inputSchema) carries the grants. Each
 * real invocation (success or failure — NOT an MRTR confirmation gate) is appended to the run ledger.
 */
export function makeToolCallback(server: McpServer, name: string, resolve: () => McpTool | undefined | Promise<McpTool | undefined>) {
	return async (args: any, extra: any): Promise<ToolResult> => {
		const approved: string[] = Array.isArray(args?._approved) ? args._approved : [];
		const toolArgs = { ...(args ?? {}) };

		delete toolArgs._approved;

		let candidate: McpTool | undefined;

		try {
			candidate = await resolve();
		} catch (error) {
			return fail(`${name} failed to load: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (candidate === undefined) {
			return fail(`${name} is no longer registered`);
		}

		const resolved = candidate;   // narrowed — used by the context confidence closure and the run ledger

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
			"updateTool": (tool: McpTool) => { updateTool(server, tool); },
			"progress": (progress, total) => {
				const token = (extra as any)._meta?.progressToken;

				if (token === undefined) { return; }

				void (extra as any).sendNotification?.({ "method": "notifications/progress", "params": { "progressToken": token, "progress": progress, ...(total !== undefined ? { "total": total } : {}) } });
			},
			// This tool's trust confidence from the server's run ledger (churn-decayed; undefined if none kept).
			"confidence": () => confidenceForTool(server, name, resolved)
		};

		try {
			const runHandler = () => toolContextStore.run(context, () => resolved.handler(toolArgs, context));
			// A brokered server gates the handler's node-side net + fs calls inside a broker scope; others run bare.
			const result = brokeredServers.has(server)
				? await brokerStore.run({ "name": name, ...makeGates(name, serverPaths.get(server), approved) }, runHandler)
				: await runHandler();

			recordToolRun(server, name, resolved, result.isError ? 1 : 0);

			return result;
		} catch (error) {
			if (error instanceof ConfirmationRequired) {
				return confirmationResult(error);   // an MRTR gate — nothing executed, not a run
			}

			recordToolRun(server, name, resolved, 1);

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
