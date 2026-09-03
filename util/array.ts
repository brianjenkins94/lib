export function partition(array: (() => Promise<any>)[], callback) {
	return array.reduce(function(result, element, index) {
		if (callback(element, index, array)) {
			result[0].push(element);
		} else {
			result[1].push(element);
		}

		return result;
	}, [[], []]);
}

/**
 * `Promise.all(array.map(callback))`, with two extras: a `filter` over the settled results, and a
 * `concurrency` cap — at most that many callbacks in flight, fed from a shared cursor in array order (the
 * bounded worker-pool shape every "fetch N pages / days at a time" script otherwise hand-rolls). The third
 * argument is the filter function (legacy) or an options object.
 */
export async function mapAsync(array, callback: (value, index?, array?) => any = (promise) => promise(), options?: ((value) => boolean) | { "filter"?: (value) => boolean; "concurrency"?: number }) {
	const { filter, concurrency } = typeof options === "function" ? { "filter": options, "concurrency": undefined } : options ?? {};

	let results;

	if (concurrency === undefined || concurrency >= array.length) {
		results = await Promise.all(array.map(callback));
	} else {
		results = new Array(array.length);

		let next = 0;

		await Promise.all(Array.from({ "length": concurrency }, async function() {
			while (next < array.length) {
				const index = next;

				next += 1;
				results[index] = await callback(array[index], index, array);
			}
		}));
	}

	return filter === undefined ? results : results.filter(filter);
}

export async function filterAsync(array: (() => Promise<any>)[], callback) {
	const results = await mapAsync(array, function(element) {
		return callback(element);
	});

	return array.filter(function(_, index) {
		return results[index];
	});
}

export function series(promises: (() => Promise<any>)[]) {
	return promises.reduce(function(previous, next) {
		return previous.then(next);
	}, Promise.resolve());
}

export function mapSeries(array, callback?) {
	return array.reduce(async function(previous, next) {
		return [...(await previous), await (callback !== undefined ? callback(next) : next)];
	}, Promise.resolve([]));
}

export function reduceAsync(promises: ((...args: any[]) => Promise<unknown>)[], initial?) {
	return promises.reduce(async function(previous, next) {
		return next(await previous);
	}, Promise.resolve(initial));
}

async function mapEntriesAsync(object, callback, filter?) {
	const entries = Array.isArray(object) ? object : Object.entries(object);

	return Object.fromEntries(await mapAsync(entries, callback, filter));
}

export function mapEntries(object: [string, any][] | object, callback: () => [string, any], filter?) {
	if (callback.constructor.name === "AsyncFunction") {
		return mapEntriesAsync(object, callback, filter);
	}

	let entries = (Array.isArray(object) ? object : Object.entries(object)).map(callback);

	if (filter !== undefined) {
		entries = entries.filter(filter);
	}

	return Object.fromEntries<[string, any][]>(entries);
}
