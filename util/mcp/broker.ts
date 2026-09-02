/**
 * The active tool's runtime BROKER SCOPE — the AsyncLocalStorage that carries the capability-gate closures for
 * the duration of a brokered tool handler. `util/mcp`'s tool callback sets it (populating the gates with its
 * decision core + registry); the `fetch` wrap reads `gateNet`, and the Vite plugin's rewritten `node:fs` /
 * `node:child_process` shim reads `gateFs` / `gateExec` — so a capability is gated at the moment it's used.
 *
 * Kept as its own tiny module (just the store + scope shape) so the plugin's generated shim can import it by a
 * stable specifier without pulling the rest of `util/mcp`. A gate throws to BLOCK: `ConfirmationRequired` (→ an
 * MRTR re-invoke-with-approval result) for something the human may approve, or a plain `Error` for a hard
 * JUDICIAL deny. Returning normally = allow.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface BrokerScope {
	/** The tool whose handler is executing (the registry key + the name shown in a prompt). */
	"name": string;
	/** Gate a filesystem op. SYNC so it works for `readFileSync`/`writeFileSync` too — throws to block. */
	"gateFs"?: (op: "read" | "write", path: string) => void;
	/** Gate a subprocess launch (from the Vite builtin-rewrite shim). SYNC (spawnSync/execSync can't await). */
	"gateExec"?: (command: string) => void;
	/** Gate a network host (from the `fetch` wrap). */
	"gateNet"?: (host: string) => Promise<void>;
}

/** Set by the tool callback for the duration of a brokered handler; `undefined` everywhere else (so server
 *  infrastructure and unbrokered servers are never gated). */
export const brokerStore = new AsyncLocalStorage<BrokerScope>();
