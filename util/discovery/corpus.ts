/**
 * Persistent, bounded corpus of observed API traffic — the durable backing store behind stage 2
 * (accumulate). Source-agnostic: feed it Observations from any adapter (CDP capture, replay, …). It keeps
 * the most recent `maxPerEndpoint` samples per method+pathPattern — so accumulate() finally sees a real
 * multi-sample set instead of one — and survives restarts so schema accumulation improves ACROSS sessions
 * rather than re-observing from scratch.
 *
 * Persistence is delegated to [[../store]] (PersistentStore): load-at-construction + coalesced debounced
 * writes come for free; this class owns only the two things that are its own — the per-endpoint ring cap
 * and an optional `redact` transform (applied before anything is retained or persisted, so no unredacted
 * body reaches disk or `all()`). The corpus is a cache, re-derivable from live traffic, so a lost write
 * just means the newest samples are re-observed later.
 *
 * lib-clean: the file path and the `redact` transform are INJECTED — the store knows nothing about any
 * particular API or its secrets.
 */
import type { Observation } from "./accumulate.js";
import { PersistentStore } from "@brianjenkins94/util/store";

export interface ObservationStoreOptions {
	/** File the capped corpus is persisted to (created on first write; missing = start empty). */
	"path": string;
	/** Applied to every observation before it is retained or persisted (e.g. strip secrets). Identity if omitted. */
	"redact"?: (observation: Observation) => Observation;
	/** Samples kept per method+pathPattern (a ring — oldest dropped past the cap). */
	"maxPerEndpoint"?: number;
}

const DEFAULT_MAX_PER_ENDPOINT = 25;

/** Dedupe key — method + normalized path (mirrors accumulate's endpointKey). */
function keyOf(observation: Observation): string {
	return `${observation.method.toUpperCase()} ${observation.pathPattern}`;
}

export class ObservationStore {
	private readonly store: PersistentStore;
	private readonly redact: (observation: Observation) => Observation;
	private readonly maxPerEndpoint: number;

	public constructor(options: ObservationStoreOptions) {
		this.store = new PersistentStore({ "filename": options.path });
		this.redact = options.redact ?? ((observation) => observation);
		this.maxPerEndpoint = options.maxPerEndpoint ?? DEFAULT_MAX_PER_ENDPOINT;
	}

	/** Record one observation: redact, push onto its endpoint's capped ring, and persist (debounced). */
	public append(observation: Observation): void {
		observation = this.redact(observation);

		const key = keyOf(observation);
		const ring = (this.store.get(key) ?? []) as Observation[];

		ring.push(observation);

		if (ring.length > this.maxPerEndpoint) {
			ring.splice(0, ring.length - this.maxPerEndpoint);
		}

		this.store.set(key, ring);
	}

	/** Every retained observation across all endpoints (already redacted) — the input to accumulate(). */
	public all(): Observation[] {
		return [...this.store.values()].flat() as Observation[];
	}
}
