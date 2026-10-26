/**
 * silo — the feature manifest (pure, zero-dep): every feature of a program, by area and name, what it does in a
 * sentence, and what it is — the ways in it owns (features.ts' keys: `command|notes.add`) and the files that are its own
 * when no way in leads to them (an HTTP route, a library's export, a link's hash). Kept in `.silo/manifest.json`.
 *
 * Written by people or an agent, for now (silo README, *The feature manifest*): `features` finds the ways in, and
 * nothing yet says what they add up to. The manifest is that answer, kept honest by its checks, and the one a
 * derivation from the code alone has to reach — the measure of one, until it can take the manifest's place.
 *
 * Its checks, each a drift (./ledger) with both ways out:
 *   unplaced way in    a way in no feature owns: new code, or one missed
 *   gone way in        a feature owns a key that isn't found: the code went, moved or was renamed
 *   placed twice       a key two features own
 *   missing path       a feature's path that isn't there
 *   empty feature      one that owns no way in and no path: nothing says what it is
 * A repository without a manifest has none of them.
 */

import type { Drift, FoundWay } from "./ledger";
import { isEntry } from "@brianjenkins94/util/env";

/** One feature. */
export interface ManifestFeature {
	"what": string;
	"ways"?: string[];
	"paths"?: string[];
	/** Where it's told: a doc and its section (`packages/editor/RUNNING.md, *Rules*`). */
	"docs"?: string;
}

/** The manifest: each area's features, by name. */
export type Manifest = Record<string, Record<string, ManifestFeature>>;

/** The manifest in `text`; undefined when it isn't one (not JSON, or not areas of features). */
export function parseManifest(text: string): Manifest | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

		return isObject(parsed) && Object.values(parsed).every((area) => isObject(area) && Object.values(area).every((feature) => isObject(feature) && typeof feature["what"] === "string")) ? parsed as Manifest : undefined;
	} catch {
		return undefined;
	}
}

/** The manifest as it's written: areas and their features in the order given, each field in one order, its ways and
 *  paths sorted — so placing a way in touches one line. */
export function manifestText(manifest: Manifest): string {
	const order: (keyof ManifestFeature)[] = ["what", "docs", "ways", "paths"];
	const written = Object.fromEntries(Object.entries(manifest).map(([area, features]) => [area, Object.fromEntries(Object.entries(features).map(([name, feature]) => [name, Object.fromEntries(order.flatMap((field) => (feature[field] === undefined ? [] : [[field, Array.isArray(feature[field]) ? (feature[field] as string[]).toSorted() : feature[field]]])))]))]));

	return JSON.stringify(written, undefined, 2) + "\n";
}

/** Each feature with its area: `[area, name, feature]`. */
export function featuresOfManifest(manifest: Manifest): [string, string, ManifestFeature][] {
	return Object.entries(manifest).flatMap(([area, features]) => Object.entries(features).map(([name, feature]): [string, string, ManifestFeature] => [area, name, feature]));
}

/** The manifest's drift from the code: features first, in the manifest's order, then the ways in no feature owns, by key. */
export function manifestDrift(manifest: Manifest, facts: { "ways": FoundWay[]; "exists": (path: string) => boolean }): Drift[] {
	const found: Drift[] = [];
	const keys = new Set(facts.ways.map((way) => way.key));
	const owners = new Map<string, string[]>();

	for (const [area, name, feature] of featuresOfManifest(manifest)) {
		const where = `"${name}" (${area})`;

		for (const key of feature.ways ?? []) {
			owners.set(key, [...owners.get(key) ?? [], where]);

			if (!keys.has(key)) {
				found.push({ "check": "gone way in", "entry": name, "message": `${where} owns ${key}, and no way in has that key`, "code": "nothing: it went, moved or was renamed", "decision": "take it out of the feature, or put the key it has now" });
			}
		}

		for (const path of feature.paths ?? []) {
			if (!facts.exists(path)) {
				found.push({ "check": "missing path", "entry": name, "message": `${where} names ${path}, and it isn't there`, "code": "nothing: it went or moved", "decision": "take it out of the feature, or name where it is now" });
			}
		}

		if ((feature.ways ?? []).length === 0 && (feature.paths ?? []).length === 0) {
			found.push({ "check": "empty feature", "entry": name, "message": `${where} owns no way in and no path`, "code": "nothing", "decision": "give it its ways in or its own files, or take it out" });
		}
	}

	for (const [key, those] of owners) {
		if (those.length > 1) {
			found.push({ "check": "placed twice", "message": `${key} is owned by ${those.join(" and ")}`, "code": "nothing", "decision": "keep it in the one it serves" });
		}
	}

	for (const way of facts.ways.toSorted((left, right) => left.key.localeCompare(right.key))) {
		if (!owners.has(way.key)) {
			found.push({ "check": "unplaced way in", "message": `${way.facet} ${way.id || way.key} is in no feature of the manifest (key ${way.key})`, "code": "take it out, if nothing needs it", "decision": "put its key in the feature it serves (.silo/manifest.json), or in a new one" });
		}
	}

	return found;
}

/** The manifest in `text` with a removal taken out (./ledger `removalOf`): the `keys` it took, the `paths` it deleted (and
 *  any inside them), and a feature it left owning nothing; undefined when it named none of them, or isn't a manifest. */
export function manifestWithout(text: string, keys: string[], paths: string[]): string | undefined {
	const manifest = parseManifest(text);

	if (manifest === undefined) {
		return undefined;
	}

	const gone = (path: string): boolean => paths.some((each) => path === each || path.startsWith(each.replace(/\/+$/u, "") + "/"));
	let changed = false;
	const kept = Object.fromEntries(Object.entries(manifest).map(([area, features]) => [area, Object.fromEntries(Object.entries(features).flatMap(([name, feature]) => {
		const ways = (feature.ways ?? []).filter((key) => !keys.includes(key));
		const owned = (feature.paths ?? []).filter((path) => !gone(path));

		if (ways.length === (feature.ways ?? []).length && owned.length === (feature.paths ?? []).length) {
			return [[name, feature]];
		}

		changed = true;

		return ways.length === 0 && owned.length === 0 ? [] : [[name, { ...feature, ...feature.ways === undefined ? {} : { "ways": ways }, ...feature.paths === undefined ? {} : { "paths": owned } }]];
	}))]).filter(([, features]) => Object.keys(features).length > 0));

	return changed ? manifestText(kept) : undefined;
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
		const ways: FoundWay[] = [
			{ "key": "command|notes.add", "facet": "command", "id": "notes.add", "sides": ["declared", "registered"] },
			{ "key": "hub request|git.commit", "facet": "hub request", "id": "git.commit", "sides": [] },
			{ "key": "command|fresh", "facet": "command", "id": "fresh", "sides": ["registered"] }
		];
		const manifest: Manifest = {
			"Notes": { "Notes on code": { "what": "Notes that stay on the code they're about.", "ways": ["command|notes.add", "command|notes.gone"] } },
			"Source control": {
				"Commit": { "what": "Commit from the editor.", "ways": ["hub request|git.commit"], "paths": ["src/git"] },
				"Push": { "what": "Push.", "ways": ["hub request|git.commit"], "paths": ["src/push.ts"] },
				"Pull": { "what": "Pull." }
			}
		};
		const exists = (path: string): boolean => path === "src/git";

		assert.deepEqual(manifestDrift(manifest, { "ways": ways, "exists": exists }).map((each) => [each.check, each.entry ?? each.message]), [
			["gone way in", "Notes on code"],
			["missing path", "Push"],
			["empty feature", "Pull"],
			["placed twice", "hub request|git.commit is owned by \"Commit\" (Source control) and \"Push\" (Source control)"],
			["unplaced way in", "command fresh is in no feature of the manifest (key command|fresh)"]
		]);
		// Placed, the way in is quiet; a manifest that agrees has no drift.
		assert.deepEqual(manifestDrift({ "Notes": { "Notes on code": { "what": "Notes.", "ways": ["command|notes.add", "command|fresh", "hub request|git.commit"] } } }, { "ways": ways, "exists": exists }), []);
		// Written: fields in one order, ways and paths sorted, areas and features as given.
		const written = manifestText({ "B": { "z": { "ways": ["b", "a"], "what": "Z." } }, "A": { "y": { "what": "Y.", "paths": ["q", "p"], "docs": "R.md" } } });

		assert.equal(written, JSON.stringify({ "B": { "z": { "what": "Z.", "ways": ["a", "b"] } }, "A": { "y": { "what": "Y.", "docs": "R.md", "paths": ["p", "q"] } } }, undefined, 2) + "\n");
		assert.deepEqual(parseManifest(written), JSON.parse(written));
		assert.equal(parseManifest("not json"), undefined);
		assert.equal(parseManifest(JSON.stringify({ "A": { "y": { "ways": [] } } })), undefined);
		// A removal: its key out of its feature, its files out of their feature, a feature left with nothing gone too.
		const before = manifestText({ "A": { "x": { "what": "X.", "ways": ["view|a.monitor", "command|a.open"] }, "y": { "what": "Y.", "ways": ["view|a.only"], "paths": ["src/y.ts"] } }, "B": { "z": { "what": "Z.", "paths": ["src/z"] } } });

		assert.deepEqual(JSON.parse(manifestWithout(before, ["view|a.monitor", "view|a.only"], ["src/y.ts", "src/z/index.ts"]) ?? "{}"), { "A": { "x": { "what": "X.", "ways": ["command|a.open"] } }, "B": { "z": { "what": "Z.", "paths": ["src/z"] } } });
		assert.equal(manifestWithout(before, ["view|elsewhere"], ["src/other.ts"]), undefined);
	})();
}
