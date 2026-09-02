/**
 * Release-age cooldown installer — a `preinstall` hook / standalone installer. Extracted and generalized
 * from the `silo` prototype's `install/cooldown.mjs` (its silo-specific `.silo/pending-review` breadcrumb
 * was dropped per its own note "lift this block out if cooldown is ever extracted to a generic installer").
 *
 * Policy: float to the newest release, but never one published within the last N days (default 7), so a
 * freshly-compromised version can't land during its highest-risk window. With deps at "latest" and no
 * committed lockfile, install then always resolves to newest-that's-≥N-days-old.
 *
 * pnpm has this natively (`minimumReleaseAge`, in minutes) — tried first. npm only has `--before=<date>`, and
 * npm fixes versions at *resolution* time from startup config, so a lifecycle script can't alter the parent's
 * resolution: the npm fallback RE-RUNS the install itself with `--before=<now − N days>`, guarded against
 * recursion. The parent install then honors the cooled lockfile this wrote and exits 0 — no wrapper, no abort.
 *
 * Pure Node, zero deps on purpose: `preinstall` runs BEFORE node_modules exists, so tsx / any package isn't
 * available yet — which is why this is `.mjs` and invoked with `node`, not a tsx-run `.ts`.
 *
 * Wire it as a repo's preinstall:
 *   "preinstall": "node node_modules/@brianjenkins94/util/scripts/preinstall.mjs"
 * Or run directly:  node preinstall.mjs [--cooldown <days>] [install-args…]
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

// When we spawn pnpm/npm install below, it re-fires this same hook — the guard makes the inner run a no-op so
// the parent proceeds with our cooled resolution instead of recursing forever.
if (process.env.COOLDOWN_GUARD) { process.exit(0); }

let days = Number(process.env.COOLDOWN_DAYS) || 7;
const pass = [];
const argv = process.argv.slice(2);

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--cooldown") { i += 1; days = Number(argv[i]); } else if (argv[i].startsWith("--cooldown=")) { days = Number(argv[i].slice("--cooldown=".length)); } else { pass.push(argv[i]); }
}

if (!Number.isFinite(days) || days < 0) { days = 7; }

const minutes = String(days * 24 * 60);
const before = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
const guardEnv = { ...process.env, "COOLDOWN_GUARD": "1" };

process.stderr.write(`[cooldown] pnpm install --config.minimumReleaseAge=${minutes}  (newest release ≥${days}d old)\n`);
// shell: true — pnpm/npm are .cmd shims on Windows, and since CVE-2024-27980 spawn requires a shell to run
// a .cmd (this file can't use util/exec — it runs before node_modules exists — so the fix is inline).
const pnpm = spawnSync("pnpm", ["install", `--config.minimumReleaseAge=${minutes}`, ...pass], { "stdio": "inherit", "env": guardEnv, "shell": true });

if (!pnpm.error && pnpm.status === 0) { process.exit(0); }

// No pnpm on PATH, or the pnpm install itself failed — fall back to npm. Force a fresh cooled resolution:
// npm writes a hidden node_modules/.package-lock.json pinning the NEWEST versions *before* this hook runs,
// and it would otherwise override --before. Clearing both the hidden lock (via node_modules) and any stale
// top-level lock makes --before authoritative. pnpm needs none of this.
rmSync("node_modules", { "recursive": true, "force": true });
rmSync("package-lock.json", { "force": true });

process.stderr.write(`[cooldown] npm install --before=${before}  (newest release ≥${days}d old)\n`);
const npm = spawnSync("npm", ["install", `--before=${before}`, ...pass], { "stdio": "inherit", "env": guardEnv, "shell": true });

if ((npm.status ?? 1) !== 0) {
	process.stderr.write(`\n[cooldown] npm install failed (exit ${npm.status}). If "notarget"/"ENOVERSIONS", a (sub)dependency has no release older than your ${days}-day cooldown — too fresh to trust yet. Wait it out, or run with --cooldown <days>.\n`);
}

process.exit(npm.status ?? 0);
