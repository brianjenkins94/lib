import { isEntry } from "@brianjenkins94/util/env";

interface CloneDeepOptions {
	/** Deep-clone built-in objects (Date, RegExp, Map, Set, ArrayBuffer, TypedArray/DataView) instead of passing them by reference (default: false). */
	"builtins"?: boolean;
	/** Track visited references with a WeakMap so cyclic structures clone instead of overflowing the stack (default: false). */
	"circular"?: boolean;
	/** Escape hatch: called for every value; return a clone to use it, or `undefined` to fall through to the default handling. */
	"customizer"?: (value: any, key?: string | symbol) => any;
	/** Stop recursing past this depth, returning an empty container in place of deeper structure (default: Infinity). */
	"maxDepth"?: number;
	/** Clone class instances as their own class (via the prototype) rather than as plain objects (default: false). */
	"prototype"?: boolean;
	/** Copy enumerable symbol-keyed properties as well as string-keyed ones (default: false). */
	"symbols"?: boolean;
	/** Schema-extraction mode: return arrays of keys in place of objects (default: false). */
	"keysOnly"?: boolean;
	/** Schema-extraction mode: return types in place of primitives (default: false). */
	"typesOnly"?: boolean;
}

interface MergeDeepOptions {
	"treatObjectsAsNamedArrays"?: boolean;
}

/**
 * Whether a value is a "plain" object — a direct instance of Object or a null-prototype object —
 * as opposed to an array, a class instance, or a built-in like Date/Map.
 */
function isPlainObject(value): boolean {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);

	return prototype === null || prototype === Object.prototype;
}

/**
 * Recursively clones a value.
 *
 * The core is intentionally minimal: plain objects and arrays are deep-cloned, primitives are copied
 * by value, and everything else (Date, Map, Set, class instances, functions, ...) is passed through
 * **by reference** — never mangled. Opt into more via options:
 *
 * - `builtins` - deep-clone Date, RegExp, Map, Set, ArrayBuffer, TypedArray/DataView
 * - `circular` - handle cyclic references (adds a WeakMap; off by default for speed)
 * - `prototype` - clone class instances as their own class rather than as plain objects
 * - `symbols` - copy enumerable symbol-keyed properties
 * - `customizer(value, key)` - return a clone for any value, or `undefined` to fall through
 * - `maxDepth` - stop recursing past a depth, returning an empty container
 *
 * `keysOnly` and `typesOnly` are schema-extraction modes that reshape the output rather than clone
 * it: `keysOnly` returns nested arrays of an object's keys, `typesOnly` replaces primitives with
 * their `typeof`. They run through the same traversal as the clone and honor `customizer`,
 * `maxDepth`, and `circular`.
 *
 * @param object - The value to clone
 * @param options - See above
 *
 * @returns The cloned or extracted value
 */
export function cloneDeep(object, options: CloneDeepOptions = {}): any {
	const maxDepth = options["maxDepth"] ?? Infinity;
	const typesOnly = options["typesOnly"] === true;
	// typesOnly takes precedence over keysOnly, matching the original.
	const keysOnly = typesOnly === false && options["keysOnly"] === true;
	const seen: WeakMap<object, any> | undefined = options["circular"] === true ? new WeakMap() : undefined;

	// eslint-disable-next-line complexity
	return (function recurse(value, key: string | symbol | undefined, depth: number) {
		// Escape hatch, honored in every mode.
		if (options["customizer"] !== undefined) {
			const result = options["customizer"](value, key);

			if (result !== undefined) {
				return result;
			}
		}

		// Depth ceiling: collapse to an empty container (or null for a primitive), mode-independent.
		if (depth >= maxDepth) {
			if (Array.isArray(value)) {
				return [];
			} else if (typeof value === "object" && value !== null) {
				return {};
			} else {
				return null;
			}
		}

		// Schema-extraction: nested arrays of keys.
		if (keysOnly === true) {
			const keys = [];

			if (value === null || typeof value !== "object") {
				return keys;
			}

			for (const [entryKey, entryValue] of Object.entries(value)) {
				if (Array.isArray(entryValue)) {
					const named = {};

					// XXX: This assumes arrays do not contain mixed data.
					if (typeof entryValue[0] === "object") {
						for (const element of entryValue) {
							named[entryKey] = mergeDeep([named[entryKey], recurse(element, entryKey, depth + 1)], { "treatObjectsAsNamedArrays": true });
						}
					} else {
						named[entryKey] = [];
					}

					keys.push(named);
				} else if (typeof entryValue === "object" && entryValue !== null) {
					const named = {};

					named[entryKey] = recurse(entryValue, entryKey, depth + 1);

					keys.push(named);
				} else {
					keys.push(entryKey);
				}
			}

			return keys;
		}

		// Schema-extraction: primitives replaced by their `typeof`.
		if (typesOnly === true) {
			const types = {};

			if (value === null || typeof value !== "object") {
				return types;
			}

			for (const [entryKey, entryValue] of Object.entries(value)) {
				if (Array.isArray(entryValue)) {
					for (const element of entryValue) {
						if (typeof element === "object" && element !== null) {
							types[entryKey] = recurse(element, entryKey, depth + 1);
						}
					}
				} else if (typeof entryValue === "object" && entryValue !== null) {
					types[entryKey] = recurse(entryValue, entryKey, depth + 1);
				} else if (entryValue !== null) {
					types[entryKey] = typeof entryValue;
				}
			}

			return types;
		}

		// Clone: primitives copied by value; functions passed by reference.
		if (value === null || (typeof value !== "object" && typeof value !== "function")) {
			return value;
		}

		if (typeof value === "function") {
			return value;
		}

		if (seen !== undefined && seen.has(value)) {
			return seen.get(value);
		}

		if (options["builtins"] === true) {
			if (value instanceof Date) {
				return new Date(value.getTime());
			}

			if (value instanceof RegExp) {
				const clone = new RegExp(value.source, value.flags);

				clone.lastIndex = value.lastIndex;

				return clone;
			}

			if (value instanceof ArrayBuffer) {
				return value.slice(0);
			}

			if (ArrayBuffer.isView(value)) {
				if (value instanceof DataView) {
					return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
				}

				return new (value.constructor as any)(value);
			}

			if (value instanceof Map) {
				const clone = new Map();

				if (seen !== undefined) {
					seen.set(value, clone);
				}

				for (const [entryKey, entryValue] of value) {
					clone.set(recurse(entryKey, undefined, depth + 1), recurse(entryValue, undefined, depth + 1));
				}

				return clone;
			}

			if (value instanceof Set) {
				const clone = new Set();

				if (seen !== undefined) {
					seen.set(value, clone);
				}

				for (const entryValue of value) {
					clone.add(recurse(entryValue, undefined, depth + 1));
				}

				return clone;
			}
		}

		const isArray = Array.isArray(value);
		const plain = isArray || isPlainObject(value);

		// Not a container we deep-clone: pass by reference unless prototype-cloning is requested.
		if (plain === false && options["prototype"] !== true) {
			return value;
		}

		const clone: any = isArray ? [] : options["prototype"] === true ? Object.create(Object.getPrototypeOf(value)) : {};

		if (seen !== undefined) {
			seen.set(value, clone);
		}

		for (const [entryKey, entryValue] of Object.entries(value)) {
			clone[entryKey] = recurse(entryValue, entryKey, depth + 1);
		}

		if (options["symbols"] === true) {
			for (const symbol of Object.getOwnPropertySymbols(value)) {
				if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
					clone[symbol] = recurse(value[symbol], symbol, depth + 1);
				}
			}
		}

		return clone;
	})(object, undefined, 0);
}

/**
 * Recursively merges arguments.
 *
 * Merges plain objects recursively: nested objects merge, arrays are replaced (deep-cloned, not
 * merged element-wise), and scalars overwrite. e.g. `mergeDeep([{}, { tags: ["a", "b"] }])`
 * returns `{ tags: ["a", "b"] }`.
 *
 * NOTE: when the top-level arguments are themselves arrays, they are treated as the internal
 * "named-array" representation used by `cloneDeep(..., { keysOnly: true })` rather than as plain
 * arrays — that path is specialized for schema extraction, not general array merging.
 *
 * @param args - Either an array of arrays or an array of objects to merge
 * @param options
 * @param options.treatObjectsAsNamedArrays - Whether to treat objects as named arrays (default: false)
 *
 * @returns The merged object
 */
export function mergeDeep(args, options: MergeDeepOptions = {}): any {
	options["treatObjectsAsNamedArrays"] ??= false;

	function objectify(array) {
		return (function recurse(object) {
			const clone = {};

			for (const element of object) {
				if (Array.isArray(element)) {
					throw new TypeError("This should never happen. / Not yet implemented?");
				} else if (typeof element === "object" && element !== null) {
					const [key] = Object.keys(element);

					if (options["treatObjectsAsNamedArrays"] === true) {
						clone[key] = recurse(element[key]);
					} else {
						throw new Error("Not yet implemented.");
					}
				} else {
					clone[element as string] = "";
				}
			}

			return clone;
		})(array);
	}

	function merge(target, source) {
		if (target === undefined) {
			target = Array.isArray(source) ? [] : {};
		}

		for (const [key, value] of Object.entries(source)) {
			if (Array.isArray(value)) {
				// Arrays are replaced (deep-cloned), not merged element-wise. The original instead
				// re-looped the whole source here and rebuilt the value as a "named array" object,
				// which mangled ordinary array properties (e.g. ["a","b"] -> { "0": ["a"] }). This
				// branch is never reached by the keysOnly path (objectify feeds merge() only
				// strings/objects), so correcting it does not affect schema extraction.
				target[key] = cloneDeep(value);
			} else if (typeof value === "object" && value !== null) {
				target[key] = merge(target[key], value);
			} else {
				target[key] = value;
			}
		}

		return target;
	}

	return args.reduce(function(previous, current) {
		if (previous === undefined) {
			previous = Array.isArray(current) ? [] : {};
		}

		if (Array.isArray(previous) && Array.isArray(current)) {
			previous = cloneDeep(mergeDeep([objectify(previous), objectify(current)]), { "keysOnly": true });
		} else {
			merge(previous, current);
		}

		return previous;
	});
}

/**
 * Gets the value of the given object at a path, asserting every segment exists.
 *
 * Checks own-property membership at each step, so it distinguishes an absent key from a key whose
 * value is `undefined`, and throws a `TypeError` naming the first segment that is missing. An empty
 * path returns the object itself.
 *
 * @param object - The object to traverse
 * @param path - An array of keys
 *
 * @returns The value of the object at the path
 * @throws {TypeError} If a segment along the path is absent
 */
export function getKeyOfObjectByPath(object, path: (string | number)[]): any {
	return path.reduce(function(node, key) {
		if (node === null || node === undefined || Object.prototype.hasOwnProperty.call(node, key) === false) {
			throw new TypeError("cannot read '" + key + "' of " + JSON.stringify(node));
		}

		return node[key];
	}, object);
}

/**
 * Gets or creates the value of the given object at a path, filling in missing intermediate objects.
 *
 * @param object - The object to traverse
 * @param path - An array of keys
 *
 * @returns The value of the object at the path
 */
export function getOrCreateKeyOfObjectByPath(object, path: (string | number)[]): any {
	return path.reduce(function(node, key) {
		node[key] ??= {};

		return node[key];
	}, object);
}

if (isEntry(import.meta)) {
	void (async function() {
		const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

		// --- cloneDeep: core ---

		// deep clone by value
		const original = { "a": 1, "b": { "c": [1, 2, 3] } };
		const clone = cloneDeep(original);

		assert.deepEqual(clone, original);
		assert.notEqual(clone.b, original.b);

		// core passes non-plain objects by reference (no Date -> {} mangling)
		const date = new Date();

		assert.equal(cloneDeep({ "date": date }).date, date);

		// core passes functions and class instances by reference
		class Point {
			public x = 1;
		}
		const point = new Point();

		assert.equal(cloneDeep({ "point": point }).point, point);

		// maxDepth
		assert.deepEqual(cloneDeep({ "a": { "b": { "c": 1 } } }, { "maxDepth": 1 }), { "a": {} });

		// --- cloneDeep: opt-in built-ins ---
		const builtinsClone = cloneDeep({ "date": date, "set": new Set([1, 2]), "map": new Map([["k", 1]]), "typed": new Uint8Array([1, 2, 3]), "re": /x/gi }, { "builtins": true });

		assert.notEqual(builtinsClone.date, date);
		assert.equal(Number(builtinsClone.date), Number(date));
		assert.deepEqual([...builtinsClone.set], [1, 2]);
		assert.deepEqual([...builtinsClone.map], [["k", 1]]);
		assert.deepEqual([...builtinsClone.typed], [1, 2, 3]);
		assert.equal(builtinsClone.re.flags, "gi");

		// --- cloneDeep: opt-in circular ---
		const cyclic: any = { "name": "root" };

		cyclic.self = cyclic;
		const cyclicClone = cloneDeep(cyclic, { "circular": true });

		assert.equal(cyclicClone.self, cyclicClone);
		assert.notEqual(cyclicClone, cyclic);

		// --- cloneDeep: opt-in customizer ---
		assert.equal(cloneDeep({ "n": 5 }, { "customizer": (value) => (typeof value === "number" ? value * 2 : undefined) }).n, 10);

		// --- cloneDeep: opt-in prototype ---
		const typedClone = cloneDeep(point, { "prototype": true });

		assert.ok(typedClone instanceof Point);
		assert.notEqual(typedClone, point);
		assert.equal(typedClone.x, 1);

		// --- cloneDeep: opt-in symbols ---
		const symbol = Symbol("s");

		assert.equal(cloneDeep({ [symbol]: 1 })[symbol], undefined);
		assert.equal(cloneDeep({ [symbol]: 1 }, { "symbols": true })[symbol], 1);

		// --- cloneDeep: schema modes still bit-compatible ---
		assert.deepEqual(cloneDeep({ "gid": "x", "req": { "version": 1 } }, { "keysOnly": true }), ["gid", { "req": ["version"] }]);
		assert.deepEqual(cloneDeep({ "gid": "x", "pid": 1 }, { "typesOnly": true }), { "gid": "string", "pid": "number" });
		// exercises mergeDeep's array branch (guards keysOnly against the merge fixes)
		assert.deepEqual(cloneDeep({ "items": [{ "a": 1 }, { "b": 2 }] }, { "keysOnly": true }), [{ "items": ["a", "b"] }]);
		assert.deepEqual(cloneDeep({ "a": { "b": [{ "c": 1 }] } }, { "keysOnly": true }), [{ "a": [{ "b": ["c"] }] }]);
		assert.deepEqual(cloneDeep({ "logs": [{ "x": 1 }, { "x": 2, "y": 3 }] }, { "keysOnly": true }), [{ "logs": ["x", "y"] }]);
		assert.deepEqual(cloneDeep({ "gid": "x", "req": { "version": 1 }, "arr": [{ "p": 1 }] }, { "keysOnly": true }), ["gid", { "req": ["version"] }, { "arr": ["p"] }]);

		// --- mergeDeep ---
		assert.deepEqual(mergeDeep([{ "a": 1 }, { "b": 2 }]), { "a": 1, "b": 2 });
		assert.deepEqual(mergeDeep([["a"], ["b"]]), ["a", "b"]);
		// ordinary array-valued properties are no longer mangled
		assert.deepEqual(mergeDeep([{}, { "tags": ["a", "b"] }]), { "tags": ["a", "b"] });
		// nested objects merge, arrays replace
		assert.deepEqual(mergeDeep([{ "a": { "x": 1 }, "list": [1, 2] }, { "a": { "y": 2 }, "list": [3] }]), { "a": { "x": 1, "y": 2 }, "list": [3] });

		// --- getKeyOfObjectByPath: hit, throws on absent segment, empty path returns root ---
		const tree = { "a": { "b": { "c": 42 } } };

		assert.equal(getKeyOfObjectByPath(tree, ["a", "b", "c"]), 42);
		assert.throws(() => getKeyOfObjectByPath(tree, ["a", "x", "y"]), TypeError);
		assert.equal(getKeyOfObjectByPath(tree, []), tree);
		// distinguishes present-but-undefined from absent
		assert.equal(getKeyOfObjectByPath({ "k": undefined }, ["k"]), undefined);
		assert.throws(() => getKeyOfObjectByPath({ "k": undefined }, ["missing"]), TypeError);

		// --- getOrCreateKeyOfObjectByPath: creates missing intermediates ---
		const target = {};

		getOrCreateKeyOfObjectByPath(target, ["x", "y"])["z"] = 1;
		assert.deepEqual(target, { "x": { "y": { "z": 1 } } });

		console.log("object.ts: all assertions passed.");
	})();
}
