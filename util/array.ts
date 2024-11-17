export function partition(promises: (() => Promise<any>)[], callback) {
	return promises.reduce(function(result, element, index) {
		if (callback(element, index, promises)) {
			result[0].push(element);
		} else {
			result[1].push(element);
		}

		return result;
	}, [[], []]);
}

export function mapAsync(array, callback) {
	return Promise.all(array.map(callback));
}

export async function filterAsync(promises: (() => Promise<any>)[], callback) {
	const results = await mapAsync(promises, function(element) {
		return callback(element);
	});

	return promises.filter(function(_, index) {
		return results[index];
	});
}

export function series(promises: (() => Promise<any>)[]) {
	return promises.reduce(function(previous, next) {
		return previous.then(next);
	}, Promise.resolve());
}

export function reduceAsync(promises: ((...args: any[]) => Promise<unknown>)[], initial?) {
	return promises.reduce(async function(previous, next) {
		return next(await previous);
	}, Promise.resolve(initial));
}

async function mapEntriesAsync(object, callback, filter?) {
	if (filter !== undefined) {
		return Object.fromEntries((await mapAsync(Array.isArray(object) ? object : Object.entries(object), callback)).filter(filter));
	} else {
		return Object.fromEntries(await mapAsync(Array.isArray(object) ? object : Object.entries(object), callback));
	}
}

export function mapEntries(object: [string, any][] | object, callback, filter?) {
	if (callback.constructor.name === "AsyncFunction") {
		return mapEntriesAsync(object, callback, filter);
	}

	if (filter !== undefined) {
		return Object.fromEntries<[string, any][]>((Array.isArray(object) ? object : Object.entries(object)).map(callback).filter(filter));
	} else {
		return Object.fromEntries<[string, any][]>((Array.isArray(object) ? object : Object.entries(object)).map(callback));
	}
}
