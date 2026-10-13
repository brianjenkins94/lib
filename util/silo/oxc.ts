/**
 * silo — oxc's analyzer (pure, browser-portable): a snapshot's ways in (`./features`) and declaration graph (`./graph`)
 * from oxc's parse of each file version, cached by content. The default `./history` replays with; TypeScript's read the
 * same over the compiler's own tree (`./ts-analysis`).
 */

import type { WayIn } from "./features";
import type { Analyzer, FileGraph, Package } from "./graph";
import { waysIn } from "./features";
import { fileGraph, packageOf, ProgramGraph } from "./graph";

/** oxc's analyzer: each file version parsed once (its ways in and `fileGraph`, cached by content id), names resolved by
 *  `ProgramGraph`. */
export function oxcAnalyzer(): Analyzer {
	const cache = new Map<string, FileGraph | Package | null>();
	const waysCache = new Map<string, WayIn[]>();

	return {
		"analyze": async (files, read) => {
			const graphs = new Map<string, FileGraph>();
			const packages: Package[] = [];
			const ways = new Map<string, WayIn[]>();

			for (const [path, oid] of files) {
				// By path too: a way's roots name its file, so the same text moved is different ways.
				const key = oid + ":" + path;
				let found = waysCache.get(key);

				if (found === undefined) {
					found = waysIn(path, await read(oid));
					waysCache.set(key, found);
				}

				ways.set(path, found);
			}

			for (const [path, oid] of files) {
				const manifest = /(^|\/)package\.json$/u.test(path);

				if (!manifest && !/\.[cm]?[jt]sx?$/u.test(path)) {
					continue;
				}

				// A manifest's package names its folder, so the same text in two places is two packages.
				const key = manifest ? oid + ":" + path : oid;
				let found = cache.get(key);

				if (found === undefined) {
					const text = await read(oid);

					try {
						found = (manifest ? packageOf(path, text) : fileGraph(path, text)) ?? null;
					} catch {
						found = null; // doesn't parse: no declarations
					}

					cache.set(key, found);
				}

				if (found !== null && manifest) {
					packages.push(found as Package);
				} else if (found !== null) {
					graphs.set(path, found as FileGraph);
				}
			}

			return { "graph": new ProgramGraph(graphs, packages), "ways": ways };
		}
	};
}
