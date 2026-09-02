/**
 * A Vite plugin that redirects a TOOL module's `node:fs` / `node:child_process` imports to a generated GATED
 * SHIM — the in-process, HMR-preserving version of silo's `enforce/bundle.ts` import-rewrite. Instead of
 * bundling a script + spawning a boxed subprocess (which severs an in-process server's live context, e.g. a
 * CDP page), this transforms the module Vite is already loading for hot-reload, so the tool runs in-process
 * with the same broker capability gate a cooperative `util/fs` call would hit.
 *
 * The shim re-exports node's real API and wraps only the capability-bearing functions (fs read/write, exec)
 * with `util/mcp/broker`'s ambient gate — a no-op unless a brokered tool handler is on the stack, so it is inert
 * for every non-MCP Vite consumer. This is a cooperative TOFU shim, NOT an adversarial sandbox: it makes a
 * tool authored with plain `node:fs` gate transparently, with no lint rule to satisfy.
 *
 * Scoped by `shouldGate(importer)` (default: any first-party module — not node_modules, not a virtual id), so
 * placing it on a shared dev server only rewrites app/tool code, never a dependency's internals (which would
 * be circular — util/fs itself imports node:fs).
 */

import type { Plugin } from "vite";

// A `transform` rewrites the SPECIFIER STRING in a tool's source (`"node:fs"` → `"virtual:gated-builtin-fs"`)
// BEFORE Vite resolves it — necessary because Vite short-circuits `node:` builtins for SSR ahead of any
// `resolveId`, so intercepting the bare `node:fs` id doesn't work. The virtual id then resolves to the shim.
const VIRTUAL = "virtual:gated-builtin-";
const RESOLVED = "\0" + VIRTUAL;
const SPECIFIER = /(["'])node:(fs|child_process)\1/gu;

/** The gated re-export of a builtin: node's whole API via `export *`, with the capability-bearing functions
 *  overridden to call the ambient broker gate first (an explicit named export shadows the `export *` one). */
function shim(builtin: "fs" | "child_process"): string {
	const head = `export * from "node:${builtin}";\n`
		+ `import * as __real from "node:${builtin}";\n`
		+ `import { brokerStore } from "@brianjenkins94/util/mcp/broker";\n`;

	if (builtin === "fs") {
		const g = `const __g = (op, p) => { if (typeof p === "string") { brokerStore.getStore()?.gateFs?.(op, p); } };\n`;
		const w = (name: string, op: "read" | "write") => `export const ${name} = (p, ...a) => { __g("${op}", p); return __real.${name}(p, ...a); };\n`;

		return head + g
			+ w("readFile", "read") + w("readFileSync", "read") + w("createReadStream", "read")
			+ w("writeFile", "write") + w("writeFileSync", "write") + w("appendFile", "write") + w("createWriteStream", "write");
	}

	const g = `const __g = (cmd) => { if (typeof cmd === "string") { brokerStore.getStore()?.gateExec?.(cmd); } };\n`;
	const w = (name: string) => `export const ${name} = (cmd, ...a) => { __g(cmd); return __real.${name}(cmd, ...a); };\n`;

	return head + g + w("spawn") + w("spawnSync") + w("exec") + w("execSync") + w("execFile") + w("execFileSync") + w("fork");
}

export interface GateBuiltinsOptions {
	/** Which importers get their builtin imports rewritten. Default: any first-party module. */
	"shouldGate"?: (importer: string) => boolean;
}

export function gateBuiltins(options: GateBuiltinsOptions = {}): Plugin {
	const shouldGate = options.shouldGate ?? ((importer: string) => !importer.includes("node_modules") && !importer.startsWith("\0"));

	return {
		"name": "gate-builtins",
		"enforce": "pre",
		transform(code: string, id: string) {
			if (!shouldGate(id) || !(code.includes("node:fs") || code.includes("node:child_process"))) { return null; }

			return { "code": code.replace(SPECIFIER, (_m, quote, builtin) => `${quote}${VIRTUAL}${builtin}${quote}`), "map": null };
		},
		resolveId(source: string) {
			return source.startsWith(VIRTUAL) ? RESOLVED + source.slice(VIRTUAL.length) : null;
		},
		load(id: string) {
			return id.startsWith(RESOLVED) ? shim(id.slice(RESOLVED.length) as "fs" | "child_process") : null;
		}
	};
}
