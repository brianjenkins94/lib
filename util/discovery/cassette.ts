import type { Observation } from "./accumulate.js";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import { log } from "@brianjenkins94/util/logger";

/**
 * A record/replay "cassette": captured request/response {@link Observation}s (as `playwright/capture`
 * emits and `discovery/accumulate` consumes), keyed one-per-endpoint by `method + pathPattern`, that a
 * mock backend replays. The generic machinery — merge/dedup/size-cap/sort/write on the record side and
 * the lookup on the replay side — lives here; a consumer supplies the file path and an optional `scrub`
 * hook for its own secret-redaction policy (e.g. via `@brianjenkins94/util/redact`).
 */
export type Cassette = Observation[];

export interface MergeOptions {
	/** Skip a recording whose `responseBody` JSON exceeds this many bytes (the consumer falls back to an
	 *  authored fixture for those). Omit for no cap. */
	"maxBytes"?: number;
	/** Transform applied to the merged cassette just before writing — e.g. redact secrets. */
	"scrub"?: (cassette: Cassette) => Cassette;
}

/** Read a cassette file, or `undefined` if it doesn't exist yet (an invalid/unreadable one still throws). */
async function readCassette(file: string): Promise<Cassette | undefined> {
	try {
		return JSON.parse(await fs.readFile(file)) as Cassette;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") { return undefined; }

		throw error;
	}
}

/**
 * Merge freshly-captured observations into the committed cassette at `file`: one entry per
 * `method + pathPattern`, SUCCESSFUL responses only (status < 400), size-capped, sorted for a stable
 * diff, and scrubbed. Creates the file's directory if needed. Returns the number added/updated.
 */
export async function mergeCassette(file: string, observations: Observation[], options: MergeOptions = {}): Promise<number> {
	const byKey = new Map<string, Observation>();

	for (const observation of await readCassette(file) ?? []) {
		byKey.set(observation.method + " " + observation.pathPattern, observation);
	}

	let added = 0;

	for (const observation of observations) {
		// Never bake a failed call into a replay — a recording is only worth keeping if it succeeded.
		if (observation.status >= 400) { continue; }

		if (options.maxBytes !== undefined && JSON.stringify(observation.responseBody).length > options.maxBytes) {
			log.info("cassette: skipping oversized recording (using authored fallback)", {
				"method": observation.method,
				"pathPattern": observation.pathPattern,
				"kb": Math.round(JSON.stringify(observation.responseBody).length / 1024),
				"capKb": options.maxBytes / 1024
			});

			continue;
		}

		byKey.set(observation.method + " " + observation.pathPattern, observation);
		added += 1;
	}

	let merged: Cassette = [...byKey.values()].sort((a, b) => (a.method + a.pathPattern).localeCompare(b.method + b.pathPattern));

	if (options.scrub !== undefined) { merged = options.scrub(merged); }

	await fs.mkdir(path.dirname(file), { "recursive": true });
	await fs.writeFile(file, JSON.stringify(merged, undefined, "\t") + "\n");

	return added;
}

/** Re-scrub a committed cassette in place (e.g. after tightening the redaction rules). No-op if absent. */
export async function scrubCassetteFile(file: string, scrub: (cassette: Cassette) => Cassette): Promise<void> {
	const cassette = await readCassette(file);

	if (cassette === undefined) { return; }

	return fs.writeFile(file, JSON.stringify(scrub(cassette), undefined, "\t") + "\n");
}

/** The replay side: the recorded `responseBody` for the first entry matching `method` + a path-pattern
 *  matcher (a route family regex), or `undefined` if none was captured. */
export function recordedResponse(cassette: Cassette, method: string, matcher: RegExp): unknown {
	return cassette.find((observation) => observation.method === method && matcher.test(observation.pathPattern))?.responseBody;
}
