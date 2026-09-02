/**
 * silo — the local TRUST state (Node): the run ledger, the registry, and the confidence ratchet. Extracted
 * from the `silo` prototype's `commands/runner.ts` (its bundling / boxing / CLI stay behind — this is just the
 * persistence + scoring core).
 *
 * Where `./audit`'s baseline + review are the COMMITTED contract, this is the LOCAL, per-clone trust that
 * accrues over time (gitignored — see `ensureSiloDir`):
 *   • `runs.jsonl`     — one RunRec per execution (the ledger).
 *   • `registry.json`  — per-unit approved scopes + the caps/imports seen when they were approved.
 *   • `confidence(…)`  — churn-decayed Wilson lower bound: trust RISES with clean runs, DECAYS on edit.
 */

import * as fs from "@brianjenkins94/util/fs";

import { type SiloPaths, ensureSiloDir } from "./paths.js";

/** One recorded execution. `mode` weights the run (a real "apply" run counts more than a dry-run); `sha` ties
 *  it to the exact code, so a later edit decays the run's weight. `exit` 0 = clean. */
export interface RunRec { "script": string; "ts": string; "sha": string; "exit": number; "mode": string }

/** Read the whole run ledger (JSONL). */
export function loadLedger(paths: SiloPaths): RunRec[] {
	return fs.existsSync(paths.ledger) ? fs.readFileSync(paths.ledger).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/** Append one run to the ledger (creating `.silo/` if needed). */
export async function recordRun(paths: SiloPaths, rec: RunRec): Promise<void> {
	await ensureSiloDir(paths);
	await fs.appendFile(paths.ledger, JSON.stringify(rec) + "\n");
}

export interface Confidence { "band": "unproven" | "provisional" | "trusted"; "score": number; "n": number }

/**
 * Churn-decayed Wilson lower bound over one script's runs — trust that RISES with clean runs and DECAYS when
 * the code changes. A real ("apply") run weighs 1.0, a dry-run 0.25; a run recorded against a now-stale sha
 * decays to 0.4 of its weight. `band`: unproven (<0.2) → provisional (<0.6) → trusted. `n` = raw run count.
 */
export function confidence(paths: SiloPaths, script: string, currentSha: string): Confidence {
	const runs = loadLedger(paths).filter((r) => r.script === script);
	let n = 0;
	let s = 0;

	for (const r of runs) {
		const w = (r.mode === "apply" ? 1 : 0.25) * (r.sha === currentSha ? 1 : 0.4);

		n += w;
		if (r.exit === 0) { s += w; }
	}

	if (n === 0) { return { "band": "unproven", "score": 0, "n": 0 }; }

	const p = s / n;
	const z = 1.96;
	const lb = (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);

	return { "band": lb < 0.2 ? "unproven" : lb < 0.6 ? "provisional" : "trusted", "score": Math.round(lb * 100), "n": runs.length };
}

/** A registry entry — the last-approved capability picture for a unit: its content `sha`, the `imports` and
 *  `staticCaps` seen then, and the scopes explicitly `approved`. Lets a gate prompt only on what's NEW. */
export interface RegistryEntry { "sha": string; "imports": string[]; "staticCaps": string[]; "approved": string[] }
export type Registry = Record<string, RegistryEntry>;

export function loadRegistry(paths: SiloPaths): Registry {
	return fs.existsSync(paths.registry) ? JSON.parse(fs.readFileSync(paths.registry)) : {};
}

export async function saveRegistry(paths: SiloPaths, registry: Registry): Promise<void> {
	await ensureSiloDir(paths);
	fs.writeFileSync(paths.registry, JSON.stringify(registry, null, 2) + "\n");
}

/** Sync variant — for the sync fs gate, which can't await. Assumes `.silo/` exists (it does once a baseline /
 *  ledger has been written); throws if not, which the caller swallows (the grant just isn't persisted). */
export function saveRegistrySync(paths: SiloPaths, registry: Registry): void {
	fs.writeFileSync(paths.registry, JSON.stringify(registry, null, 2) + "\n");
}
