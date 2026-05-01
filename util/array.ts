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

export async function mapAsync(array, callback = (promise) => promise(), filter?) {
	if (filter !== undefined) {
		return (await Promise.all(array.map(callback))).filter(filter);
	} else {
		return Promise.all(array.map(callback));
	}
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

export function mapSeries(array: (() => Promise<any>)[], callback?) {
	return array.reduce(async function(previous, next) {
		return [...(await previous), await (callback !== undefined ? callback(await next()) : next())];
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
